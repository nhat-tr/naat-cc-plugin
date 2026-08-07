const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EVENT_LIMIT_BYTES = 4096;
const STATE_LIMIT_BYTES = 16 * 1024;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_STALE_MS = 30_000;
const PROHIBITED_EVENT_KEYS = new Set([
  'prompt',
  'raw_prompt',
  'system_prompt',
  'transcript',
  'private_reasoning',
  'chain_of_thought',
  'environment',
  'env',
  'credentials',
  'credential',
  'capability_token',
  'authorization',
  'cookie',
  'patch',
  'diff',
  'snapshot',
  'review',
  'review_outcome',
  'verification_log',
  'stdout',
  'stderr',
]);
const SECRET_KEY = /^(?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|password|secret|client[-_]?secret|private[-_]?key|authorization|cookie)$/iu;

const { redactString } = require('./redaction');

function sanitizeValue(value, key = '', eventMode = false) {
  const normalizedKey = String(key).toLowerCase();
  if (eventMode && PROHIBITED_EVENT_KEYS.has(normalizedKey)) return undefined;
  if (SECRET_KEY.test(normalizedKey)) return '[REDACTED]';
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) {
    return value.map(item => sanitizeValue(item, '', eventMode)).filter(item => item !== undefined);
  }
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    const sanitized = sanitizeValue(childValue, childKey, eventMode);
    if (sanitized !== undefined) result[childKey] = sanitized;
  }
  return result;
}

function git(root, args, options = {}) {
  const result = childProcess.spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: options.env || process.env,
    input: options.input,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    const detail = redactString(result.stderr || result.stdout || '').trim().slice(0, 1000);
    throw new Error(`git ${args[0]} failed${detail ? `: ${detail}` : ` with status ${result.status}`}`);
  }
  return {
    status: result.status,
    stdout: options.trim === false ? result.stdout : result.stdout.trim(),
    stderr: options.trim === false ? result.stderr : result.stderr.trim(),
  };
}

function repositoryRoot(cwd = process.cwd()) {
  return path.resolve(git(cwd, ['rev-parse', '--show-toplevel']).stdout);
}

function absoluteGitPath(root, flag) {
  const modern = git(root, ['rev-parse', '--path-format=absolute', flag], { allowFailure: true });
  if (modern.status === 0 && modern.stdout) return path.resolve(modern.stdout);
  const legacy = git(root, ['rev-parse', flag]).stdout;
  return path.isAbsolute(legacy) ? path.resolve(legacy) : path.resolve(root, legacy);
}

function gitCommonDirectory(root) {
  return absoluteGitPath(root, '--git-common-dir');
}

function gitDirectory(root) {
  return absoluteGitPath(root, '--git-dir');
}

function safeSegment(value, label = 'identifier') {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`${label} is required`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(normalized)) {
    throw new Error(`${label} must use 1-128 letters, digits, dot, underscore, or hyphen characters`);
  }
  return normalized;
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`unsafe Pair directory ${directory}`);
  try { fs.chmodSync(directory, 0o700); } catch { /* Filesystem may not expose POSIX modes. */ }
}

function pairCommonDirectory(root) {
  return path.join(gitCommonDirectory(root), 'pair');
}

function currentLocatorPath(root) {
  return path.join(gitDirectory(root), 'pair-current.json');
}

// Every Work this repository has ever opened, whether running, complete, or cleaned up: the per-Work
// directory holds the journal and the review evidence and is never removed, so it outlives the worktree and
// is what any cross-Work view has to read.
function listWorkIds(root) {
  const directory = path.join(pairCommonDirectory(root), 'works');
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();
}

function workPaths(root, workId) {
  const selected = safeSegment(workId, 'Work ID');
  const pairDirectory = pairCommonDirectory(root);
  const directory = path.join(pairDirectory, 'works', selected);
  return {
    pairDirectory,
    directory,
    workId: selected,
    manifest: path.join(directory, 'review-slices.json'),
    spec: path.join(directory, 'spec.md'),
    state: path.join(directory, 'state.json'),
    events: path.join(directory, 'events.jsonl'),
    // Narration, not evidence: the running commentary of the dispatch in flight, kept as a plain file so a
    // human can watch a chained run from anywhere — `tail -f`, an editor buffer, a terminal split — without
    // depending on how whoever spawned the run treats its stderr. Deliberately separate from events.jsonl,
    // which is the append-only record every audit reads and must stay free of presentation.
    progressLog: path.join(directory, 'progress.log'),
    designChecks: path.join(directory, 'design-checks'),
    outcomes: path.join(directory, 'review-outcomes'),
    // A human review is built up one finding at a time while reading; a Review Outcome is an immutable,
    // content-addressed artifact sized for one model review. Recording each finding as its own outcome
    // minted a new id per finding and orphaned the previous, so the Review Inbox filled with duplicate
    // rows and staging one of the stale copies recorded feedback the adjudication gate could never see.
    // The draft is where findings gather before they become that single artifact.
    findingDrafts: path.join(directory, 'human-finding-drafts'),
    feedback: path.join(directory, 'review-feedback.jsonl'),
    evaluations: path.join(directory, 'evaluations'),
    lock: path.join(directory, '.lock'),
    verificationLease: path.join(directory, '.verifying'),
    // A whole dispatch, not a state write and not a suite: it spans a provider session, so it outlives the
    // mutation lock's staleness window and starts before the verification lease exists.
    dispatchLease: path.join(directory, '.dispatching'),
    // Not a lease: a lease says "someone is working", this says "a program is running and this Work owes it
    // a `down`". It is written only when the loop's own `up` ran, so the record's presence is the whole
    // answer to whether the loop may stop the instance — and it outlives the process that wrote it on
    // purpose, because a killed loop is exactly the case that leaves an instance behind.
    runtimeOwner: path.join(directory, 'runtime-owner.json'),
  };
}

// Preferences that only exist as environment variables silently do not apply to anything launched outside
// an interactive shell — an editor or launcher started from a GUI never sources a shell rc file. That made
// the same command pick a different provider, and write or not write a stream log, purely by where it was
// invoked from. This file is the launcher-independent half; the environment still wins where it is set.
// A malformed config returns nothing rather than throwing: a broken preference must not stop the loop.
function userConfig(env = process.env) {
  const home = env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), '.config');
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(home, 'pair', 'config.json'), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function atomicWrite(file, content, limit = STATE_LIMIT_BYTES) {
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > limit) throw new Error(`${path.basename(file)} exceeds ${limit} UTF-8 bytes`);
  ensurePrivateDirectory(path.dirname(file));
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temporary, content, { mode: 0o600 });
  fs.renameSync(temporary, file);
  try { fs.chmodSync(file, 0o600); } catch { /* Filesystem may not expose POSIX modes. */ }
}

function writeJson(file, value, limit = STATE_LIMIT_BYTES) {
  atomicWrite(file, `${JSON.stringify(sanitizeValue(value), null, 2)}\n`, limit);
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function acquireLock(paths) {
  ensurePrivateDirectory(paths.directory);
  const started = Date.now();
  const nonce = crypto.randomUUID();
  while (Date.now() - started < LOCK_TIMEOUT_MS) {
    try {
      fs.mkdirSync(paths.lock, { mode: 0o700 });
      fs.writeFileSync(path.join(paths.lock, 'owner.json'), `${JSON.stringify({
        pid: process.pid,
        nonce,
        at: new Date().toISOString(),
      })}\n`, { mode: 0o600 });
      return { nonce };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = readJson(path.join(paths.lock, 'owner.json'));
      const stat = fs.statSync(paths.lock, { throwIfNoEntry: false });
      const stale = !stat || Date.now() - stat.mtimeMs > LOCK_STALE_MS;
      if (stale || (owner?.pid && !processAlive(owner.pid))) {
        fs.rmSync(paths.lock, { recursive: true, force: true });
        continue;
      }
      sleep(5);
    }
  }
  throw new Error(`timed out acquiring Pair Work lock for ${paths.workId}`);
}

function releaseLock(paths, lock) {
  const owner = readJson(path.join(paths.lock, 'owner.json'));
  if (owner?.nonce === lock?.nonce) fs.rmSync(paths.lock, { recursive: true, force: true });
}

function withWorkLock(root, workId, callback) {
  const paths = workPaths(root, workId);
  const lock = acquireLock(paths);
  try { return callback(paths); } finally { releaseLock(paths, lock); }
}

// Verification is not a state mutation and cannot share the mutation lock: a suite runs for minutes
// to an hour, far past the staleness window that makes the short lock safe. It needs its own lease
// for a different reason — two suites of the same Work share one machine's containers, ports and
// databases, so running them concurrently makes a different unrelated test fail in each run. Those
// failures are indistinguishable from real ones, they cannot honestly be baselined, and the loop
// never reaches green. The lease refuses rather than queues: the caller should know it is waiting on
// a suite someone else started, not silently sit for forty minutes.
// mkdir is the atomic primitive; the owner file explains the holder, and a nonce means only the holder can
// release it. An owner whose pid is gone is abandoned rather than authoritative, so a killed process never
// wedges the Work — the one property that decides whether a lease helps or becomes its own outage.
function acquireLease(paths, directory, meta, conflict) {
  ensurePrivateDirectory(paths.directory);
  const nonce = crypto.randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(directory, { mode: 0o700 });
      fs.writeFileSync(path.join(directory, 'owner.json'), `${JSON.stringify({
        pid: process.pid,
        nonce,
        at: new Date().toISOString(),
        ...meta,
      })}\n`, { mode: 0o600 });
      return { nonce };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = readJson(path.join(directory, 'owner.json'));
      const abandoned = !owner?.pid || !processAlive(owner.pid);
      if (abandoned) {
        fs.rmSync(directory, { recursive: true, force: true });
        continue;
      }
      throw new Error(conflict(owner));
    }
  }
  throw new Error(`could not acquire a lease for ${paths.workId}`);
}

function releaseLease(directory, lease) {
  const owner = readJson(path.join(directory, 'owner.json'));
  if (owner?.nonce === lease?.nonce) fs.rmSync(directory, { recursive: true, force: true });
}

function acquireVerificationLease(paths, meta = {}) {
  return acquireLease(paths, paths.verificationLease, meta, owner =>
    `a verification of ${paths.workId} has been running since ${owner.at} (pid ${owner.pid}); concurrent suites share this machine's containers and ports, so both runs fail in unrelated places. Wait for it to finish, or stop pid ${owner.pid} first.`);
}

function releaseVerificationLease(paths, lease) {
  return releaseLease(paths.verificationLease, lease);
}

// Every lease above is keyed per Work, and the collision this one prevents is not: suites of DIFFERENT
// Works share one machine's Testcontainers Postgres, its ports and its databases, so each run fails
// somewhere unrelated to its own change. Those failures cannot be told apart from real ones and cannot
// honestly be baselined — the mechanism that fabricated the disjoint 1/71/2 failures on S-01. It therefore
// lives outside every repository, under XDG state rather than a temp directory, so it is one lock per user
// per machine no matter which repo or worktree a run is driven from. Implementation stays parallel; only
// the suites queue, and queueing here means refusing so the human knows what they are waiting on.
function machineVerificationLeasePath() {
  if (process.env.PAIR_MACHINE_LEASE_DIR) return process.env.PAIR_MACHINE_LEASE_DIR;
  const stateHome = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(stateHome, 'pair', 'verifying-machine');
}

function acquireMachineVerificationLease(workId, meta = {}) {
  const directory = machineVerificationLeasePath();
  fs.mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 });
  // Held by this same Work already: defer instead of refusing, so the per-Work lease below produces the
  // refusal. Both would be correct, but "a verification of THIS Work is already running" tells the human
  // which run to look at, and a machine-scope message about sharing containers would be a worse answer to
  // the same question. Deferring returns no nonce, so the caller releases only what it actually took.
  const owner = readJson(path.join(directory, 'owner.json'));
  if (owner?.pid && processAlive(owner.pid) && owner.work_id === workId) return { deferred: true };
  return acquireLease({ workId, directory: path.dirname(directory) }, directory, { work_id: workId, ...meta }, holder =>
    `a verification of ${holder.work_id || 'another Pair Work'} has been running on this machine since ${holder.at} (pid ${holder.pid}). Suites of different Works share this machine's Testcontainers databases and ports, so running both makes each fail somewhere unrelated to its own change. Wait for it to finish, or stop pid ${holder.pid} first.`);
}

// Refuses rather than queues: a second coding session on one worktree is never what the human wanted, and
// silently waiting minutes for the first to finish is worse than being told which process to look at.
function acquireDispatchLease(paths, meta = {}) {
  return acquireLease(paths, paths.dispatchLease, meta, owner =>
    `a dispatch of ${paths.workId} has been running since ${owner.at} (pid ${owner.pid}). Two runs share one worktree and one state file, so each would sweep the other's half-written files into its checkpoint and the loser's transition would be erased. Wait for it to finish, or stop pid ${owner.pid} first.`);
}

// The dispatch lease already records which process owns a run, so it is also the handle for controlling it
// — no second bookkeeping, and nothing to go stale. The provider is a descendant of that process, so the
// whole tree is signalled: the leaf holds the model connection, and signalling only the parent would leave
// it running and writing.
// A stopped process still answers kill(pid, 0), so `pause` produces a dispatch that is alive, holds the
// lease, and will never finish on its own. Liveness alone cannot tell those apart, and the difference is
// the whole answer to "why has nothing happened for forty minutes".
function processStopped(pid) {
  if (!processAlive(pid)) return false;
  const probe = childProcess.spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  return String(probe.stdout || '').trim().startsWith('T');
}

function dispatchOwner(root, workId) {
  const owner = readJson(path.join(workPaths(root, workId).dispatchLease, 'owner.json'));
  if (!owner?.pid || !processAlive(owner.pid)) return null;
  return { ...owner, paused: processStopped(owner.pid) };
}

// Empty pgrep output splits to [''], and Number('') is 0 — which passes Number.isInteger, so an ordinary
// childless process walked pid 0 and from there every process on the machine, until the stack gave out.
// Positive pids only, and a visited set, because a pid graph read one `pgrep` at a time is not guaranteed
// acyclic while processes are exiting and being reparented underneath the walk.
function processTree(pid, visited = new Set()) {
  const parent = Number(pid);
  if (!Number.isInteger(parent) || parent <= 1 || visited.has(parent)) return [];
  visited.add(parent);
  const children = childProcess.spawnSync('pgrep', ['-P', String(parent)], { encoding: 'utf8' });
  const direct = String(children.stdout || '')
    .split(/\s+/u)
    .map(entry => Number(entry.trim()))
    .filter(child => Number.isInteger(child) && child > 1);
  return [parent, ...direct.flatMap(child => processTree(child, visited))];
}

// Deepest first: a stopped parent cannot spawn more work while its children are being signalled, and for
// SIGTERM the leaf holding the connection should learn first so it stops writing before its parent exits.
function signalDispatch(root, workId, signal) {
  return signalDispatchTree(root, workId, signal, { includeOwner: true });
}

// An interrupt has to reach the provider alone. The dispatch owner is this loop's own bookkeeping
// process — the one that will notice the child died by signal, journal the attempt as interrupted-by-
// human, and leave the slice where a human can steer it. Signal it too and there is nobody left to write
// any of that down, which is precisely the interrupt-recorded-as-infrastructure-failure this replaces.
function signalDispatchChildren(root, workId, signal) {
  return signalDispatchTree(root, workId, signal, { includeOwner: false });
}

function signalDispatchTree(root, workId, signal, { includeOwner }) {
  const owner = dispatchOwner(root, workId);
  if (!owner) return null;
  const tree = processTree(owner.pid).filter(pid => includeOwner || pid !== owner.pid).reverse();
  const signalled = [];
  for (const pid of tree) {
    try { process.kill(pid, signal); signalled.push(pid); } catch { /* it exited while we walked the tree */ }
  }
  return { owner, signal, signalled };
}

function withDispatchLease(root, workId, meta, callback) {
  const paths = workPaths(root, workId);
  const lease = acquireDispatchLease(paths, meta);
  try { return callback(paths); } finally { releaseLease(paths.dispatchLease, lease); }
}

// Machine first, then Work, always in that order: a single acquisition order is what keeps two runs from
// each holding one lease and waiting for the other. Released in reverse, and in a finally, so a suite that
// throws cannot leave either behind.
function withVerificationLease(root, workId, meta, callback) {
  const paths = workPaths(root, workId);
  const machine = acquireMachineVerificationLease(workId, meta);
  try {
    const lease = acquireVerificationLease(paths, meta);
    try { return callback(paths); } finally { releaseVerificationLease(paths, lease); }
  } finally {
    if (!machine.deferred) releaseLease(machineVerificationLeasePath(), machine);
  }
}

function writeCurrentWork(root, value) {
  const locator = currentLocatorPath(root);
  writeJson(locator, sanitizeValue(value), 4096);
  return locator;
}

function readCurrentWork(root) {
  return readJson(currentLocatorPath(root));
}

function readEvents(root, workId) {
  const file = workPaths(root, workId).events;
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
}

function appendEvent(root, workId, event) {
  return withWorkLock(root, workId, paths => {
    const events = fs.existsSync(paths.events)
      ? fs.readFileSync(paths.events, 'utf8').split(/\r?\n/u).filter(Boolean)
      : [];
    const previous = events.length > 0 ? JSON.parse(events.at(-1)) : null;
    const candidate = sanitizeValue({
      ...event,
      event_id: event.event_id || crypto.randomUUID(),
      sequence: Number(previous?.sequence || 0) + 1,
      at: event.at || new Date().toISOString(),
      work_id: workId,
    }, '', true);
    const line = JSON.stringify(candidate);
    if (Buffer.byteLength(line, 'utf8') > EVENT_LIMIT_BYTES) {
      throw new Error(`Pair event ${event.event || 'unknown'} exceeds ${EVENT_LIMIT_BYTES} UTF-8 bytes`);
    }
    fs.appendFileSync(paths.events, `${line}\n`, { mode: 0o600 });
    return candidate;
  });
}

function writeState(root, workId, state) {
  const paths = workPaths(root, workId);
  writeJson(paths.state, state, STATE_LIMIT_BYTES);
  return state;
}

function readState(root, workId = null) {
  const selected = workId || readCurrentWork(root)?.work_id;
  if (!selected) return null;
  return readJson(workPaths(root, selected).state);
}

function assertRelativePath(value, label = 'path') {
  const normalized = String(value || '').replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new Error(`${label} must be a repository-relative path`);
  }
  return normalized;
}

function refSegment(value) {
  return safeSegment(value).replace(/\.+$/u, '').replace(/\.lock$/u, '-lock');
}

function pairRef(workId, suffix) {
  const segments = String(suffix || '').split('/').filter(Boolean).map(refSegment);
  if (segments.length === 0) throw new Error('Pair ref suffix is required');
  return `refs/pair/${refSegment(workId)}/${segments.join('/')}`;
}

function resolveObject(root, revision) {
  const result = git(root, ['rev-parse', '--verify', `${revision}^{object}`]);
  if (!/^[a-f0-9]{40,64}$/u.test(result.stdout)) throw new Error(`invalid Git object for ${revision}`);
  return result.stdout;
}

function updatePairRef(root, workId, suffix, revision) {
  const objectId = resolveObject(root, revision);
  const ref = pairRef(workId, suffix);
  git(root, ['update-ref', ref, objectId]);
  return { ref, objectId };
}

function storeJsonBlob(root, workId, suffix, value) {
  const serialized = `${JSON.stringify(sanitizeValue(value), null, 2)}\n`;
  return storeBlob(root, workId, suffix, serialized);
}

function storeBlob(root, workId, suffix, content) {
  const serialized = String(content);
  const objectId = git(root, ['hash-object', '-w', '--stdin'], { input: serialized }).stdout;
  const type = git(root, ['cat-file', '-t', objectId]).stdout;
  if (type !== 'blob') throw new Error('Pair evidence did not produce a Git blob');
  const ref = pairRef(workId, suffix);
  git(root, ['update-ref', ref, objectId]);
  return { objectId, ref, serialized };
}

function blobAtCommit(root, commit, repositoryPath) {
  const selectedPath = assertRelativePath(repositoryPath);
  const objectId = git(root, ['rev-parse', '--verify', `${commit}:${selectedPath}`]).stdout;
  const type = git(root, ['cat-file', '-t', objectId]).stdout;
  if (type !== 'blob') throw new Error(`${selectedPath} at ${commit} is not a blob`);
  return objectId;
}

module.exports = {
  EVENT_LIMIT_BYTES,
  appendEvent,
  assertRelativePath,
  atomicWrite,
  blobAtCommit,
  git,
  gitCommonDirectory,
  gitDirectory,
  currentLocatorPath,
  listWorkIds,
  pairCommonDirectory,
  pairRef,
  readCurrentWork,
  readEvents,
  readJson,
  readState,
  redactString,
  repositoryRoot,
  resolveObject,
  safeSegment,
  sanitizeValue,
  storeBlob,
  storeJsonBlob,
  updatePairRef,
  dispatchOwner,
  processAlive,
  processStopped,
  processTree,
  signalDispatch,
  signalDispatchChildren,
  userConfig,
  withDispatchLease,
  withVerificationLease,
  withWorkLock,
  workPaths,
  writeCurrentWork,
  writeJson,
  writeState,
};
