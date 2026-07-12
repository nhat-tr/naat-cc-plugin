const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createBrainstormServer } = require('./server.cjs');
const { SessionStore } = require('./session-store.cjs');
const { renderStandalone } = require('./standalone.cjs');
const { createVisualScaffold, normalizeVisualDocument } = require('./visual-document.cjs');

const SHELL_DIR = path.resolve(__dirname, '../assets/visual-shell');
const KNOWN_OPTIONS = new Set([
  'projectDir', 'host', 'urlHost', 'port', 'ownerPid', 'output', 'profile', 'audience',
  'title', 'summary', 'kinds', 'document', 'sessionDir', 'timeoutMs', 'replyTo', 'messageFile',
]);

function fail(message) {
  throw new Error(message);
}

function parseOptions(values) {
  const options = {};
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (!flag?.startsWith('--') || value == null || value.startsWith('--')) fail(`invalid option ${flag || ''}`.trim());
    const key = flag.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    if (!KNOWN_OPTIONS.has(key)) fail(`unknown option ${flag}`);
    options[key] = value;
  }
  return options;
}

function parseNonNegativeInteger(value, label) {
  if (value == null) return null;
  if (!/^\d+$/.test(String(value))) fail(`${label} must be a non-negative integer`);
  return Number(value);
}

function repositoryRoot(cwd = process.cwd()) {
  try {
    return childProcess.execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return path.resolve(cwd);
  }
}

function scratchRoot() {
  return path.resolve(process.env.CLAUDE_SCRATCH_DIR || path.join(os.homedir(), '.claude-scratch'));
}

function activeKey(root) {
  // basename alone collides across repos that share a name (~/work/api vs ~/personal/api);
  // suffix a short hash of the absolute root so each checkout gets its own pointer.
  const digest = crypto.createHash('sha256').update(root).digest('hex').slice(0, 8);
  return `${path.basename(root)}-${digest}`;
}

function defaultActiveFile(options = {}) {
  const root = repositoryRoot(options.projectDir || options.cwd);
  return path.join(scratchRoot(), activeKey(root), 'brainstorm', 'active-session.json');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function atomicJson(file, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, mode);
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function activeMetadata(options = {}) {
  if (options.sessionDir) {
    const sessionDir = path.resolve(options.sessionDir);
    const stateDir = path.join(sessionDir, 'state');
    const metaFile = path.join(stateDir, 'session-meta.json');
    const infoFile = path.join(stateDir, 'server-info');
    const pidFile = path.join(stateDir, 'server.pid');
    const meta = fs.existsSync(metaFile)
      ? readJson(metaFile)
      : (fs.existsSync(infoFile) ? readJson(infoFile) : {});
    // active_file is recovered from the session's own metadata, never re-guessed from the
    // caller's cwd git root — otherwise stopping from another directory leaves the real
    // pointer behind with a dead pid.
    return {
      ...meta,
      pid: fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) : (meta.pid ?? null),
      session_dir: sessionDir,
      content_dir: meta.content_dir || path.join(sessionDir, 'content'),
      state_dir: stateDir,
      active_file: meta.active_file
        ? path.resolve(meta.active_file)
        : (options.activeFile ? path.resolve(options.activeFile) : null),
    };
  }
  const activeFile = path.resolve(options.activeFile || defaultActiveFile(options));
  if (!fs.existsSync(activeFile)) fail(`no active visual session at ${activeFile}`);
  return { ...readJson(activeFile), active_file: activeFile };
}

function assertLive(metadata) {
  // A null pid means liveness is unknown (e.g. an in-process server or a legacy session);
  // only refuse when we positively know the owning process is gone.
  if (metadata.pid != null && !processAlive(metadata.pid)) {
    fail(`visual session process ${metadata.pid} is not running; start a new session`);
  }
}

function waitingDocument() {
  return normalizeVisualDocument({
    profile: 'technical',
    title: 'Visual session',
    summary: 'No visual document was published in this session.',
    sections: [{
      kind: 'callout',
      id: 'no-visual',
      title: 'No visual published',
      body: 'This session ended without a published screen.json.',
      tone: 'accent',
    }],
  });
}

function readScreenOrWaiting(screenFile) {
  if (!fs.existsSync(screenFile)) return waitingDocument();
  try {
    return normalizeVisualDocument(readJson(screenFile));
  } catch {
    return waitingDocument();
  }
}

function readSessionSnapshot(stateDir) {
  try {
    return new SessionStore(stateDir).snapshot();
  } catch {
    return { version: 1, cursor: 0, pendingTurns: 0, events: [] };
  }
}

// Bundle the document, the conversation history, and the exact rendering shell into one
// self-contained HTML file that opens from disk (file://) with no server, so the visual
// outlives the session and can be reviewed later or shared standalone.
function buildStandaloneHtml(screen, session) {
  return renderStandalone({
    shell: fs.readFileSync(path.join(SHELL_DIR, 'index.html'), 'utf8'),
    styles: fs.readFileSync(path.join(SHELL_DIR, 'styles.css'), 'utf8'),
    script: fs.readFileSync(path.join(SHELL_DIR, 'app.js'), 'utf8'),
    screen,
    session,
  });
}

function defaultExportPath(metadata) {
  // Prefer the repo-local artifact directory so exports live with the session's other
  // artifacts and survive scratch-session cleanup.
  if (metadata.artifact_dir) return path.join(metadata.artifact_dir, 'visual.html');
  const id = metadata.session_id || path.basename(metadata.session_dir);
  return path.join(path.dirname(metadata.session_dir), `${id}-visual.html`);
}

function writeStandaloneExport(metadata, outputOption) {
  const screen = readScreenOrWaiting(path.join(metadata.content_dir, 'screen.json'));
  const session = readSessionSnapshot(metadata.state_dir);
  const output = path.resolve(outputOption || defaultExportPath(metadata));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, buildStandaloneHtml(screen, session), { mode: 0o600 });
  return output;
}

function removeActiveIfMatching(metadata) {
  const activeFile = metadata.active_file;
  if (!activeFile || !fs.existsSync(activeFile)) return;
  try {
    if (readJson(activeFile).session_dir === metadata.session_dir) fs.rmSync(activeFile, { force: true });
  } catch {
    // A corrupt pointer is stale by definition.
    fs.rmSync(activeFile, { force: true });
  }
}

async function start(options) {
  const activeFile = path.resolve(options.activeFile || defaultActiveFile(options));
  if (fs.existsSync(activeFile)) {
    const current = readJson(activeFile);
    if (processAlive(current.pid)) fail(`visual session already active at ${current.session_dir}`);
    fs.rmSync(activeFile, { force: true });
  }

  const sessionId = `${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`;
  const sessionDir = options.projectDir
    ? path.join(path.resolve(options.projectDir), '.brainstorm', sessionId)
    : path.join(path.dirname(activeFile), sessionId);
  const token = crypto.randomBytes(24).toString('hex');
  const host = options.host || '127.0.0.1';
  // The owner is the foreground harness (this node process's parent). When it dies, the
  // server self-terminates instead of orphaning a live token for the full idle window.
  const ownerPid = options.ownerPid ? Number(options.ownerPid) : process.ppid;
  // Artifacts land in the working repo, independent of whether session state is scratch or
  // retained (--project-dir), so the visual is always a normal artifact of the repo.
  const artifactDir = path.join(repositoryRoot(options.projectDir), '.artifacts', 'brainstorm', sessionId);
  const app = createBrainstormServer({
    sessionDir,
    sessionId,
    host,
    port: options.port ? Number(options.port) : 0,
    urlHost: options.urlHost || (host === '127.0.0.1' ? 'localhost' : host),
    token,
    ownerPid,
    artifactDir,
  });
  const info = await app.listen();
  const pidFile = path.join(info.state_dir, 'server.pid');
  fs.writeFileSync(pidFile, `${process.pid}\n`, { mode: 0o600 });

  const metadata = {
    version: 1,
    pid: process.pid,
    session_id: sessionId,
    session_dir: sessionDir,
    content_dir: info.screen_dir,
    state_dir: info.state_dir,
    active_file: activeFile,
    url: info.url,
    base_path: info.base_path,
    artifact_dir: artifactDir,
    visual_file: info.visual_file,
    persistent: Boolean(options.projectDir),
  };
  atomicJson(activeFile, metadata);
  // A copy inside the session lets --session-dir commands recover the true active_file and
  // pid without re-deriving them from the caller's cwd.
  atomicJson(path.join(info.state_dir, 'session-meta.json'), metadata);
  console.log(JSON.stringify({
    ...metadata,
    type: 'visual-session-started',
    connection_url: info.connection_url,
    screen_file: path.join(info.screen_dir, 'screen.json'),
  }));

  let stopping = false;
  const shutdown = async reason => {
    if (stopping) return;
    stopping = true;
    await app.close(reason);
    fs.rmSync(pidFile, { force: true });
    removeActiveIfMatching(metadata);
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

function publish(options) {
  if (!options.document) fail('publish requires --document FILE');
  const metadata = activeMetadata(options);
  assertLive(metadata);
  const source = path.resolve(options.document);
  const document = normalizeVisualDocument(readJson(source));
  const roundTrip = normalizeVisualDocument(document);
  if (JSON.stringify(roundTrip) !== JSON.stringify(document)) {
    fail('visual document normalization is not stable; screen was not replaced');
  }
  atomicJson(path.join(metadata.content_dir, 'screen.json'), document);
  console.log(JSON.stringify({ type: 'screen.published', screen_file: path.join(metadata.content_dir, 'screen.json') }));
}

function scaffold(options) {
  if (!options.output) fail('scaffold requires --output FILE');
  const kinds = options.kinds ? options.kinds.split(',').map(value => value.trim()).filter(Boolean) : undefined;
  const document = createVisualScaffold({
    profile: options.profile,
    audience: options.audience,
    title: options.title,
    summary: options.summary,
    kinds,
  });
  const output = path.resolve(options.output);
  atomicJson(output, document);
  console.log(JSON.stringify({
    type: 'screen.scaffolded',
    screen_file: output,
    profile: document.profile,
    sections: document.sections.map(section => section.kind),
  }));
}

function drain(options) {
  const metadata = activeMetadata(options);
  assertLive(metadata);
  const snapshot = new SessionStore(metadata.state_dir).snapshot();
  const turn = snapshot.events.find(event => event.type === 'user.turn' && event.seq > snapshot.cursor) || null;
  if (!turn) {
    console.log(JSON.stringify({ type: 'empty' }));
    return;
  }
  // pending counts every unacknowledged batch so a caller can tell a queued second batch is
  // waiting rather than assuming the session is drained after one turn.
  console.log(JSON.stringify({ ...turn, pending: snapshot.pendingTurns }));
}

async function wait(options) {
  const metadata = activeMetadata(options);
  const timeoutMs = parseNonNegativeInteger(options.timeoutMs, 'timeout-ms') ?? 15 * 60 * 1_000;
  const store = new SessionStore(metadata.state_dir);
  const turn = await store.waitForUnacknowledgedTurn({ timeoutMs });
  if (!turn) {
    console.log(JSON.stringify({ type: 'timeout' }));
    return;
  }
  // Same contract as drain: pending counts every unacknowledged batch, so the caller knows a
  // second batch is already queued instead of ending the review loop after one turn.
  console.log(JSON.stringify({ ...turn, pending: store.snapshot().pendingTurns }));
}

function reply(options) {
  if (!options.replyTo || !options.messageFile) fail('reply requires --reply-to SEQ --message-file FILE');
  const metadata = activeMetadata(options);
  assertLive(metadata);
  const record = new SessionStore(metadata.state_dir).publishAgentReply({
    replyTo: Number(options.replyTo),
    message: fs.readFileSync(path.resolve(options.messageFile), 'utf8'),
  });
  console.log(JSON.stringify(record));
}

function status(options) {
  const metadata = activeMetadata(options);
  console.log(JSON.stringify({ ...metadata, running: processAlive(metadata.pid) }));
}

function sleepMs(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function stop(options) {
  const metadata = activeMetadata(options);
  const pidFile = path.join(metadata.state_dir, 'server.pid');
  if (processAlive(metadata.pid) && metadata.pid !== process.pid) {
    process.kill(metadata.pid, 'SIGTERM');
    const deadline = Date.now() + 2_000;
    while (fs.existsSync(pidFile) && Date.now() < deadline) sleepMs(25);
    if (processAlive(metadata.pid)) {
      // The owner ignored SIGTERM; escalate so a wedged process never keeps serving a token.
      try { process.kill(metadata.pid, 'SIGKILL'); } catch { /* already gone */ }
      const hardDeadline = Date.now() + 1_000;
      while (processAlive(metadata.pid) && Date.now() < hardDeadline) sleepMs(25);
    }
  }
  if (fs.existsSync(pidFile) && processAlive(metadata.pid)) fail(`visual session process ${metadata.pid} did not stop`);
  removeActiveIfMatching(metadata);
  // Capture the standalone visual before scratch cleanup deletes the session directory.
  let exportFile = null;
  try {
    exportFile = writeStandaloneExport(metadata, options.output);
  } catch (error) {
    console.error(`visual-session: standalone export failed: ${error.message}`);
  }
  if (!metadata.persistent && metadata.session_dir.startsWith(`${scratchRoot()}${path.sep}`)) {
    fs.rmSync(metadata.session_dir, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ type: 'visual-session-stopped', session_dir: metadata.session_dir, export_file: exportFile }));
}

function exportVisual(options) {
  const metadata = activeMetadata(options);
  const output = writeStandaloneExport(metadata, options.output);
  console.log(JSON.stringify({ type: 'visual.exported', export_file: output }));
}

async function main() {
  const [command, ...values] = process.argv.slice(2);
  if (!command || ['help', '--help', '-h'].includes(command)) {
    console.log([
      'Usage: visual-session.cjs start [--project-dir DIR] [--host HOST] [--url-host HOST]',
      '       visual-session.cjs scaffold --output FILE [--profile technical|product|business] [--kinds anchor,flow,decision]',
      '       visual-session.cjs publish --document FILE [--session-dir DIR]',
      '       visual-session.cjs drain [--session-dir DIR]',
      '       visual-session.cjs wait [--timeout-ms MS] [--session-dir DIR]',
      '       visual-session.cjs reply --reply-to SEQ --message-file FILE [--session-dir DIR]',
      '       visual-session.cjs status [--session-dir DIR]',
      '       visual-session.cjs export [--output FILE] [--session-dir DIR]',
      '       visual-session.cjs stop [--output FILE] [--session-dir DIR]',
    ].join('\n'));
    return;
  }
  const options = parseOptions(values);
  if (command === 'start') await start(options);
  else if (command === 'scaffold') scaffold(options);
  else if (command === 'publish') publish(options);
  else if (command === 'drain') drain(options);
  else if (command === 'wait') await wait(options);
  else if (command === 'reply') reply(options);
  else if (command === 'status') status(options);
  else if (command === 'export') exportVisual(options);
  else if (command === 'stop') stop(options);
  else fail(`unsupported visual session command ${command}`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(`visual-session: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { activeMetadata, buildStandaloneHtml, defaultActiveFile, parseOptions, writeStandaloneExport };
