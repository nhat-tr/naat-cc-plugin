const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
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

function redactString(value) {
  return String(value)
    .replace(/\bBearer\s+[^\s,"']+/giu, 'Bearer [REDACTED]')
    .replace(/((?:--?|\b)(?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|password|secret|client[-_]?secret|private[-_]?key)(?:=|\s+))[^\s,"']+/giu, '$1[REDACTED]')
    .replace(/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{8,}|gh[oprsu]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[A-Z0-9]{12,})\b/gu, '[REDACTED]');
}

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
    designChecks: path.join(directory, 'design-checks'),
    outcomes: path.join(directory, 'review-outcomes'),
    feedback: path.join(directory, 'review-feedback.jsonl'),
    evaluations: path.join(directory, 'evaluations'),
    lock: path.join(directory, '.lock'),
  };
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
  withWorkLock,
  workPaths,
  writeCurrentWork,
  writeJson,
  writeState,
};
