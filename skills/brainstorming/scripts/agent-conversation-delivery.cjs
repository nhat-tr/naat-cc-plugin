const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { readDeliveryState, writeDeliveryState } = require('./delivery-core.cjs');

const LEDGER_VERSION = 1;
const LEDGER_FILE = 'agent-delivery-ledger.json';
const DELIVERY_STATE_FILE = 'delivery-state.json';
const DELIVERY_STATES = new Set(['queued', 'sending', 'delivered', 'acknowledged']);

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} is required`);
  return value;
}

function normalizeFeedbackBatch(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.id !== 'string' || !value.id
    || !Number.isInteger(value.seq) || value.seq <= 0
    || value.type !== 'user.turn') {
    throw new TypeError('feedbackBatch is invalid');
  }
  return value;
}

function normalizeRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('delivery request is required');
  }
  return {
    runtime: requiredString(value.runtime, 'runtime'),
    sessionId: requiredString(value.sessionId, 'sessionId'),
    conversationId: requiredString(value.conversationId, 'conversationId'),
    conversationState: typeof value.conversationState === 'string' ? value.conversationState : null,
    feedbackBatch: normalizeFeedbackBatch(value.feedbackBatch),
  };
}

function createDeliveryIdentity(value) {
  const request = normalizeRequest(value);
  const identity = JSON.stringify({
    version: 1,
    runtime: request.runtime,
    sessionId: request.sessionId,
    conversationId: request.conversationId,
    feedbackEventId: request.feedbackBatch.id,
    feedbackSeq: request.feedbackBatch.seq,
  });
  return `delivery-${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 32)}`;
}

function safeReason(value, fallback = 'delivery unavailable') {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_. -]{1,96}$/.test(value)) return fallback;
  return value.replaceAll('_', ' ');
}

function assertStateDirectory(stateDir) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(stateDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('delivery state directory must be a non-symlink directory');
  }
  fs.chmodSync(stateDir, 0o700);
}

function defaultLedger() {
  return { version: LEDGER_VERSION, deliveries: [] };
}

function normalizeRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.deliveryId !== 'string' || !value.deliveryId
    || typeof value.runtime !== 'string' || !value.runtime
    || typeof value.sessionId !== 'string' || !value.sessionId
    || typeof value.conversationId !== 'string' || !value.conversationId
    || (value.conversationState !== null && typeof value.conversationState !== 'string')
    || typeof value.feedbackEventId !== 'string' || !value.feedbackEventId
    || !Number.isInteger(value.feedbackSeq) || value.feedbackSeq <= 0
    || !DELIVERY_STATES.has(value.state)
    || (value.reason !== null && typeof value.reason !== 'string')
    || !Number.isInteger(value.createdAt) || value.createdAt < 0
    || !Number.isInteger(value.updatedAt) || value.updatedAt < value.createdAt) {
    throw new Error('agent delivery ledger is invalid');
  }
  return { ...value };
}

function normalizeLedger(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.version !== LEDGER_VERSION || !Array.isArray(value.deliveries)
    || Object.keys(value).some(key => !['version', 'deliveries'].includes(key))) {
    throw new Error('agent delivery ledger is invalid');
  }
  const deliveries = value.deliveries.map(normalizeRecord);
  if (new Set(deliveries.map(record => record.deliveryId)).size !== deliveries.length) {
    throw new Error('agent delivery ledger is invalid');
  }
  return { version: LEDGER_VERSION, deliveries };
}

function readRegularJson(file) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('agent delivery ledger could not be read');
  }
  try {
    if (!fs.fstatSync(descriptor).isFile()) throw new Error('agent delivery ledger is invalid');
    return JSON.parse(fs.readFileSync(descriptor, 'utf8'));
  } catch {
    throw new Error('agent delivery ledger is invalid');
  } finally {
    fs.closeSync(descriptor);
  }
}

function writeAtomicJson(file, value) {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function abortError() {
  const error = new Error('agent delivery worker closed');
  error.name = 'AbortError';
  return error;
}

function waitForStateChange(stateDir, signal, timeoutMs = 250) {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    let watcher;
    let timer;
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      if (timer) clearTimeout(timer);
      try { watcher?.close(); } catch { /* already closed */ }
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => finish(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      watcher = fs.watch(stateDir, () => finish());
      watcher.once('error', () => finish());
    } catch {
      watcher = null;
    }
    timer = setTimeout(() => finish(), timeoutMs);
    timer.unref?.();
  });
}

class AgentConversationDelivery {
  constructor(options = {}) {
    this.adapters = options.adapters || {};
    this.sessionStore = options.sessionStore || null;
    this.stateDir = options.stateDir
      ? path.resolve(options.stateDir)
      : (this.sessionStore?.stateDir ? path.resolve(this.sessionStore.stateDir) : null);
    this.now = options.now || Date.now;
    this.memoryLedger = defaultLedger();
    this.requests = new Map();
    this.operationTail = Promise.resolve();
    if (this.stateDir) {
      assertStateDirectory(this.stateDir);
      this.ledgerFile = path.join(this.stateDir, LEDGER_FILE);
      this.deliveryStateFile = path.join(this.stateDir, DELIVERY_STATE_FILE);
    } else {
      this.ledgerFile = null;
      this.deliveryStateFile = null;
    }
  }

  _serialize(action) {
    const operation = this.operationTail.then(action, action);
    this.operationTail = operation.catch(() => {});
    return operation;
  }

  _readLedger() {
    if (!this.ledgerFile) return structuredClone(this.memoryLedger);
    const value = readRegularJson(this.ledgerFile);
    return value == null ? defaultLedger() : normalizeLedger(value);
  }

  _writeLedger(ledger) {
    const normalized = normalizeLedger(ledger);
    if (!this.ledgerFile) {
      this.memoryLedger = structuredClone(normalized);
      return;
    }
    writeAtomicJson(this.ledgerFile, normalized);
  }

  _ensureEvidence(deliveredThrough = null) {
    if (!this.deliveryStateFile) return;
    const current = readDeliveryState(this.deliveryStateFile);
    writeDeliveryState(this.deliveryStateFile, {
      listening: current.listening,
      deliveredThrough: deliveredThrough == null
        ? current.deliveredThrough
        : Math.max(current.deliveredThrough, deliveredThrough),
    });
  }

  _findRecord(deliveryId) {
    return this._readLedger().deliveries.find(record => record.deliveryId === deliveryId) || null;
  }

  _upsert(request, deliveryId, state, reason = null) {
    const ledger = this._readLedger();
    const index = ledger.deliveries.findIndex(record => record.deliveryId === deliveryId);
    const timestamp = Math.trunc(this.now());
    const current = index >= 0 ? ledger.deliveries[index] : null;
    const record = {
      deliveryId,
      runtime: request.runtime,
      sessionId: request.sessionId,
      conversationId: request.conversationId,
      conversationState: request.conversationState,
      feedbackEventId: request.feedbackBatch.id,
      feedbackSeq: request.feedbackBatch.seq,
      state,
      reason,
      createdAt: current?.createdAt ?? timestamp,
      updatedAt: Math.max(current?.updatedAt ?? timestamp, timestamp),
    };
    if (index >= 0) ledger.deliveries[index] = record;
    else ledger.deliveries.push(record);
    ledger.deliveries.sort((left, right) => left.feedbackSeq - right.feedbackSeq
      || left.deliveryId.localeCompare(right.deliveryId));
    this._writeLedger(ledger);
    return record;
  }

  _requestForRecord(record) {
    const remembered = this.requests.get(record.deliveryId);
    if (remembered) return remembered;
    if (!this.sessionStore) throw new Error('queued delivery cannot be reconstructed');
    const feedbackBatch = this.sessionStore.readEvents().find(event => (
      event.type === 'user.turn'
      && event.seq === record.feedbackSeq
      && event.id === record.feedbackEventId
    ));
    if (!feedbackBatch) throw new Error('queued delivery cannot be reconstructed');
    return {
      runtime: record.runtime,
      sessionId: record.sessionId,
      conversationId: record.conversationId,
      conversationState: record.conversationState,
      feedbackBatch,
    };
  }

  async _attempt(requestValue, options = {}) {
    const request = normalizeRequest(requestValue);
    const deliveryId = createDeliveryIdentity(request);
    this.requests.set(deliveryId, request);
    const existing = this._findRecord(deliveryId);
    if (!options.replay && (existing?.state === 'delivered' || existing?.state === 'acknowledged')) {
      return { state: 'delivered', deliveryId, reason: null };
    }
    const adapter = this.adapters[request.runtime];
    if (!adapter || typeof adapter.deliver !== 'function') {
      this._upsert(request, deliveryId, 'queued', 'delivery adapter unavailable');
      this._ensureEvidence();
      return { state: 'queued', deliveryId, reason: 'delivery adapter unavailable' };
    }
    let capability;
    try {
      capability = typeof adapter.capability === 'function'
        ? await adapter.capability(request)
        : { supported: true, reason: null };
    } catch {
      capability = { supported: false, reason: 'delivery adapter unavailable' };
    }
    if (!capability?.supported) {
      const reason = safeReason(capability?.reason, 'delivery adapter unavailable');
      this._upsert(request, deliveryId, 'queued', reason);
      this._ensureEvidence();
      return { state: 'queued', deliveryId, reason };
    }
    this._upsert(request, deliveryId, 'sending', null);
    try {
      const result = await adapter.deliver({ ...request, deliveryId });
      if (result?.state !== 'delivered') {
        const reason = safeReason(result?.reason, 'delivery adapter unavailable');
        this._upsert(request, deliveryId, 'queued', reason);
        this._ensureEvidence();
        return { state: 'queued', deliveryId, reason };
      }
      this._upsert(request, deliveryId, 'delivered', null);
      this._ensureEvidence(request.feedbackBatch.seq);
      return { state: 'delivered', deliveryId, reason: null };
    } catch {
      const reason = 'delivery adapter unavailable';
      this._upsert(request, deliveryId, 'queued', reason);
      this._ensureEvidence();
      return { state: 'queued', deliveryId, reason };
    }
  }

  deliver(request) {
    return this._serialize(() => this._attempt(request));
  }

  flush(options = {}) {
    return this._serialize(async () => {
      const runtime = requiredString(options.runtime, 'runtime');
      const queued = this._readLedger().deliveries
        .filter(record => record.runtime === runtime && record.state === 'queued')
        .sort((left, right) => left.feedbackSeq - right.feedbackSeq);
      let delivered = 0;
      for (const record of queued) {
        const result = await this._attempt(this._requestForRecord(record));
        if (result.state === 'delivered') delivered += 1;
      }
      return { delivered };
    });
  }

  replayUnacknowledged(options = {}) {
    return this._serialize(async () => {
      const runtime = requiredString(options.runtime, 'runtime');
      const cursor = this.sessionStore?.readCursor() ?? 0;
      const record = this._readLedger().deliveries
        .filter(value => value.runtime === runtime
          && value.state === 'delivered'
          && value.feedbackSeq > cursor)
        .sort((left, right) => left.feedbackSeq - right.feedbackSeq)[0];
      if (!record) return { delivered: 0 };
      const result = await this._attempt(this._requestForRecord(record), { replay: true });
      return { delivered: result.state === 'delivered' ? 1 : 0 };
    });
  }

  ackFeedback(value) {
    return this._serialize(async () => {
      const deliveryId = requiredString(value?.deliveryId, 'deliveryId');
      const message = requiredString(value?.message, 'message');
      const record = this._findRecord(deliveryId);
      if (!record) throw new Error('delivery acknowledgement is unknown');
      if (!['delivered', 'acknowledged'].includes(record.state)) {
        throw new Error(`delivery acknowledgement is not allowed while ${record.state}`);
      }
      if (!this.sessionStore) throw new Error('delivery acknowledgement has no Session Store');
      const oldest = this.sessionStore.nextUnacknowledgedTurn();
      if (record.state === 'delivered' && oldest?.seq !== record.feedbackSeq) {
        throw new Error('delivery acknowledgement is out of order');
      }
      const reply = this.sessionStore.publishAgentReply({ replyTo: record.feedbackSeq, message });
      const request = this._requestForRecord(record);
      this._upsert(request, deliveryId, 'acknowledged', null);
      return reply;
    });
  }

  async startWorker(options = {}) {
    if (!this.sessionStore) throw new Error('delivery worker requires a Session Store');
    const runtime = requiredString(options.runtime, 'runtime');
    const sessionId = requiredString(options.sessionId, 'sessionId');
    const conversationId = requiredString(options.conversationId, 'conversationId');
    const conversationState = options.conversationState;
    const controller = new AbortController();
    let observedSeq = null;
    let reconciliationMs = 250;
    const loop = (async () => {
      while (!controller.signal.aborted) {
        let feedbackBatch = this.sessionStore.nextUnacknowledgedTurn();
        if (!feedbackBatch) {
          try {
            feedbackBatch = await this.sessionStore.waitForUnacknowledgedTurn({
              timeoutMs: 250,
              signal: controller.signal,
            });
          } catch (error) {
            if (error?.name === 'AbortError') break;
            throw error;
          }
        }
        if (controller.signal.aborted) break;
        if (feedbackBatch && feedbackBatch.seq !== observedSeq) {
          const state = typeof conversationState === 'function'
            ? await conversationState()
            : conversationState;
          const result = await this.deliver({
            runtime,
            sessionId,
            conversationId,
            conversationState: typeof state === 'string' ? state : null,
            feedbackBatch,
          });
          observedSeq = result.state === 'delivered' ? feedbackBatch.seq : null;
          reconciliationMs = result.state === 'delivered' ? 250 : 1_000;
        }
        try {
          await waitForStateChange(this.sessionStore.stateDir, controller.signal, reconciliationMs);
        } catch (error) {
          if (error?.name === 'AbortError') break;
          throw error;
        }
        if (observedSeq != null && this.sessionStore.readCursor() >= observedSeq) observedSeq = null;
      }
    })().catch(() => {});
    let closed = false;
    return {
      close: async () => {
        if (closed) return;
        closed = true;
        controller.abort();
        await loop;
      },
    };
  }
}

module.exports = {
  AgentConversationDelivery,
  createDeliveryIdentity,
};
