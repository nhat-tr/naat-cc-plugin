const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createBrainstormServer } = require('./server.cjs');
const { readDeliveryState, waitForFeedback } = require('./delivery-core.cjs');
const { SessionStore } = require('./session-store.cjs');
const { renderStandalone } = require('./standalone.cjs');
const { createVisualScaffold, normalizeVisualDocument } = require('./visual-document.cjs');
const { createWorkspaceScaffold } = require('./workspace-scaffold.cjs');

const SHELL_DIR = path.resolve(__dirname, '../assets/visual-shell');
const KNOWN_OPTIONS = new Set([
  'projectDir', 'host', 'urlHost', 'port', 'ownerPid', 'output', 'profile', 'audience',
  'title', 'summary', 'kinds', 'document', 'sessionDir', 'timeoutMs', 'replyTo', 'messageFile',
  'workId', 'workspaceKind', 'draft',
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
function buildStandaloneHtml(screen, session) {
  return renderStandalone({
    shell: fs.readFileSync(path.join(SHELL_DIR, 'index.html'), 'utf8'),
    styles: fs.readFileSync(path.join(SHELL_DIR, 'styles.css'), 'utf8'),
    script: fs.readFileSync(path.join(SHELL_DIR, 'app.js'), 'utf8'),
    worker: fs.readFileSync(path.join(SHELL_DIR, 'elk-worker.min.js'), 'utf8'),
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
  const format = readVisualFormat(metadata);
  const activeFile = format?.active_version === 2
    ? path.join(metadata.content_dir, 'workspace.json')
    : path.join(metadata.content_dir, 'screen.json');
  const screen = readScreenOrWaiting(activeFile, { required: format != null });
  const session = readSessionSnapshot(metadata.state_dir);
  const output = path.resolve(outputOption || defaultExportPath(metadata));
  atomicWrite(output, buildStandaloneHtml(screen, session));
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
  const idleDelivery = await startCodexIdleDelivery({
    sessionStore: app.store,
    stateDir: info.state_dir,
    sessionId,
  });
  const activeFilePath = initialDocument
    ? path.join(info.screen_dir, 'workspace.json')
    : path.join(info.screen_dir, 'screen.json');
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
        automatic: idleDelivery ? 'codex_idle_worker' : 'not_probed',
        fallback: 'cli_foreground',
        wait_receiver: deliveryState.listening ? 'listening' : 'not_listening',
      },
      next_action: 'Open connection_url, then keep one wait_for_feedback call or one foreground CLI wait active.',
    } : {}),
  }));

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

async function publish(options) {
  if (Boolean(options.document) === Boolean(options.draft)) {
    fail('publish requires exactly one of --document FILE or --draft FILE');
  }
  const metadata = activeMetadata(options);
  assertLive(metadata);
  const source = path.resolve(options.draft || options.document);
  const document = options.draft
    ? require('./architecture-draft.cjs').compileArchitectureDraft(
      readRegularJson(source, 'Architecture Draft'),
    )
    : normalizeAuthoredDocument(readRegularJson(source, 'Visual Document candidate'));
  const roundTrip = normalizeDocument(document);
  if (JSON.stringify(roundTrip) !== JSON.stringify(document)) {
    fail('visual document normalization is not stable; screen was not replaced');
  }
  const { preflightWorkspaceDocument } = require('./workspace-render-preflight.cjs');
  await preflightWorkspaceDocument(document);
  const { withVisualStateLock } = require('./legacy-visual-import.cjs');
  const output = withVisualStateLock(metadata.session_dir, () => {
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
    return destination;
  });
  console.log(JSON.stringify({ type: 'screen.published', screen_file: output }));
}

async function present(options) {
  if (Boolean(options.document) === Boolean(options.draft)) {
    fail('present requires exactly one of --document FILE or --draft FILE');
  }
  let document;
  if (options.draft) {
    const { compileArchitectureDraft } = require('./architecture-draft.cjs');
    document = compileArchitectureDraft(readRegularJson(path.resolve(options.draft), 'Architecture Draft'));
  } else {
    document = normalizeAuthoredDocument(
      readRegularJson(path.resolve(options.document), 'Visual Document candidate'),
    );
  }
  if (document.version !== 2) fail('present accepts only Visual Document v2 or an Architecture Draft');
  const { preflightWorkspaceDocument } = require('./workspace-render-preflight.cjs');
  const elkPreflight = await preflightWorkspaceDocument(document);
  await start({ ...options, initialDocument: document, elkPreflight });
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
  // Capture the standalone visual before scratch cleanup deletes the session directory.
  const exportFile = writeStandaloneExport(metadata, options.output);
  removeActiveIfMatching(metadata);
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
      '       visual-session.cjs present (--draft FILE | --document FILE) [--project-dir DIR] [--host HOST] [--url-host HOST]',
      '       visual-session.cjs scaffold --output FILE [--profile technical|product|business] [--kinds anchor,flow,decision]',
      '       visual-session.cjs scaffold --output FILE --work-id ID --workspace-kind product|architecture|research|business|review [--title TITLE]',
      '       visual-session.cjs publish (--draft FILE | --document FILE) [--session-dir DIR]',
      '       visual-session.cjs migrate --work-id ID --workspace-kind KIND [--session-dir DIR]',
      '       visual-session.cjs backout [--session-dir DIR]',
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
  else if (command === 'present') await present(options);
  else if (command === 'scaffold') scaffold(options);
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
