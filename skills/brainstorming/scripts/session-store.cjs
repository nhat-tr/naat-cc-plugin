const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MAX_MESSAGE_LENGTH = 10_000;
const MAX_COMMENT_LENGTH = 4_000;
const MAX_ITEMS = 50;
const LOCK_STALE_MS = 30_000;

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function optionalText(value, maximum, label) {
  if (value == null) return '';
  if (typeof value !== 'string') throw new TypeError(`${label} must be text`);
  const normalized = value.trim();
  if (normalized.length > maximum) {
    throw new RangeError(`${label} must be at most ${maximum.toLocaleString('en-US')} characters`);
  }
  return normalized;
}

function normalizeTarget(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('annotation target must be an object');
  }
  const componentId = optionalText(value.componentId, 200, 'componentId');
  const selector = optionalText(value.selector, 1_000, 'selector');
  const label = optionalText(value.label, 500, 'target label');
  if (!componentId && !selector) {
    throw new TypeError('annotation target must include componentId or selector');
  }
  return { componentId: componentId || null, selector: selector || null, label: label || componentId || selector };
}

function normalizeAnnotations(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new TypeError('annotations must be an array');
  if (value.length > MAX_ITEMS) throw new RangeError(`annotations must contain at most ${MAX_ITEMS} items`);
  return value.map((annotation, index) => {
    if (!annotation || typeof annotation !== 'object' || Array.isArray(annotation)) {
      throw new TypeError(`annotation ${index + 1} must be an object`);
    }
    const comment = optionalText(annotation.comment, MAX_COMMENT_LENGTH, `annotation ${index + 1} comment`);
    if (!comment) throw new TypeError(`annotation ${index + 1} comment is required`);
    return {
      id: optionalText(annotation.id, 200, `annotation ${index + 1} id`) || crypto.randomUUID(),
      comment,
      target: normalizeTarget(annotation.target),
    };
  });
}

function normalizeChoices(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new TypeError('choices must be an array');
  if (value.length > MAX_ITEMS) throw new RangeError(`choices must contain at most ${MAX_ITEMS} items`);
  return value.map((choice, index) => {
    if (!choice || typeof choice !== 'object' || Array.isArray(choice)) {
      throw new TypeError(`choice ${index + 1} must be an object`);
    }
    const componentId = optionalText(choice.componentId, 200, `choice ${index + 1} componentId`);
    const groupId = optionalText(choice.groupId, 200, `choice ${index + 1} groupId`);
    const selectedValue = optionalText(choice.value, 500, `choice ${index + 1} value`);
    if (!selectedValue) throw new TypeError(`choice ${index + 1} value is required`);
    return {
      groupId: groupId || null,
      componentId: componentId || null,
      value: selectedValue,
      label: optionalText(choice.label, 500, `choice ${index + 1} label`) || selectedValue,
    };
  });
}

function normalizeScreen(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('screen must be an object');
  const id = optionalText(value.id, 200, 'screen id');
  const file = optionalText(value.file, 500, 'screen file');
  const revision = optionalText(value.revision, 200, 'screen revision');
  return id || file || revision
    ? { id: id || null, file: file || null, revision: revision || null }
    : null;
}

function normalizeBrowserTurn(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('browser turn must be an object');
  }
  const message = optionalText(value.message, MAX_MESSAGE_LENGTH, 'message');
  const annotations = normalizeAnnotations(value.annotations);
  const choices = normalizeChoices(value.choices);
  if (!message && annotations.length === 0 && choices.length === 0) {
    throw new TypeError('browser turn must include a message, annotation, or choice');
  }
  return {
    type: 'user.turn',
    role: 'user',
    clientTurnId: optionalText(value.clientTurnId, 200, 'clientTurnId') || null,
    message,
    annotations,
    choices,
    screen: normalizeScreen(value.screen),
  };
}

class SessionStore {
  constructor(stateDir, options = {}) {
    if (!stateDir) throw new TypeError('stateDir is required');
    this.stateDir = path.resolve(stateDir);
    this.eventsFile = path.join(this.stateDir, 'session.jsonl');
    this.cursorFile = path.join(this.stateDir, 'agent-cursor.json');
    this.lockDir = path.join(this.stateDir, '.session.lock');
    this.now = options.now || Date.now;
    this.randomUUID = options.randomUUID || crypto.randomUUID;
    this.lockTimeoutMs = options.lockTimeoutMs || 2_000;
    fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
  }

  _withLock(action) {
    const deadline = Date.now() + this.lockTimeoutMs;
    while (true) {
      try {
        fs.mkdirSync(this.lockDir);
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        try {
          const age = Date.now() - fs.statSync(this.lockDir).mtimeMs;
          if (age > LOCK_STALE_MS) {
            fs.rmSync(this.lockDir, { recursive: true, force: true });
            continue;
          }
        } catch (statError) {
          if (statError.code !== 'ENOENT') throw statError;
          continue;
        }
        if (Date.now() >= deadline) throw new Error('timed out waiting for the brainstorming session lock');
        sleep(10);
      }
    }
    try {
      return action();
    } finally {
      fs.rmSync(this.lockDir, { recursive: true, force: true });
    }
  }

  _readEvents() {
    if (!fs.existsSync(this.eventsFile)) return [];
    const lines = fs.readFileSync(this.eventsFile, 'utf8').split(/\r?\n/).filter(Boolean);
    const events = [];
    lines.forEach((line, index) => {
      try {
        events.push(JSON.parse(line));
      } catch (error) {
        // A crash or full disk can truncate the final append; skip the unparsable
        // line so a single bad record never bricks the whole session.
        console.error(`brainstorm: skipping unparsable session event at line ${index + 1}: ${error.message}`);
      }
    });
    return events;
  }

  _appendUnlocked(payload, events = this._readEvents()) {
    const record = {
      version: 1,
      id: this.randomUUID(),
      seq: (events.at(-1)?.seq || 0) + 1,
      timestamp: this.now(),
      ...payload,
    };
    fs.appendFileSync(this.eventsFile, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
    return record;
  }

  appendBrowserTurn(value) {
    const normalized = normalizeBrowserTurn(value);
    if (!normalized.clientTurnId) normalized.clientTurnId = this.randomUUID();
    return this._withLock(() => {
      const events = this._readEvents();
      const existing = events.find(event => event.type === 'user.turn'
        && event.clientTurnId === normalized.clientTurnId);
      return existing || this._appendUnlocked(normalized, events);
    });
  }

  readEvents() {
    return this._withLock(() => this._readEvents());
  }

  _readCursorUnlocked() {
    if (!fs.existsSync(this.cursorFile)) return 0;
    const parsed = JSON.parse(fs.readFileSync(this.cursorFile, 'utf8'));
    return Number.isInteger(parsed.seq) && parsed.seq >= 0 ? parsed.seq : 0;
  }

  readCursor() {
    return this._withLock(() => this._readCursorUnlocked());
  }

  _acknowledgeThroughUnlocked(seq) {
    const current = this._readCursorUnlocked();
    const next = Math.max(current, seq);
    const temporary = `${this.cursorFile}.${process.pid}.${this.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify({ seq: next, timestamp: this.now() })}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.cursorFile);
    return next;
  }

  acknowledgeThrough(seq) {
    if (!Number.isInteger(seq) || seq < 0) throw new TypeError('acknowledgement seq must be a non-negative integer');
    return this._withLock(() => this._acknowledgeThroughUnlocked(seq));
  }

  nextUnacknowledgedTurn() {
    return this._withLock(() => {
      const cursor = this._readCursorUnlocked();
      return this._readEvents().find(event => event.type === 'user.turn' && event.seq > cursor) || null;
    });
  }

  waitForUnacknowledgedTurn(options = {}) {
    const timeoutMs = options.timeoutMs ?? 15 * 60 * 1_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0) {
      throw new TypeError('timeoutMs must be a non-negative integer');
    }
    const existing = this.nextUnacknowledgedTurn();
    if (existing || timeoutMs === 0) return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
      let settled = false;
      let watcher;
      let timeout;

      const finish = (error, turn = null) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        watcher?.close();
        if (error) reject(error);
        else resolve(turn);
      };

      const check = () => {
        try {
          const turn = this.nextUnacknowledgedTurn();
          if (turn) finish(null, turn);
        } catch (error) {
          finish(error);
        }
      };

      try {
        watcher = fs.watch(this.stateDir, (_eventType, filename) => {
          if (!['session.jsonl', 'agent-cursor.json'].includes(String(filename))) return;
          setImmediate(check);
        });
        watcher.on('error', error => finish(error));
      } catch (error) {
        finish(error);
        return;
      }

      timeout = setTimeout(() => finish(null, null), timeoutMs);
      timeout.unref?.();
      check();
    });
  }

  publishAgentReply({ replyTo, message }) {
    if (!Number.isInteger(replyTo) || replyTo <= 0) throw new TypeError('replyTo must be a positive event sequence');
    const normalizedMessage = optionalText(message, MAX_MESSAGE_LENGTH, 'agent message');
    if (!normalizedMessage) throw new TypeError('agent message is required');
    return this._withLock(() => {
      const events = this._readEvents();
      const target = events.find(event => event.type === 'user.turn' && event.seq === replyTo);
      if (!target) throw new Error(`browser turn ${replyTo} does not exist`);
      const existing = events.find(event => event.type === 'agent.message' && event.replyTo === replyTo);
      const reply = existing || this._appendUnlocked({
        type: 'agent.message',
        role: 'agent',
        replyTo,
        message: normalizedMessage,
      }, events);
      this._acknowledgeThroughUnlocked(replyTo);
      return reply;
    });
  }

  snapshot() {
    return this._withLock(() => {
      const events = this._readEvents();
      const cursor = this._readCursorUnlocked();
      return {
        version: 1,
        cursor,
        pendingTurns: events.filter(event => event.type === 'user.turn' && event.seq > cursor).length,
        events,
      };
    });
  }
}

module.exports = {
  MAX_MESSAGE_LENGTH,
  SessionStore,
  normalizeBrowserTurn,
};
