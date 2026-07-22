const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { writeInterviewSidecars } = require('./interview-export.cjs');
const { SessionStore } = require('./session-store.cjs');
const { withVisualStateLock } = require('./legacy-visual-import.cjs');
const { renderStandalone } = require('./standalone.cjs');
const { normalizeVisualDocument } = require('./visual-document.cjs');
const {
  resolveReviewEvidence,
  resolveReviewSource,
} = require('./review-workspace-data.cjs');

const COOKIE_NAME = 'brainstorm_session';
const MAX_REQUEST_BYTES = 64 * 1024;
const DEFAULT_SSE_HEARTBEAT_MS = 15_000;
const MIN_SSE_HEARTBEAT_MS = 10;
const MAX_SSE_HEARTBEAT_MS = 60_000;
const REVIEW_SOURCE_ID_PATTERN = /^source-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EVIDENCE_RECORD_ID_PATTERN = /^EVD-[0-9]{3}-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHELL_DIR = path.resolve(__dirname, '../assets/visual-shell');
const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

function normalizeDocument(value) {
  if (value?.version !== 2) return normalizeVisualDocument(value);
  const { normalizeWorkspaceDocument } = require('./workspace-document.cjs');
  const { normalizeKnownWorkspaceContent } = require('./workspace-content.cjs');
  return normalizeWorkspaceDocument(value, {
    contentValidator: normalizeKnownWorkspaceContent,
  });
}

function readRegularJson(file, label) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error.code === 'ELOOP') throw new Error(`${label} must be a regular file and must not be a symlink`);
    throw new Error(`${label} could not be read`);
  }
  let contents;
  try {
    if (!fs.fstatSync(descriptor).isFile()) {
      throw new Error(`${label} must be a regular file and must not be a symlink`);
    }
    contents = fs.readFileSync(descriptor, 'utf8');
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    return JSON.parse(contents);
  } catch {
    throw new Error(`${label} contains invalid JSON`);
  }
}

function readVisualFormat(file) {
  const value = readRegularJson(file, 'visual format metadata');
  if (value == null) return null;
  if (value.version !== 1 || ![1, 2].includes(value.active_version)
    || value.v1_document !== 'content/screen.json'
    || value.v2_document !== 'content/workspace.json'
    || Object.keys(value).some(key => !['version', 'active_version', 'v1_document', 'v2_document'].includes(key))) {
    throw new Error('visual format metadata is malformed');
  }
  return value;
}

function readDeliveryState(file, durableSeq) {
  const value = readRegularJson(file, 'delivery state metadata');
  if (value == null) return { listening: false, deliveredThrough: 0 };
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.version !== 1
    || typeof value.listening !== 'boolean'
    || !Number.isInteger(value.deliveredThrough)
    || value.deliveredThrough < 0
    || value.deliveredThrough > (durableSeq ?? 0)
    || Object.keys(value).some(key => !['version', 'listening', 'deliveredThrough'].includes(key))) {
    throw new Error('delivery state metadata is malformed');
  }
  return { listening: value.listening, deliveredThrough: value.deliveredThrough };
}

function atomicWrite(file, contents, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, contents, { mode, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
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

function reviewQueryId(requestUrl, pattern) {
  const keys = [...new Set(requestUrl.searchParams.keys())];
  if (keys.some(key => !['id', 'token'].includes(key))) return null;
  if (requestUrl.searchParams.getAll('id').length !== 1
    || requestUrl.searchParams.getAll('token').length > 1) return null;
  const id = requestUrl.searchParams.get('id');
  return typeof id === 'string' && id.length <= 200 && pattern.test(id) ? id : null;
}

function reviewPathId(requestUrl, relativePath) {
  const prefix = 'api/review/evidence/';
  if (!relativePath.startsWith(prefix)) return null;
  const id = relativePath.slice(prefix.length);
  const keys = [...new Set(requestUrl.searchParams.keys())];
  if (keys.some(key => key !== 'token') || requestUrl.searchParams.getAll('token').length > 1) return '';
  return id.length <= 200 && EVIDENCE_RECORD_ID_PATTERN.test(id) ? id : '';
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
  const repositoryRoot = path.resolve(options.repositoryRoot || process.cwd());
  const contentDir = path.join(sessionDir, 'content');
  const stateDir = path.join(sessionDir, 'state');
  const screenPath = path.join(contentDir, 'screen.json');
  const workspacePath = path.join(contentDir, 'workspace.json');
  const formatPath = path.join(stateDir, 'visual-format.json');
  const deliveryStatePath = path.join(stateDir, 'delivery-state.json');
  const serverInfoPath = path.join(stateDir, 'server-info');
  const serverStoppedPath = path.join(stateDir, 'server-stopped');
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
  const sseHeartbeatMs = options.sseHeartbeatMs ?? DEFAULT_SSE_HEARTBEAT_MS;
  const sseSetInterval = options.sseSetInterval || setInterval;
  const sseClearInterval = options.sseClearInterval || clearInterval;
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(sessionId)) throw new TypeError('sessionId must be a URL-safe identifier');
  if (!Number.isInteger(sseHeartbeatMs)
    || sseHeartbeatMs < MIN_SSE_HEARTBEAT_MS
    || sseHeartbeatMs > MAX_SSE_HEARTBEAT_MS) {
    throw new TypeError(`sseHeartbeatMs must be an integer between ${MIN_SSE_HEARTBEAT_MS} and ${MAX_SSE_HEARTBEAT_MS}`);
  }
  if (typeof sseSetInterval !== 'function' || typeof sseClearInterval !== 'function') {
    throw new TypeError('SSE interval scheduler must provide set and clear functions');
  }

  const basePath = `/session/${sessionId}/`;
  fs.mkdirSync(contentDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  for (const directory of [sessionDir, contentDir, stateDir]) fs.chmodSync(directory, 0o700);

  const shell = fs.readFileSync(path.join(SHELL_DIR, 'index.html'), 'utf8');
  const shellScript = fs.readFileSync(path.join(SHELL_DIR, 'app.js'));
  const shellStyles = fs.readFileSync(path.join(SHELL_DIR, 'styles.css'));
  const shellWorker = fs.readFileSync(path.join(SHELL_DIR, 'elk-worker.min.js'));
  const store = new SessionStore(stateDir);
  const eventClients = new Set();
  const debounceTimers = new Map();
  let lastActivity = Date.now();
  let closing = false;

  function touchActivity() {
    lastActivity = Date.now();
  }

  function readScreen() {
    const format = readVisualFormat(formatPath);
    const activePath = format?.active_version === 2 ? workspacePath : screenPath;
    const value = readRegularJson(activePath, 'visual document');
    if (value == null && format != null) throw new Error('active Visual Document is unavailable');
    return value == null ? WAITING_DOCUMENT : normalizeDocument(value);
  }

  function readState() {
    return withVisualStateLock(sessionDir, () => store.withSnapshotLock(session => {
      const durableSeq = session.events
        .filter(event => event.type === 'user.turn')
        .at(-1)?.seq ?? null;
      const delivery = readDeliveryState(deliveryStatePath, durableSeq);
      return {
        screen: readScreen(),
        session,
        deliveryEvidence: {
          connection: 'open',
          listening: delivery.listening,
          durableSeq,
          deliveredThrough: delivery.deliveredThrough,
          acknowledgedThrough: Math.min(session.cursor, durableSeq ?? 0),
        },
      };
    }));
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

  function currentExportState() {
    return { screen: readScreen(), session: store.strictSnapshot() };
  }

  function renderCurrent(state) {
    const { screen, session } = state ?? currentExportState();
    return renderStandalone({
      shell,
      styles: shellStyles,
      script: shellScript,
      worker: shellWorker,
      screen,
      session,
    });
  }

  // Write the agent-readable <base>.json + <base>.interview.md next to an exported HTML file
  // so a coding agent revisiting the session re-reads compact data, not the inlined bundle.
  function writeExportSidecars(htmlFile, state) {
    writeInterviewSidecars(htmlFile, state.screen, state.session, atomicWrite);
  }

  function writeLiveExport() {
    try {
      ensureArtifactDir();
      const state = currentExportState();
      atomicWrite(exportPath, renderCurrent(state));
      writeExportSidecars(exportPath, state);
    } catch (error) {
      // A write failure (or an invalid screen.json) must never break the live session; the
      // previous good artifact stays in place until the next successful refresh.
      console.error(`brainstorm live export failed: ${error.message}`);
    }
  }

  function saveSnapshot() {
    ensureArtifactDir();
    const state = currentExportState();
    const existing = fs.readdirSync(artifactDir).filter(name => /^visual-\d+\.html$/.test(name)).length;
    const file = path.join(artifactDir, `visual-${String(existing + 1).padStart(3, '0')}.html`);
    atomicWrite(file, renderCurrent(state));
    writeExportSidecars(file, state);
    return file;
  }

  function writeEvent(response, event, value = {}) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
    response.write(payload);
  }

  function sendEvent(event, value = {}) {
    for (const response of eventClients) {
      try {
        writeEvent(response, event, value);
      } catch {
        eventClients.delete(response);
      }
    }
  }

  function sendComment(comment) {
    const payload = `: ${comment}\n\n`;
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
    if (request.method === 'GET' && relativePath === 'assets/elk-worker.min.js') {
      sendText(response, 200, shellWorker, 'application/javascript; charset=utf-8', cookieHeaders);
      return;
    }
    if (request.method === 'GET' && relativePath === 'assets/styles.css') {
      sendText(response, 200, shellStyles, 'text/css; charset=utf-8', cookieHeaders);
      return;
    }

    const reviewEvidencePathId = reviewPathId(requestUrl, relativePath);
    const isReviewRoute = relativePath === 'api/review/source'
      || relativePath === 'api/review/evidence'
      || reviewEvidencePathId !== null;
    if (isReviewRoute) {
      if (!sameOrigin(request)) {
        sendJson(response, 403, { error: 'cross-origin review request rejected' }, cookieHeaders);
        return;
      }
      if (request.method !== 'GET') {
        sendJson(response, 405, { error: 'review endpoint is read-only' }, {
          ...cookieHeaders,
          Allow: 'GET',
        });
        return;
      }

      // Authenticated opaque evidence lookup exposes only typed Review projections.
      if (relativePath === 'api/review/source') {
        const sourceId = reviewQueryId(requestUrl, REVIEW_SOURCE_ID_PATTERN);
        if (sourceId == null) {
          sendJson(response, 400, { error: 'invalid review source request' }, cookieHeaders);
          return;
        }
        try {
          sendJson(response, 200, resolveReviewSource(readScreen(), sourceId, { repositoryRoot }), cookieHeaders);
        } catch {
          sendJson(response, 404, { error: 'review source is unavailable' }, cookieHeaders);
        }
        return;
      }

      const evidenceId = relativePath === 'api/review/evidence'
        ? reviewQueryId(requestUrl, EVIDENCE_RECORD_ID_PATTERN)
        : reviewEvidencePathId;
      if (!evidenceId) {
        sendJson(response, 400, { error: 'invalid review evidence request' }, cookieHeaders);
        return;
      }
      try {
        const result = resolveReviewEvidence(readScreen(), evidenceId);
        sendJson(
          response,
          200,
          relativePath === 'api/review/evidence' ? result : result.evidence,
          cookieHeaders,
        );
      } catch {
        sendJson(response, 404, { error: 'review evidence is unavailable' }, cookieHeaders);
      }
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
    if (request.method === 'GET' && relativePath === 'api/state') {
      try {
        sendJson(response, 200, readState(), cookieHeaders);
      } catch {
        sendJson(response, 422, { error: 'visual state is unavailable' }, cookieHeaders);
      }
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
      writeEvent(response, 'resync', { reason: 'connected' });
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
        const body = await readJsonBody(request);
        const result = withVisualStateLock(sessionDir, () => {
          const retryClientTurnId = typeof body?.clientTurnId === 'string' ? body.clientTurnId.trim() : '';
          const existing = retryClientTurnId
            ? store.snapshot().events.find(event => event.type === 'user.turn'
              && event.clientTurnId === retryClientTurnId)
            : null;
          if (existing) return { record: existing, created: false };
          const currentDocument = readScreen();
          if (currentDocument.version === 2) {
            const revision = body?.screen?.revision;
            if (typeof revision !== 'string' || !/^[a-f0-9]{8}$/.test(revision)) {
              const error = new TypeError('Feedback Batch Revision must be 8 lowercase hexadecimal characters');
              error.statusCode = 400;
              throw error;
            }
            if (revision !== currentDocument.revision) {
              const error = new Error('Feedback Batch Revision is stale and does not match the current Visual Document');
              error.statusCode = 409;
              throw error;
            }
          }
          return { record: store.appendBrowserTurn(body), created: true };
        });
        sendJson(response, 201, result.record, cookieHeaders);
        if (result.created) {
          sendEvent('session', { seq: result.record.seq });
        }
      } catch (error) {
        const status = error.statusCode || (error instanceof RangeError ? 413 : 400);
        sendJson(response, status, { error: error.message }, cookieHeaders);
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

  let watcherFallback = null;
  function enableWatcherFallback() {
    if (watcherFallback) return;
    watcherFallback = setInterval(() => {
      if (closing) return;
      sendEvent('screen');
      sendEvent('session');
      sendEvent('delivery');
      writeLiveExport();
    }, 100);
    watcherFallback.unref?.();
  }

  const contentWatcher = fs.watch(contentDir, (_eventType, filename) => {
    // Some platforms report a null filename; fall through rather than miss the refresh.
    if (filename != null && !['screen.json', 'workspace.json'].includes(String(filename))) return;
    if (debounceTimers.has('screen')) clearTimeout(debounceTimers.get('screen'));
    debounceTimers.set('screen', setTimeout(() => {
      debounceTimers.delete('screen');
      touchActivity();
      sendEvent('screen');
      writeLiveExport();
    }, 60));
  });
  contentWatcher.on('error', error => {
    console.error(`brainstorm content watcher failed: ${error.message}`);
    enableWatcherFallback();
  });

  const stateWatcher = fs.watch(stateDir, (_eventType, filename) => {
    if (filename != null && !['session.jsonl', 'agent-cursor.json', 'visual-format.json', 'delivery-state.json'].includes(String(filename))) return;
    const events = filename == null
      ? ['screen', 'session', 'delivery']
      : [String(filename) === 'visual-format.json'
        ? 'screen'
        : String(filename) === 'delivery-state.json' ? 'delivery' : 'session'];
    for (const event of events) {
      const timerKey = `state-${event}`;
      if (debounceTimers.has(timerKey)) clearTimeout(debounceTimers.get(timerKey));
      debounceTimers.set(timerKey, setTimeout(() => {
        debounceTimers.delete(timerKey);
        sendEvent(event);
        if (event !== 'delivery') writeLiveExport();
      }, 40));
    }
  });
  stateWatcher.on('error', error => {
    console.error(`brainstorm state watcher failed: ${error.message}`);
    enableWatcherFallback();
  });

  const heartbeat = sseSetInterval(() => sendComment('heartbeat'), sseHeartbeatMs);
  heartbeat.unref?.();

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
        fs.rmSync(serverStoppedPath, { force: true });
        fs.writeFileSync(serverInfoPath, `${JSON.stringify(safeInfo)}\n`, { mode: 0o600 });
        writeLiveExport();
        resolve(info);
      });
    });
  }

  function close(reason = 'closed') {
    if (closing) return Promise.resolve();
    closing = true;
    const safeReason = ['closed', 'idle timeout', 'owner process exited'].includes(reason) ? reason : 'closed';
    clearInterval(lifecycleCheck);
    if (watcherFallback) clearInterval(watcherFallback);
    sseClearInterval(heartbeat);
    for (const timer of debounceTimers.values()) clearTimeout(timer);
    contentWatcher.close();
    stateWatcher.close();
    sendEvent('closed', { reason: safeReason });
    for (const response of eventClients) response.end();
    eventClients.clear();
    if (fs.existsSync(serverInfoPath)) fs.rmSync(serverInfoPath, { force: true });
    if (fs.existsSync(stateDir)) {
      fs.writeFileSync(serverStoppedPath, `${JSON.stringify({ reason: safeReason, timestamp: Date.now() })}\n`, { mode: 0o600 });
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
