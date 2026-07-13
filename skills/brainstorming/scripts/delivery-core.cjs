const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { SessionStore } = require('./session-store.cjs');

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1_000;
const DELIVERY_LOCK_STALE_MS = 10_000;

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function requireSessionDir(value) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('sessionDir is required');
  return path.resolve(value);
}

function requireRegularDirectory(directory, label) {
  let descriptor;
  try {
    descriptor = fs.openSync(directory, fs.constants.O_RDONLY
      | (fs.constants.O_DIRECTORY || 0)
      | (fs.constants.O_NOFOLLOW || 0));
  } catch {
    throw new Error(`${label} must be an existing non-symlink directory`);
  }
  try {
    if (!fs.fstatSync(descriptor).isDirectory()) {
      throw new Error(`${label} must be an existing non-symlink directory`);
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function abortError() {
  const error = new Error('Visual Session Wait was aborted');
  error.name = 'AbortError';
  return error;
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

function readRegularText(file, label, optional = false) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    throw new Error(`${label} could not be read`);
  }
  try {
    if (!fs.fstatSync(descriptor).isFile()) throw new Error(`${label} must be a regular file`);
    return fs.readFileSync(descriptor, 'utf8');
  } finally {
    fs.closeSync(descriptor);
  }
}

function readDeliveryState(file) {
  const contents = readRegularText(file, 'delivery state metadata', true);
  if (contents == null) return { version: 1, listening: false, deliveredThrough: 0 };
  let value;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new Error('delivery state metadata is invalid');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.version !== 1
    || typeof value.listening !== 'boolean'
    || !Number.isInteger(value.deliveredThrough)
    || value.deliveredThrough < 0
    || Object.keys(value).some(key => !['version', 'listening', 'deliveredThrough'].includes(key))) {
    throw new Error('delivery state metadata is invalid');
  }
  return value;
}

function writeDeliveryState(file, value) {
  const lockDir = `${file}.lock`;
  const deadline = Date.now() + 2_000;
  while (true) {
    try {
      fs.mkdirSync(lockDir);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - fs.statSync(lockDir).mtimeMs > DELIVERY_LOCK_STALE_MS) {
          fs.rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch (statError) {
        if (statError.code === 'ENOENT') continue;
        throw statError;
      }
      if (Date.now() >= deadline) throw new Error('timed out waiting for delivery state lock');
      sleep(10);
    }
  }
  try {
    const current = readDeliveryState(file);
    const normalized = {
      version: 1,
      listening: value.listening,
      deliveredThrough: Math.max(current.deliveredThrough, value.deliveredThrough),
    };
    const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(normalized)}\n`, { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, file);
      fs.chmodSync(file, 0o600);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    return normalized;
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

function closedReason(stateDir) {
  if (readRegularText(path.join(stateDir, 'server-stopped'), 'Visual Session stop marker', true) != null) {
    return 'Visual Session server closed';
  }

  const serverInfo = readRegularText(path.join(stateDir, 'server-info'), 'Visual Session server metadata', true);
  if (serverInfo == null) return 'Visual Session server is unavailable';
  try {
    const parsed = JSON.parse(serverInfo);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || parsed.type !== 'server-started'
      || !Number.isInteger(parsed.port) || parsed.port < 1 || parsed.port > 65_535
      || typeof parsed.base_path !== 'string'
      || !/^\/session\/[a-zA-Z0-9_-]{8,128}\/$/.test(parsed.base_path)) {
      return 'Visual Session server is unavailable';
    }
  } catch {
    return 'Visual Session server is unavailable';
  }

  const pidText = readRegularText(path.join(stateDir, 'server.pid'), 'Visual Session process metadata', true);
  if (pidText == null) return null;
  const normalizedPid = pidText.trim();
  if (!/^\d+$/.test(normalizedPid) || !processAlive(Number(normalizedPid))) {
    return 'Visual Session server process exited';
  }
  return null;
}

async function waitForFeedback(options = {}) {
  const sessionDir = requireSessionDir(options.sessionDir);
  const stateDir = path.join(sessionDir, 'state');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0) {
    throw new TypeError('timeoutMs must be a non-negative integer');
  }
  const signal = options.signal;
  if (signal != null
    && (typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) {
    throw new TypeError('signal must be an AbortSignal');
  }
  if (signal?.aborted) throw abortError();
  requireRegularDirectory(sessionDir, 'Visual Session directory');
  requireRegularDirectory(stateDir, 'Visual Session state directory');

  const stateFile = path.join(stateDir, 'delivery-state.json');
  const store = new SessionStore(stateDir);
  let evidence = readDeliveryState(stateFile);
  const persist = (listening, deliveredThrough = evidence.deliveredThrough) => {
    evidence = writeDeliveryState(stateFile, {
      listening,
      deliveredThrough: Math.max(evidence.deliveredThrough, deliveredThrough),
    });
  };

  const initialBatch = store.nextUnacknowledgedTurn();
  if (initialBatch) {
    persist(false, initialBatch.seq);
    return {
      state: 'delivered',
      feedbackBatch: initialBatch,
      pending: store.snapshot().pendingTurns,
      reason: null,
    };
  }
  const initialClosedReason = closedReason(stateDir);
  if (initialClosedReason) {
    persist(false);
    return {
      state: 'closed',
      feedbackBatch: null,
      pending: store.snapshot().pendingTurns,
      reason: initialClosedReason,
    };
  }

  persist(true);
  try {
    const feedbackBatch = await store.waitForUnacknowledgedTurn({
      timeoutMs,
      signal,
      isClosed: () => closedReason(stateDir) !== null,
    });
    if (feedbackBatch) {
      persist(false, feedbackBatch.seq);
      return {
        state: 'delivered',
        feedbackBatch,
        pending: store.snapshot().pendingTurns,
        reason: null,
      };
    }
    persist(false);
    return {
      state: 'timeout',
      feedbackBatch: null,
      pending: store.snapshot().pendingTurns,
      reason: null,
    };
  } catch (error) {
    persist(false);
    if (error?.code === 'VISUAL_SESSION_CLOSED') {
      return {
        state: 'closed',
        feedbackBatch: null,
        pending: store.snapshot().pendingTurns,
        reason: closedReason(stateDir) || 'Visual Session server closed',
      };
    }
    throw error;
  }
}

module.exports = {
  readDeliveryState,
  writeDeliveryState,
  waitForFeedback,
};
