const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createBrainstormServer } = require('./server.cjs');
const { readDeliveryState, waitForFeedback } = require('./delivery-core.cjs');
const { writeInterviewSidecars } = require('./interview-export.cjs');
const { appendRevisionSnapshot, readRevisionSnapshots } = require('./revision-archive.cjs');
const { SessionStore } = require('./session-store.cjs');
const { renderStandalone } = require('./standalone.cjs');
const { createVisualScaffold, normalizeVisualDocument } = require('./visual-document.cjs');
const { createWorkspaceScaffold } = require('./workspace-scaffold.cjs');

const SHELL_DIR = path.resolve(__dirname, '../assets/visual-shell');
const KNOWN_OPTIONS = new Set([
  'projectDir', 'host', 'urlHost', 'port', 'ownerPid', 'output', 'profile', 'audience',
  'title', 'summary', 'kinds', 'document', 'sessionDir', 'timeoutMs', 'replyTo', 'messageFile',
  'message', 'workId', 'workspaceKind', 'draft', 'olderThanDays',
  'quiet', 'dryRun', 'all',
]);
// Flags that take no value; present means true.
const BOOLEAN_OPTIONS = new Set(['quiet', 'dryRun', 'all']);

function fail(message) {
  throw new Error(message);
}

function parseOptions(values) {
  const options = {};
  let index = 0;
  while (index < values.length) {
    const flag = values[index];
    if (!flag?.startsWith('--')) fail(`invalid option ${flag || ''}`.trim());
    const key = flag.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    if (!KNOWN_OPTIONS.has(key)) fail(`unknown option ${flag}`);
    if (BOOLEAN_OPTIONS.has(key)) {
      options[key] = true;
      index += 1;
      continue;
    }
    const value = values[index + 1];
    if (value == null || value.startsWith('--')) fail(`invalid option ${flag}`.trim());
    options[key] = value;
    index += 2;
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

// The pointer path is keyed to the caller's git root, so a command run from another directory
// (or a non-repo cwd) derives a different key and misses a running session. When that happens,
// scan scratch for session pointers and return the one live session — but never guess when more
// than one is alive; the caller then reports "no active session" and the user passes --session-dir.
function discoverLiveSession() {
  let entries;
  try {
    entries = fs.readdirSync(scratchRoot(), { withFileTypes: true });
  } catch {
    return null;
  }
  const live = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const activeFile = path.join(scratchRoot(), entry.name, 'brainstorm', 'active-session.json');
    if (!fs.existsSync(activeFile)) continue;
    let metadata;
    try {
      metadata = readJson(activeFile);
    } catch {
      continue;
    }
    if (metadata.pid != null && processAlive(metadata.pid)) {
      live.push({ ...metadata, active_file: activeFile });
    }
  }
  return live.length === 1 ? live[0] : null;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readRegularJson(file, label, options = {}) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  } catch (error) {
    if (error.code === 'ENOENT' && options.optional) return null;
    if (error.code === 'ELOOP') fail(`${label} must be a regular file and must not be a symlink`);
    fail(`${label} could not be read`);
  }
  try {
    if (!fs.fstatSync(descriptor).isFile()) fail(`${label} must be a regular file and must not be a symlink`);
    return JSON.parse(fs.readFileSync(descriptor, 'utf8'));
  } catch {
    fail(`${label} contains invalid JSON`);
  } finally {
    fs.closeSync(descriptor);
  }
}

function normalizeDocument(value) {
  if (value?.version !== 2) return normalizeVisualDocument(value);
  const { normalizeWorkspaceDocument } = require('./workspace-document.cjs');
  const { normalizeKnownWorkspaceContent } = require('./workspace-content.cjs');
  return normalizeWorkspaceDocument(value, {
    contentValidator: normalizeKnownWorkspaceContent,
  });
}

function normalizeAuthoredDocument(value) {
  if (value?.version !== 2) return normalizeDocument(value);
  const candidate = structuredClone(value);
  delete candidate.revision;
  return normalizeDocument(candidate);
}

function atomicWrite(file, contents, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, contents, { mode, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function atomicJson(file, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, mode);
}

function atomicJsonExclusive(file, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode, flag: 'wx' });
    fs.linkSync(temporary, file);
  } catch (error) {
    if (error.code === 'EEXIST') fail(`scaffold output already exists: ${file}`);
    throw error;
  } finally {
    fs.rmSync(temporary, { force: true });
  }
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

// Rebuild the shareable connection_url (URL + base path + capability token) for a live session so
// every command can re-paste a working link. Returns null when the token is unavailable (e.g. a
// legacy session started before the token was persisted) rather than emitting a broken URL.
function sessionConnectionUrl(metadata) {
  if (!metadata?.url || !metadata?.base_path || !metadata?.state_dir) return null;
  let token;
  try {
    token = readJson(path.join(metadata.state_dir, 'capability.json')).token;
  } catch {
    return null;
  }
  if (typeof token !== 'string' || token.length === 0) return null;
  return `${metadata.url}${metadata.base_path}?token=${encodeURIComponent(token)}`;
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
  if (fs.existsSync(activeFile)) {
    return { ...readJson(activeFile), active_file: activeFile };
  }
  const discovered = discoverLiveSession();
  if (discovered) return discovered;
  fail(`no active visual session at ${activeFile}`);
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

function readScreenOrWaiting(screenFile, options = {}) {
  if (!fs.existsSync(screenFile)) {
    if (options.required) fail('active Visual Document is unavailable');
    return waitingDocument();
  }
  return normalizeDocument(readRegularJson(screenFile, 'active Visual Document'));
}

function visualFormatFile(metadata) {
  return path.join(metadata.state_dir, 'visual-format.json');
}

function readVisualFormat(metadata) {
  const value = readRegularJson(visualFormatFile(metadata), 'visual format metadata', { optional: true });
  if (value == null) return null;
  if (value.version !== 1 || ![1, 2].includes(value.active_version)
    || value.v1_document !== 'content/screen.json'
    || value.v2_document !== 'content/workspace.json'
    || Object.keys(value).some(key => !['version', 'active_version', 'v1_document', 'v2_document'].includes(key))) {
    fail('visual format metadata is malformed');
  }
  return value;
}

function activeDocumentFile(metadata) {
  return readVisualFormat(metadata)?.active_version === 2
    ? path.join(metadata.content_dir, 'workspace.json')
    : path.join(metadata.content_dir, 'screen.json');
}

function readSessionSnapshot(stateDir) {
  try {
    return new SessionStore(stateDir).strictSnapshot();
  } catch {
    fail('Session Store state is invalid');
  }
}

// Bundle the document, the conversation history, and the exact rendering shell into one
// self-contained HTML file that opens from disk (file://) with no server, so the visual
// outlives the session and can be reviewed later or shared standalone.
function buildStandaloneHtml(screen, session, revisions) {
  return renderStandalone({
    shell: fs.readFileSync(path.join(SHELL_DIR, 'index.html'), 'utf8'),
    styles: fs.readFileSync(path.join(SHELL_DIR, 'styles.css'), 'utf8'),
    script: fs.readFileSync(path.join(SHELL_DIR, 'app.js'), 'utf8'),
    worker: fs.readFileSync(path.join(SHELL_DIR, 'elk-worker.min.js'), 'utf8'),
    screen,
    session,
    revisions,
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
  const format = readVisualFormat(metadata);
  const activeFile = format?.active_version === 2
    ? path.join(metadata.content_dir, 'workspace.json')
    : path.join(metadata.content_dir, 'screen.json');
  const screen = readScreenOrWaiting(activeFile, { required: format != null });
  const session = readSessionSnapshot(metadata.state_dir);
  const revisions = readRevisionSnapshots(metadata.state_dir);
  const output = path.resolve(outputOption || defaultExportPath(metadata));
  atomicWrite(output, buildStandaloneHtml(screen, session, revisions));
  // Emit the agent-readable sidecars next to the HTML so a later revisit re-reads the
  // interview from compact data instead of the self-contained bundle.
  const sidecars = writeInterviewSidecars(output, screen, session, atomicWrite);
  // The marker lets session-lifecycle tooling tell exported-and-safe-to-prune sessions apart
  // from sessions whose only copy of the interview still lives in scratch.
  if (metadata.state_dir && fs.existsSync(metadata.state_dir)) {
    atomicJson(path.join(metadata.state_dir, 'exported.json'), {
      exported_at: new Date().toISOString(),
      export_file: output,
    });
  }
  return { html: output, data: sidecars.json, interview: sidecars.markdown };
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

async function startCodexIdleDelivery(options = {}) {
  const conversationId = options.conversationId || process.env.CODEX_THREAD_ID;
  if (typeof conversationId !== 'string' || !conversationId.trim()) return null;
  const { AgentConversationDelivery } = require('./agent-conversation-delivery.cjs');
  const { CodexAppServerAdapter } = require('./codex-app-server-adapter.cjs');
  const adapter = options.adapter || new CodexAppServerAdapter();
  const delivery = new AgentConversationDelivery({
    adapters: { codex: adapter },
    sessionStore: options.sessionStore,
    stateDir: options.stateDir,
  });
  const worker = await delivery.startWorker({
    runtime: 'codex',
    sessionId: options.sessionId,
    conversationId,
  });
  let closed = false;
  return {
    close: async () => {
      if (closed) return;
      closed = true;
      await worker.close();
      await adapter.close?.();
    },
  };
}

// Bind the server for a session identity, preferring each port in order; EADDRINUSE falls
// through to the next candidate so resume can try the recorded port before an ephemeral one.
async function listenPreferringPorts(serverOptions, ports) {
  for (let index = 0; index < ports.length; index += 1) {
    const app = createBrainstormServer({ ...serverOptions, port: ports[index] });
    try {
      const info = await app.listen();
      return { app, info };
    } catch (error) {
      await app.close();
      if (index === ports.length - 1 || error.code !== 'EADDRINUSE') throw error;
    }
  }
  fail('no candidate port to bind');
}

// Shared serve/register/shutdown wiring for start and resume: binds the server, records the
// session pointers (active file, session-meta, capability), starts idle delivery, announces,
// and keeps the process in the foreground until its owner or a signal stops it.
async function serveSession(context) {
  const { app, info } = await listenPreferringPorts({
    sessionDir: context.sessionDir,
    sessionId: context.sessionId,
    host: context.host,
    urlHost: context.urlHost,
    token: context.token,
    ownerPid: context.ownerPid,
    artifactDir: context.artifactDir,
  }, context.ports);
  const pidFile = path.join(info.state_dir, 'server.pid');
  fs.writeFileSync(pidFile, `${process.pid}\n`, { mode: 0o600 });

  const metadata = {
    version: 1,
    pid: process.pid,
    session_id: context.sessionId,
    session_dir: context.sessionDir,
    content_dir: info.screen_dir,
    state_dir: info.state_dir,
    active_file: context.activeFile,
    url: info.url,
    // The bound port is recorded so a later `resume` can revive the exact same URL.
    port: info.port,
    base_path: info.base_path,
    artifact_dir: context.artifactDir,
    visual_file: info.visual_file,
    persistent: context.persistent,
  };
  atomicJson(context.activeFile, metadata);
  // A copy inside the session lets --session-dir commands recover the true active_file and
  // pid without re-deriving them from the caller's cwd.
  atomicJson(path.join(info.state_dir, 'session-meta.json'), metadata);
  // The capability token is kept out of the shared active pointer (server.cjs strips it) but
  // persisted in the session's own private, owner-only state so later commands (present reuse,
  // publish, reply, status, resume) can re-emit a working connection_url instead of relying on
  // the user still having the first start's link. Same trust boundary as the served pages.
  atomicJson(path.join(info.state_dir, 'capability.json'), { token: context.token }, 0o600);
  const idleDelivery = await startCodexIdleDelivery({
    sessionStore: app.store,
    stateDir: info.state_dir,
    sessionId: context.sessionId,
  });
  context.announce(info, metadata, idleDelivery);

  let stopping = false;
  const shutdown = async reason => {
    if (stopping) return;
    stopping = true;
    await idleDelivery?.close();
    await app.close(reason);
    fs.rmSync(pidFile, { force: true });
    removeActiveIfMatching(metadata);
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
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
  atomicJsonExclusive(path.join(sessionDir, 'content', 'screen.json'), waitingDocument());
  const initialDocument = options.initialDocument || null;
  if (initialDocument) {
    atomicJsonExclusive(path.join(sessionDir, 'content', 'workspace.json'), initialDocument);
    appendRevisionSnapshot(path.join(sessionDir, 'state'), initialDocument);
    atomicJsonExclusive(path.join(sessionDir, 'state', 'visual-format.json'), {
      version: 1,
      active_version: 2,
      v1_document: 'content/screen.json',
      v2_document: 'content/workspace.json',
    });
  }
  const token = crypto.randomBytes(24).toString('hex');
  const host = options.host || '127.0.0.1';
  // The owner is the foreground harness (this node process's parent). When it dies, the
  // server self-terminates instead of orphaning a live token for the full idle window.
  const ownerPid = options.ownerPid ? Number(options.ownerPid) : process.ppid;
  // Artifacts land in the working repo, independent of whether session state is scratch or
  // retained (--project-dir), so the visual is always a normal artifact of the repo.
  const artifactDir = path.join(repositoryRoot(options.projectDir), '.artifacts', 'brainstorm', sessionId);
  await serveSession({
    activeFile,
    sessionId,
    sessionDir,
    token,
    host,
    urlHost: options.urlHost || (host === '127.0.0.1' ? 'localhost' : host),
    ports: [options.port ? Number(options.port) : 0],
    ownerPid,
    artifactDir,
    persistent: Boolean(options.projectDir),
    announce: (info, metadata, idleDelivery) => {
      const activeFilePath = initialDocument
        ? path.join(info.screen_dir, 'workspace.json')
        : path.join(info.screen_dir, 'screen.json');
      const nextAction = 'Share connection_url, then run `wait` as a background task and end your turn; you are woken automatically when the user submits feedback (Codex also auto-delivers via its idle worker).';
      if (options.quiet) {
        // --quiet keeps only what the agent must echo onward; the full metadata (dirs, pids,
        // preflight geometry) stays recoverable via `status` instead of re-entering the transcript.
        console.log(JSON.stringify({
          type: initialDocument ? 'visual-session-presented' : 'visual-session-started',
          connection_url: info.connection_url,
          session_dir: sessionDir,
          ...(initialDocument
            ? { workspace_file: activeFilePath, revision: initialDocument.revision, next_action: nextAction }
            : { screen_file: activeFilePath }),
        }));
        return;
      }
      const deliveryState = readDeliveryState(path.join(info.state_dir, 'delivery-state.json'));
      console.log(JSON.stringify({
        ...metadata,
        type: initialDocument ? 'visual-session-presented' : 'visual-session-started',
        connection_url: info.connection_url,
        screen_file: activeFilePath,
        ...(initialDocument ? {
          workspace_file: activeFilePath,
          work_id: initialDocument.work_id,
          workspace_kind: initialDocument.workspace_kind,
          revision: initialDocument.revision,
          elk_preflight: options.elkPreflight,
          feedback_delivery: {
            mechanism: 'background_wait',
            automatic: idleDelivery ? 'codex_idle_worker' : 'not_probed',
            wait_receiver: deliveryState.listening ? 'listening' : 'not_listening',
          },
          next_action: nextAction,
        } : {}),
      }));
    },
  });
}

function recordedSessionPort(metadata) {
  if (Number.isInteger(metadata.port) && metadata.port > 0) return metadata.port;
  // Sessions recorded before the explicit port field still carry it inside the url.
  try {
    const port = Number(new URL(metadata.url).port);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

// Most recent dead session in this project's brainstorm directory; resume's default target.
function latestResumableSessionDir(options) {
  const brainstormDir = path.dirname(path.resolve(options.activeFile || defaultActiveFile(options)));
  let entries;
  try {
    entries = fs.readdirSync(brainstormDir, { withFileTypes: true });
  } catch {
    entries = [];
  }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const metaFile = path.join(brainstormDir, entry.name, 'state', 'session-meta.json');
    if (!fs.existsSync(metaFile)) continue;
    let meta;
    try {
      meta = readJson(metaFile);
    } catch {
      continue;
    }
    const pidFile = path.join(brainstormDir, entry.name, 'state', 'server.pid');
    const pid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) : meta.pid;
    if (pid != null && processAlive(pid)) continue;
    candidates.push({
      sessionDir: path.join(brainstormDir, entry.name),
      modified: fs.statSync(metaFile).mtimeMs,
    });
  }
  if (candidates.length === 0) fail('no resumable visual session found; pass --session-dir DIR');
  candidates.sort((left, right) => right.modified - left.modified);
  return candidates[0].sessionDir;
}

// Revive a dead session in place: same session id, same capability token, and — when the
// recorded port is still free — the exact same connection_url, so browser tabs and bookmarks
// survive a crash or owner reap. Only the serving process is new; the content, feedback
// history, and revision archive continue where they stopped.
async function resume(options) {
  const sessionDir = options.sessionDir
    ? path.resolve(options.sessionDir)
    : latestResumableSessionDir(options);
  const metadata = activeMetadata({ ...options, sessionDir });
  if (metadata.pid != null && processAlive(metadata.pid)) {
    fail('visual session is still running; use present or publish to reuse it, or stop it first');
  }
  const activeFile = path.resolve(
    options.activeFile || metadata.active_file || defaultActiveFile(options),
  );
  if (fs.existsSync(activeFile)) {
    const current = readJson(activeFile);
    if (current.session_dir !== sessionDir && processAlive(current.pid)) {
      fail(`visual session already active at ${current.session_dir}`);
    }
    fs.rmSync(activeFile, { force: true });
  }
  let token;
  try {
    token = readJson(path.join(metadata.state_dir, 'capability.json')).token;
  } catch {
    token = null;
  }
  if (typeof token !== 'string' || token.length === 0) {
    fail('cannot resume: session capability token is unavailable; start a new session');
  }
  const sessionId = metadata.session_id || path.basename(sessionDir);
  const recordedPort = recordedSessionPort(metadata);
  const host = options.host || '127.0.0.1';
  const ownerPid = options.ownerPid ? Number(options.ownerPid) : process.ppid;
  const artifactDir = metadata.artifact_dir
    || path.join(repositoryRoot(options.projectDir), '.artifacts', 'brainstorm', sessionId);
  await serveSession({
    activeFile,
    sessionId,
    sessionDir,
    token,
    host,
    urlHost: options.urlHost || (host === '127.0.0.1' ? 'localhost' : host),
    ports: recordedPort ? [recordedPort, 0] : [0],
    ownerPid,
    artifactDir,
    persistent: Boolean(metadata.persistent),
    announce: (info, resumedMetadata) => {
      const urlPreserved = recordedPort != null && info.port === recordedPort;
      const payload = {
        type: 'visual-session-resumed',
        connection_url: info.connection_url,
        session_dir: sessionDir,
        url_preserved: urlPreserved,
        ...(urlPreserved ? {} : {
          note: 'The recorded port was unavailable; share the new connection_url.',
        }),
        next_action: 'Share connection_url if the browser tab is gone, then run `wait` as a background task and end your turn.',
      };
      console.log(JSON.stringify(options.quiet ? payload : { ...resumedMetadata, ...payload }));
    },
  });
}

// Returns the live session's metadata for this project, or null when none is running. present
// uses it to replace the document in place (reusing port/token/URL) instead of cold-starting.
function liveSessionOrNull(options) {
  let metadata;
  try {
    metadata = activeMetadata(options);
  } catch {
    return null;
  }
  if (metadata.pid == null || !processAlive(metadata.pid)) return null;
  return metadata;
}

// Atomically replace the active Visual Document of a running session, enforcing the same
// version-compatibility guards as Publish. Shared by publish and present's in-place reuse path.
function writeDocumentIntoLiveSession(metadata, document) {
  const { withVisualStateLock } = require('./legacy-visual-import.cjs');
  return withVisualStateLock(metadata.session_dir, () => {
    const format = readVisualFormat(metadata);
    if (format?.active_version === 1 && document.version === 2) {
      fail('active v1 Visual Session requires migrate before publishing Visual Document v2');
    }
    if (format?.active_version === 2 && document.version !== 2) {
      fail('active v2 Visual Session accepts only Visual Document v2 Publish candidates');
    }
    const legacyFile = path.join(metadata.content_dir, 'screen.json');
    if (format == null && fs.existsSync(legacyFile)) {
      const current = normalizeDocument(readRegularJson(legacyFile, 'active Visual Document'));
      if (current.version !== document.version) {
        fail(current.version === 1
          ? 'active v1 Visual Session requires migrate before publishing Visual Document v2'
          : 'active Visual Document version cannot be replaced without an explicit migration');
      }
    }
    const destination = format?.active_version === 2
      ? path.join(metadata.content_dir, 'workspace.json')
      : legacyFile;
    atomicJson(destination, document);
    appendRevisionSnapshot(metadata.state_dir || path.join(metadata.session_dir, 'state'), document);
    return destination;
  });
}

// A --draft file is self-describing: an optional top-level `kind` selects the compiler
// (default `architecture`, so every existing Architecture Draft keeps working untouched).
// This is the single draft dispatch shared by present, publish, and validate.
function compileDraft(resolvedPath) {
  const draft = readRegularJson(resolvedPath, 'Visual Draft');
  const kind = draft && typeof draft === 'object' && !Array.isArray(draft)
    ? (draft.kind ?? 'architecture')
    : 'architecture';
  if (kind === 'architecture') {
    return require('./architecture-draft.cjs').compileArchitectureDraft(draft);
  }
  if (kind === 'uml') {
    return require('./uml-draft.cjs').compileUmlDraft(draft);
  }
  return fail(`unsupported draft kind ${kind}; expected architecture or uml`);
}

async function publish(options) {
  if (Boolean(options.document) === Boolean(options.draft)) {
    fail('publish requires exactly one of --document FILE or --draft FILE');
  }
  const metadata = activeMetadata(options);
  assertLive(metadata);
  const source = path.resolve(options.draft || options.document);
  // Publish REPLACES the active document, so a supplied revision must match the content it claims
  // (normalizeDocument enforces that); a mismatched or malformed revision is rejected rather than
  // silently recomputed. present, by contrast, authors a fresh document and derives the revision.
  const document = options.draft
    ? compileDraft(source)
    : normalizeDocument(readRegularJson(source, 'Visual Document candidate'));
  const roundTrip = normalizeDocument(document);
  if (JSON.stringify(roundTrip) !== JSON.stringify(document)) {
    fail('visual document normalization is not stable; screen was not replaced');
  }
  const { preflightWorkspaceDocument } = require('./workspace-render-preflight.cjs');
  await preflightWorkspaceDocument(document);
  const output = writeDocumentIntoLiveSession(metadata, document);
  console.log(JSON.stringify({ type: 'screen.published', screen_file: output }));
}

async function present(options) {
  if (Boolean(options.document) === Boolean(options.draft)) {
    fail('present requires exactly one of --document FILE or --draft FILE');
  }
  let document;
  if (options.draft) {
    document = compileDraft(path.resolve(options.draft));
  } else {
    document = normalizeAuthoredDocument(
      readRegularJson(path.resolve(options.document), 'Visual Document candidate'),
    );
  }
  if (document.version !== 2) fail('present accepts only Visual Document v2 or a compiled Draft');
  const { preflightWorkspaceDocument } = require('./workspace-render-preflight.cjs');
  const elkPreflight = await preflightWorkspaceDocument(document);

  // Reuse a session that is already live for this project: replacing the document in place keeps
  // the running server, port, token, and connection_url, so switching the workspace kind mid-review
  // never orphans the open browser tab. Run `stop` first to force a brand-new session.
  const live = liveSessionOrNull(options);
  if (live) {
    const output = writeDocumentIntoLiveSession(live, document);
    console.log(JSON.stringify({
      type: 'visual-session-represented',
      workspace_file: output,
      work_id: document.work_id,
      workspace_kind: document.workspace_kind,
      revision: document.revision,
      session_dir: live.session_dir,
      connection_url: sessionConnectionUrl(live),
      ...(options.quiet ? {} : {
        url: live.url,
        base_path: live.base_path,
        elk_preflight: elkPreflight,
      }),
      note: 'Reused the live session — the browser URL is unchanged.',
    }));
    return;
  }
  await start({ ...options, initialDocument: document, elkPreflight });
}

function projectBrainstormDir(options) {
  return path.dirname(path.resolve(options.activeFile || defaultActiveFile(options)));
}

function allBrainstormDirs() {
  let entries;
  try {
    entries = fs.readdirSync(scratchRoot(), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(scratchRoot(), entry.name, 'brainstorm'))
    .filter(directory => fs.existsSync(directory));
}

function listSessionDirs(options) {
  const roots = options.all ? allBrainstormDirs() : [projectBrainstormDir(options)];
  const sessionDirs = [];
  for (const root of roots) {
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const sessionDir = path.join(root, entry.name);
      if (!fs.existsSync(path.join(sessionDir, 'state'))
        && !fs.existsSync(path.join(sessionDir, 'content'))) continue;
      sessionDirs.push(sessionDir);
    }
  }
  return sessionDirs;
}

function walkSessionFiles(directory) {
  const stats = { sizeBytes: 0, lastModifiedMs: 0 };
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return stats;
  }
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = walkSessionFiles(file);
      stats.sizeBytes += nested.sizeBytes;
      stats.lastModifiedMs = Math.max(stats.lastModifiedMs, nested.lastModifiedMs);
      continue;
    }
    try {
      const stat = fs.statSync(file);
      stats.sizeBytes += stat.size;
      stats.lastModifiedMs = Math.max(stats.lastModifiedMs, stat.mtimeMs);
    } catch {
      // A file vanishing mid-walk (e.g. a temp write) only skews the totals, never fails list.
    }
  }
  return stats;
}

function countMatchingLines(file, needle) {
  if (!fs.existsSync(file)) return 0;
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(line => line.includes(needle)).length;
  } catch {
    return 0;
  }
}

function describeSession(sessionDir) {
  let metadata;
  try {
    metadata = activeMetadata({ sessionDir });
  } catch {
    metadata = {
      session_dir: sessionDir,
      state_dir: path.join(sessionDir, 'state'),
      content_dir: path.join(sessionDir, 'content'),
    };
  }
  const stateDir = metadata.state_dir;
  const stats = walkSessionFiles(sessionDir);
  let exported = null;
  try {
    exported = readJson(path.join(stateDir, 'exported.json'));
  } catch {
    exported = null;
  }
  let stopped = null;
  try {
    stopped = readJson(path.join(stateDir, 'server-stopped'));
  } catch {
    stopped = null;
  }
  return {
    session_id: metadata.session_id || path.basename(sessionDir),
    session_dir: sessionDir,
    live: metadata.pid != null && processAlive(metadata.pid),
    persistent: Boolean(metadata.persistent),
    modified: new Date(stats.lastModifiedMs || 0).toISOString(),
    size_bytes: stats.sizeBytes,
    feedback_turns: countMatchingLines(path.join(stateDir, 'session.jsonl'), '"user.turn"'),
    revisions: countMatchingLines(path.join(stateDir, 'revisions.jsonl'), '"revision"'),
    exported_at: exported?.exported_at ?? null,
    export_file: exported?.export_file ?? null,
    stopped_reason: stopped?.reason ?? null,
  };
}

function sessionsList(options) {
  const sessions = listSessionDirs(options)
    .map(describeSession)
    .sort((left, right) => right.modified.localeCompare(left.modified));
  console.log(JSON.stringify({
    type: 'visual-sessions',
    scope: options.all ? 'all-projects' : 'project',
    sessions,
  }));
}

// Archive = capture the durable record (standalone HTML + sidecars, revision timeline included)
// outside scratch, then remove the scratch session directory. Persistent (--project-dir)
// sessions and directories outside scratch are exported but never deleted.
function archiveSessionDir(sessionDir, outputOption) {
  const metadata = activeMetadata({ sessionDir });
  if (metadata.pid != null && processAlive(metadata.pid)) {
    fail('visual session is still running; stop it before archiving');
  }
  const exported = writeStandaloneExport(metadata, outputOption);
  const removable = !metadata.persistent
    && sessionDir.startsWith(`${scratchRoot()}${path.sep}`);
  if (removable) {
    removeActiveIfMatching(metadata);
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
  return { exported, removed: removable };
}

function sessionsArchive(options) {
  if (!options.sessionDir) fail('sessions archive requires --session-dir DIR');
  const sessionDir = path.resolve(options.sessionDir);
  const { exported, removed } = archiveSessionDir(sessionDir, options.output);
  console.log(JSON.stringify({
    type: 'visual-session-archived',
    session_dir: sessionDir,
    export_file: exported.html,
    data_file: exported.data,
    interview_file: exported.interview,
    removed,
  }));
}

function sessionsPrune(options) {
  const olderThanDays = parseNonNegativeInteger(options.olderThanDays, 'older-than-days') ?? 14;
  const cutoff = Date.now() - olderThanDays * 86_400_000;
  const candidates = listSessionDirs(options)
    .map(describeSession)
    .filter(session => !session.live && Date.parse(session.modified) < cutoff);
  if (options.dryRun) {
    console.log(JSON.stringify({
      type: 'visual-sessions-prune-preview',
      older_than_days: olderThanDays,
      candidates,
    }));
    return;
  }
  const pruned = [];
  const skipped = [];
  for (const candidate of candidates) {
    try {
      const { exported, removed } = archiveSessionDir(candidate.session_dir);
      if (!removed) {
        skipped.push({ session_dir: candidate.session_dir, reason: 'persistent or outside scratch; exported only' });
        continue;
      }
      pruned.push({ session_dir: candidate.session_dir, export_file: exported.html });
    } catch {
      // Export-before-delete is the contract: a session whose record cannot be captured is
      // kept rather than destroyed.
      skipped.push({ session_dir: candidate.session_dir, reason: 'export failed; session retained' });
    }
  }
  console.log(JSON.stringify({
    type: 'visual-sessions-pruned',
    older_than_days: olderThanDays,
    pruned,
    skipped,
  }));
}

function sessions(subcommand, options) {
  if (subcommand === 'list') return sessionsList(options);
  if (subcommand === 'archive') return sessionsArchive(options);
  if (subcommand === 'prune') return sessionsPrune(options);
  return fail('sessions requires one of: list, archive, prune');
}

// Schema-checks a draft or document without serving it, so feedback answers can be applied as
// small targeted edits (Edit + validate) instead of full-file rewrites of the draft JSON.
async function validate(options) {
  if (Boolean(options.document) === Boolean(options.draft)) {
    fail('validate requires exactly one of --document FILE or --draft FILE');
  }
  let document;
  if (options.draft) {
    document = compileDraft(path.resolve(options.draft));
  } else {
    document = normalizeAuthoredDocument(
      readRegularJson(path.resolve(options.document), 'Visual Document candidate'),
    );
  }
  let renderPreflight = 'not_applicable';
  if (document.version === 2) {
    const { preflightWorkspaceDocument } = require('./workspace-render-preflight.cjs');
    renderPreflight = (await preflightWorkspaceDocument(document)).status;
  }
  console.log(JSON.stringify({
    type: 'visual-document.validated',
    source: options.draft ? 'draft' : 'document',
    version: document.version ?? 1,
    ...(document.version === 2 ? {
      work_id: document.work_id,
      workspace_kind: document.workspace_kind,
      revision: document.revision,
      frames: document.frames.length,
      components: document.components.length,
    } : {}),
    render_preflight: renderPreflight,
  }));
}

function migrate(options) {
  if (!options.workId || !options.workspaceKind) fail('migrate requires --work-id and --workspace-kind');
  const metadata = activeMetadata(options);
  readRegularJson(path.join(metadata.content_dir, 'screen.json'), 'legacy Visual Document');
  readRegularJson(path.join(metadata.content_dir, 'workspace.json'), 'retained v2 Visual Document', { optional: true });
  readRegularJson(visualFormatFile(metadata), 'visual format metadata', { optional: true });
  const { migratePersistedSession } = require('./legacy-visual-import.cjs');
  let result;
  try {
    result = migratePersistedSession({
      sessionDir: metadata.session_dir,
      workId: options.workId,
      workspaceKind: options.workspaceKind,
      evidenceRefs: [],
    });
  } catch (error) {
    if (String(error.message).includes(metadata.session_dir)) fail('persisted Visual Session migration failed');
    throw error;
  }
  console.log(JSON.stringify({
    type: result.reactivated ? 'visual-session-reactivated' : 'visual-session-migrated',
    active_version: result.activeVersion,
  }));
}

function backout(options) {
  const metadata = activeMetadata(options);
  readRegularJson(path.join(metadata.content_dir, 'screen.json'), 'legacy Visual Document');
  readRegularJson(path.join(metadata.content_dir, 'workspace.json'), 'retained v2 Visual Document');
  const { backoutPersistedSession } = require('./legacy-visual-import.cjs');
  let result;
  try {
    result = backoutPersistedSession({ sessionDir: metadata.session_dir });
  } catch (error) {
    if (String(error.message).includes(metadata.session_dir)) fail('persisted Visual Session backout failed');
    throw error;
  }
  console.log(JSON.stringify({ type: 'visual-session-backout', active_version: result.activeVersion }));
}

function scaffold(options) {
  if (!options.output) fail('scaffold requires --output FILE');
  if (options.workspaceKind || options.workId) {
    if (!options.workspaceKind || !options.workId) {
      fail('v2 scaffold requires --workspace-kind and --work-id');
    }
    if (options.profile || options.audience || options.summary || options.kinds) {
      fail('v2 scaffold does not accept --profile, --audience, --summary, or --kinds');
    }
    const document = createWorkspaceScaffold({
      workId: options.workId,
      workspaceKind: options.workspaceKind,
      title: options.title,
    });
    const output = path.resolve(options.output);
    atomicJsonExclusive(output, document);
    console.log(JSON.stringify({
      type: 'workspace.scaffolded',
      workspace_file: output,
      work_id: document.work_id,
      workspace_kind: document.workspace_kind,
      revision: document.revision,
    }));
    return;
  }
  const kinds = options.kinds ? options.kinds.split(',').map(value => value.trim()).filter(Boolean) : undefined;
  const document = createVisualScaffold({
    profile: options.profile,
    audience: options.audience,
    title: options.title,
    summary: options.summary,
    kinds,
  });
  const output = path.resolve(options.output);
  atomicJsonExclusive(output, document);
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
  const result = await waitForFeedback({ sessionDir: metadata.session_dir, timeoutMs });
  if (result.state === 'timeout') {
    console.log(JSON.stringify({ type: 'timeout' }));
    return;
  }
  if (result.state === 'closed') {
    console.log(JSON.stringify({ type: 'closed', reason: result.reason }));
    return;
  }
  // Same contract as drain: pending counts every unacknowledged batch, so the caller knows a
  // second batch is already queued instead of ending the review loop after one turn.
  console.log(JSON.stringify({ ...result.feedbackBatch, pending: result.pending }));
}

function reply(options) {
  if (options.message == null && !options.messageFile) {
    fail('reply requires --message TEXT or --message-file FILE');
  }
  const metadata = activeMetadata(options);
  assertLive(metadata);
  // --reply-to is optional: omitting it acknowledges the oldest unacknowledged batch (the one
  // drain/wait just served), so the ack cursor advances without the caller recomputing the seq.
  const replyTo = options.replyTo ? Number(options.replyTo) : null;
  // --message is the inline form for short replies; --message-file avoids shell escaping for long
  // or multi-line revision notes. messageFile wins if both are supplied.
  const message = options.messageFile
    ? fs.readFileSync(path.resolve(options.messageFile), 'utf8')
    : options.message;
  const record = new SessionStore(metadata.state_dir).publishAgentReply({ replyTo, message });
  console.log(JSON.stringify(record));
}

function status(options) {
  const metadata = activeMetadata(options);
  console.log(JSON.stringify({
    ...metadata,
    running: processAlive(metadata.pid),
    connection_url: sessionConnectionUrl(metadata),
  }));
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
  // Capture the standalone visual and its agent-readable sidecars before scratch cleanup
  // deletes the session directory.
  const exported = writeStandaloneExport(metadata, options.output);
  removeActiveIfMatching(metadata);
  if (!metadata.persistent && metadata.session_dir.startsWith(`${scratchRoot()}${path.sep}`)) {
    fs.rmSync(metadata.session_dir, { recursive: true, force: true });
  }
  console.log(JSON.stringify({
    type: 'visual-session-stopped',
    session_dir: metadata.session_dir,
    export_file: exported.html,
    data_file: exported.data,
    interview_file: exported.interview,
  }));
}

function exportVisual(options) {
  const metadata = activeMetadata(options);
  const exported = writeStandaloneExport(metadata, options.output);
  console.log(JSON.stringify({
    type: 'visual.exported',
    export_file: exported.html,
    data_file: exported.data,
    interview_file: exported.interview,
  }));
}

async function main() {
  const [command, ...values] = process.argv.slice(2);
  if (!command || ['help', '--help', '-h'].includes(command)) {
    console.log([
      'Usage: visual-session.cjs start [--project-dir DIR] [--host HOST] [--url-host HOST] [--quiet]',
      '       visual-session.cjs present (--draft FILE | --document FILE) [--project-dir DIR] [--host HOST] [--url-host HOST] [--quiet]',
      '       visual-session.cjs resume [--session-dir DIR] [--quiet]',
      '       visual-session.cjs validate (--draft FILE | --document FILE)',
      '       visual-session.cjs scaffold --output FILE [--profile technical|product|business] [--kinds anchor,flow,decision]',
      '       visual-session.cjs scaffold --output FILE --work-id ID --workspace-kind product|architecture|research|business|review|uml [--title TITLE]',
      '       visual-session.cjs publish (--draft FILE | --document FILE) [--session-dir DIR]',
      '       visual-session.cjs migrate --work-id ID --workspace-kind KIND [--session-dir DIR]',
      '       visual-session.cjs backout [--session-dir DIR]',
      '       visual-session.cjs drain [--session-dir DIR]',
      '       visual-session.cjs wait [--timeout-ms MS] [--session-dir DIR]',
      '       visual-session.cjs reply (--message TEXT | --message-file FILE) [--reply-to SEQ] [--session-dir DIR]',
      '       visual-session.cjs status [--session-dir DIR]',
      '       visual-session.cjs export [--output FILE] [--session-dir DIR]',
      '       visual-session.cjs stop [--output FILE] [--session-dir DIR]',
      '       visual-session.cjs sessions list [--all]',
      '       visual-session.cjs sessions archive --session-dir DIR [--output FILE]',
      '       visual-session.cjs sessions prune [--older-than-days N] [--dry-run] [--all]',
    ].join('\n'));
    return;
  }
  if (command === 'sessions') {
    const [subcommand, ...rest] = values;
    sessions(subcommand, parseOptions(rest));
    return;
  }
  const options = parseOptions(values);
  if (command === 'start') await start(options);
  else if (command === 'present') await present(options);
  else if (command === 'resume') await resume(options);
  else if (command === 'scaffold') scaffold(options);
  else if (command === 'validate') await validate(options);
  else if (command === 'publish') await publish(options);
  else if (command === 'migrate') migrate(options);
  else if (command === 'backout') backout(options);
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

module.exports = {
  activeMetadata,
  buildStandaloneHtml,
  defaultActiveFile,
  parseOptions,
  startCodexIdleDelivery,
  writeStandaloneExport,
};
