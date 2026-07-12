const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { SessionStore } = require('./session-store.cjs');
const { renderStandalone } = require('./standalone.cjs');
const { normalizeVisualDocument } = require('./visual-document.cjs');

const COOKIE_NAME = 'brainstorm_session';
const MAX_REQUEST_BYTES = 64 * 1024;
const SHELL_DIR = path.resolve(__dirname, '../assets/visual-shell');
const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};
const WAITING_DOCUMENT = normalizeVisualDocument({
  profile: 'technical',
  audience: 'Brainstorming participants',
  title: 'Visual session ready',
  summary: 'Waiting for the agent to publish screen.json.',
  sections: [{
    kind: 'callout',
    id: 'waiting-for-screen',
    title: 'No visual published yet',
    body: 'Return to the agent after it publishes the first visual document.',
    tone: 'accent',
  }],
});

function constantTimeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function cookieValue(request, name) {
  for (const cookie of String(request.headers.cookie || '').split(';')) {
    const separator = cookie.indexOf('=');
    if (separator < 0 || cookie.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(cookie.slice(separator + 1).trim());
    } catch {
      return '';
    }
  }
  return '';
}

function isAuthorized(request, requestUrl, token) {
  return constantTimeEqual(requestUrl.searchParams.get('token'), token)
    || constantTimeEqual(cookieValue(request, COOKIE_NAME), token);
}

function sendJson(response, status, value, headers = {}) {
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    ...headers,
  });
  response.end(`${JSON.stringify(value)}\n`);
}

function sendText(response, status, value, contentType, headers = {}) {
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': contentType,
    ...headers,
  });
  response.end(value);
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    let settled = false;
    request.on('data', chunk => {
      if (settled) return;
      length += chunk.length;
      if (length > MAX_REQUEST_BYTES) {
        settled = true;
        reject(new RangeError('request body exceeds 64 KiB'));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (settled) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (error) {
        reject(new SyntaxError(`invalid JSON: ${error.message}`));
      }
    });
    request.on('error', reject);
  });
}

function sameOrigin(request) {
  if (!request.headers.origin) return true;
  try {
    return new URL(request.headers.origin).host === request.headers.host;
  } catch {
    return false;
  }
}

function createBrainstormServer(options = {}) {
  const host = options.host || '127.0.0.1';
  const port = options.port ?? 0;
  const urlHost = options.urlHost || (host === '127.0.0.1' ? 'localhost' : host);
  const loopbackHost = ['127.0.0.1', 'localhost', '::1'].includes(host);
  const allowInsecureRemote = options.allowInsecureRemote === true
    || process.env.BRAINSTORM_ALLOW_INSECURE_REMOTE === '1';
  if (!loopbackHost && !allowInsecureRemote) {
    throw new Error('refusing plaintext non-loopback visual session; use a trusted tunnel or explicitly accept the risk');
  }

  const sessionDir = path.resolve(options.sessionDir
    || process.env.BRAINSTORM_DIR
    || path.join(process.env.CLAUDE_SCRATCH_DIR || path.join(os.homedir(), '.claude-scratch'), 'brainstorm'));
  const contentDir = path.join(sessionDir, 'content');
  const stateDir = path.join(sessionDir, 'state');
  const screenPath = path.join(contentDir, 'screen.json');
  // Artifacts live in the working repo (<repo>/.artifacts/brainstorm/<session>) by default so
  // they are a normal, discoverable by-product of the session — not buried in scratch. The
  // rolling visual.html is refreshed on every screen and feedback change; the Save button pins
  // numbered snapshots the user chooses to keep. Falls back to sessionDir when no artifactDir
  // is supplied (in-process tests).
  const artifactDir = options.artifactDir ? path.resolve(options.artifactDir) : sessionDir;
  const exportPath = path.join(artifactDir, 'visual.html');
  const token = options.token || crypto.randomBytes(24).toString('hex');
  const sessionId = options.sessionId || crypto.randomBytes(12).toString('hex');
  const ownerPid = options.ownerPid ?? null;
  const idleTimeoutMs = options.idleTimeoutMs ?? 30 * 60 * 1_000;
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(sessionId)) throw new TypeError('sessionId must be a URL-safe identifier');

  const basePath = `/session/${sessionId}/`;
  fs.mkdirSync(contentDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  for (const directory of [sessionDir, contentDir, stateDir]) fs.chmodSync(directory, 0o700);

  const shell = fs.readFileSync(path.join(SHELL_DIR, 'index.html'), 'utf8');
  const shellScript = fs.readFileSync(path.join(SHELL_DIR, 'app.js'));
  const shellStyles = fs.readFileSync(path.join(SHELL_DIR, 'styles.css'));
  const store = new SessionStore(stateDir);
  const eventClients = new Set();
  const debounceTimers = new Map();
  let lastActivity = Date.now();
  let closing = false;

  function touchActivity() {
    lastActivity = Date.now();
  }

  function readScreen() {
    if (!fs.existsSync(screenPath)) return WAITING_DOCUMENT;
    return normalizeVisualDocument(JSON.parse(fs.readFileSync(screenPath, 'utf8')));
  }

  function shellHtml() {
    return shell.replace('__BRAINSTORM_BASE_PATH_ATTR__', basePath);
  }

  function ensureArtifactDir() {
    fs.mkdirSync(artifactDir, { recursive: true });
    // Keep the artifacts out of version control by default without touching the repo's root
    // .gitignore; the user can `git add -f` a snapshot they want to commit.
    const ignoreFile = path.join(artifactDir, '.gitignore');
    if (!fs.existsSync(ignoreFile)) fs.writeFileSync(ignoreFile, '*\n', { mode: 0o600 });
  }

  function renderCurrent() {
    return renderStandalone({
      shell,
      styles: shellStyles,
      script: shellScript,
      screen: readScreen(),
      session: store.snapshot(),
    });
  }

  function writeLiveExport() {
    try {
      ensureArtifactDir();
      fs.writeFileSync(exportPath, renderCurrent(), { mode: 0o600 });
    } catch (error) {
      // A write failure (or an invalid screen.json) must never break the live session; the
      // previous good artifact stays in place until the next successful refresh.
      console.error(`brainstorm live export failed: ${error.message}`);
    }
  }

  function saveSnapshot() {
    ensureArtifactDir();
    const existing = fs.readdirSync(artifactDir).filter(name => /^visual-\d+\.html$/.test(name)).length;
    const file = path.join(artifactDir, `visual-${String(existing + 1).padStart(3, '0')}.html`);
    fs.writeFileSync(file, renderCurrent(), { mode: 0o600 });
    return file;
  }

  function sendEvent(event, value = {}) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
    for (const response of eventClients) {
      try {
        response.write(payload);
      } catch {
        eventClients.delete(response);
      }
    }
  }

  async function handleRequest(request, response) {
    touchActivity();
    const requestUrl = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    if (!isAuthorized(request, requestUrl, token)) {
      sendJson(response, 401, { error: 'unauthorized visual session' });
      return;
    }
    if (!requestUrl.pathname.startsWith(basePath)) {
      sendJson(response, 404, { error: 'not found' });
      return;
    }

    const relativePath = requestUrl.pathname.slice(basePath.length);
    const cookieHeaders = requestUrl.searchParams.has('token')
      ? { 'Set-Cookie': `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=${basePath}` }
      : {};

    if (request.method === 'GET' && relativePath === '') {
      sendText(response, 200, shellHtml(), 'text/html; charset=utf-8', cookieHeaders);
      return;
    }
    if (request.method === 'GET' && relativePath === 'assets/app.js') {
      sendText(response, 200, shellScript, 'application/javascript; charset=utf-8', cookieHeaders);
      return;
    }
    if (request.method === 'GET' && relativePath === 'assets/styles.css') {
      sendText(response, 200, shellStyles, 'text/css; charset=utf-8', cookieHeaders);
      return;
    }
    if (request.method === 'GET' && relativePath === 'api/screen') {
      try {
        sendJson(response, 200, readScreen(), cookieHeaders);
      } catch (error) {
        sendJson(response, 422, { error: `invalid screen.json: ${error.message}` }, cookieHeaders);
      }
      return;
    }
    if (request.method === 'GET' && relativePath === 'api/session') {
      sendJson(response, 200, store.snapshot(), cookieHeaders);
      return;
    }
    if (request.method === 'GET' && relativePath === 'api/events') {
      response.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': 'text/event-stream; charset=utf-8',
        Connection: 'keep-alive',
        ...cookieHeaders,
      });
      response.write(': connected\n\n');
      eventClients.add(response);
      request.on('close', () => eventClients.delete(response));
      return;
    }
    if (request.method === 'POST' && relativePath === 'api/save') {
      if (!sameOrigin(request)) {
        sendJson(response, 403, { error: 'cross-origin save rejected' }, cookieHeaders);
        return;
      }
      try {
        const file = saveSnapshot();
        sendJson(response, 201, { saved: true, file: path.basename(file), path: file }, cookieHeaders);
      } catch (error) {
        sendJson(response, 500, { error: error.message }, cookieHeaders);
      }
      return;
    }
    if (request.method === 'POST' && relativePath === 'api/feedback') {
      if (!sameOrigin(request)) {
        sendJson(response, 403, { error: 'cross-origin feedback rejected' }, cookieHeaders);
        return;
      }
      try {
        const record = store.appendBrowserTurn(await readJsonBody(request));
        sendJson(response, 201, record, cookieHeaders);
        sendEvent('session', { seq: record.seq });
      } catch (error) {
        sendJson(response, error instanceof RangeError ? 413 : 400, { error: error.message }, cookieHeaders);
      }
      return;
    }
    sendJson(response, 404, { error: 'not found' }, cookieHeaders);
  }

  const server = http.createServer((request, response) => {
    handleRequest(request, response).catch(error => {
      console.error(`brainstorm request failed: ${error.message}`);
      if (!response.headersSent) sendJson(response, 500, { error: 'internal server error' });
      else response.end();
    });
  });

  const contentWatcher = fs.watch(contentDir, (_eventType, filename) => {
    // Some platforms report a null filename; fall through rather than miss the refresh.
    if (filename != null && String(filename) !== 'screen.json') return;
    if (debounceTimers.has('screen')) clearTimeout(debounceTimers.get('screen'));
    debounceTimers.set('screen', setTimeout(() => {
      debounceTimers.delete('screen');
      touchActivity();
      sendEvent('screen');
      writeLiveExport();
    }, 60));
  });
  contentWatcher.on('error', error => console.error(`brainstorm content watcher failed: ${error.message}`));

  const stateWatcher = fs.watch(stateDir, (_eventType, filename) => {
    if (filename != null && !['session.jsonl', 'agent-cursor.json'].includes(String(filename))) return;
    if (debounceTimers.has('session')) clearTimeout(debounceTimers.get('session'));
    debounceTimers.set('session', setTimeout(() => {
      debounceTimers.delete('session');
      sendEvent('session');
      writeLiveExport();
    }, 40));
  });
  stateWatcher.on('error', error => console.error(`brainstorm state watcher failed: ${error.message}`));

  function ownerAlive() {
    if (!ownerPid) return true;
    try {
      process.kill(ownerPid, 0);
      return true;
    } catch (error) {
      return error.code === 'EPERM';
    }
  }

  const lifecycleCheck = setInterval(() => {
    if (!ownerAlive()) close('owner process exited');
    // An open browser tab (live SSE connection) counts as presence: never time out a
    // user who is reviewing at their own pace. Owner-death monitoring handles orphans.
    else if (idleTimeoutMs > 0 && eventClients.size === 0 && Date.now() - lastActivity > idleTimeoutMs) {
      close('idle timeout');
    }
  }, Math.min(60_000, Math.max(1_000, Math.floor((idleTimeoutMs || 60_000) / 2))));
  lifecycleCheck.unref();

  function listen() {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        const actualPort = server.address().port;
        const displayHost = urlHost.includes(':') ? `[${urlHost}]` : urlHost;
        const url = `http://${displayHost}:${actualPort}`;
        const info = {
          type: 'server-started',
          port: actualPort,
          host,
          url_host: urlHost,
          url,
          base_path: basePath,
          connection_url: `${url}${basePath}?token=${encodeURIComponent(token)}`,
          screen_dir: contentDir,
          state_dir: stateDir,
          visual_file: exportPath,
        };
        const { connection_url: _connectionUrl, ...safeInfo } = info;
        fs.writeFileSync(path.join(stateDir, 'server-info'), `${JSON.stringify(safeInfo)}\n`, { mode: 0o600 });
        writeLiveExport();
        resolve(info);
      });
    });
  }

  function close(reason = 'closed') {
    if (closing) return Promise.resolve();
    closing = true;
    clearInterval(lifecycleCheck);
    for (const timer of debounceTimers.values()) clearTimeout(timer);
    contentWatcher.close();
    stateWatcher.close();
    for (const response of eventClients) response.end();
    eventClients.clear();
    const infoFile = path.join(stateDir, 'server-info');
    if (fs.existsSync(infoFile)) fs.rmSync(infoFile, { force: true });
    if (fs.existsSync(stateDir)) {
      fs.writeFileSync(path.join(stateDir, 'server-stopped'), `${JSON.stringify({ reason, timestamp: Date.now() })}\n`, { mode: 0o600 });
    }
    if (!server.listening) return Promise.resolve();
    return new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections?.();
    });
  }

  return { close, contentDir, listen, readScreen, screenPath, server, stateDir, store, token };
}

module.exports = { COOKIE_NAME, createBrainstormServer };
