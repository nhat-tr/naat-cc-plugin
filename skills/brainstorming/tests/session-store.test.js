const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { SessionStore } = require('../scripts/session-store.cjs');
const { createScratchDirectory } = require('./test-support');

function browserTurn(overrides = {}) {
  return {
    type: 'user.turn',
    message: 'Use WebSocket instead of long polling.',
    annotations: [{
      id: 'note-1',
      comment: 'This boundary should stream updates.',
      target: {
        componentId: 'transport-option',
        label: 'Long-poll API',
        selector: '[data-brainstorm-id="transport-option"]',
      },
    }],
    choices: [{ groupId: 'session-store', componentId: 'store-option', value: 'sqlite', label: 'SQLite' }],
    screen: { id: 'technical-plan', file: 'technical-plan.html' },
    ...overrides,
  };
}

class FakeWatcher extends EventEmitter {
  constructor(onChange) {
    super();
    this.onChange = onChange;
    this.closeCount = 0;
  }

  change(filename, eventType = 'change') {
    this.onChange(eventType, filename);
  }

  close() {
    this.closeCount += 1;
  }
}

class ManualScheduler {
  constructor() {
    this.nextId = 1;
    this.timeouts = new Map();
    this.immediates = new Map();
  }

  setTimeout = (callback, delay) => {
    const handle = { id: this.nextId++, unref() {} };
    this.timeouts.set(handle, { callback, delay });
    return handle;
  };

  clearTimeout = handle => {
    this.timeouts.delete(handle);
  };

  setImmediate = callback => {
    const handle = { id: this.nextId++ };
    this.immediates.set(handle, callback);
    return handle;
  };

  clearImmediate = handle => {
    this.immediates.delete(handle);
  };

  runImmediate() {
    const entry = this.immediates.entries().next().value;
    assert.ok(entry, 'expected a scheduled immediate reconciliation');
    const [handle, callback] = entry;
    this.immediates.delete(handle);
    callback();
  }

  runTimeout(delay) {
    const entry = [...this.timeouts.entries()].find(([, timer]) => timer.delay === delay);
    assert.ok(entry, `expected a ${delay}ms timer`);
    const [handle, timer] = entry;
    this.timeouts.delete(handle);
    timer.callback();
  }

  get pendingCount() {
    return this.timeouts.size + this.immediates.size;
  }
}

function deterministicWaitStore(t, name, overrides = {}) {
  const stateDir = createScratchDirectory(t, name);
  const scheduler = new ManualScheduler();
  let watcher;
  let watchCount = 0;
  const store = new SessionStore(stateDir, {
    watch: (_directory, onChange) => {
      watchCount += 1;
      watcher = new FakeWatcher(onChange);
      return watcher;
    },
    setTimeout: scheduler.setTimeout,
    clearTimeout: scheduler.clearTimeout,
    setImmediate: scheduler.setImmediate,
    clearImmediate: scheduler.clearImmediate,
    reconciliationIntervalMs: 5,
    ...overrides,
  });
  return {
    scheduler,
    stateDir,
    store,
    get watchCount() { return watchCount; },
    get watcher() { return watcher; },
  };
}

test('SessionStore persists a structured browser turn and exposes it to the active agent', t => {
  const stateDir = createScratchDirectory(t, 'store');
  const store = new SessionStore(stateDir, {
    now: () => 1_725_000_000_000,
    randomUUID: () => 'event-1',
  });

  const record = store.appendBrowserTurn(browserTurn());

  assert.equal(record.seq, 1);
  assert.equal(record.id, 'event-1');
  assert.equal(record.role, 'user');
  assert.equal(record.choices[0].groupId, 'session-store');
  assert.equal(store.nextUnacknowledgedTurn().annotations[0].target.componentId, 'transport-option');
  assert.equal(fs.readFileSync(path.join(stateDir, 'session.jsonl'), 'utf8').trim(), JSON.stringify(record));
});

test('SessionStore publishes a reply and acknowledges only the browser turn it answers', t => {
  const stateDir = createScratchDirectory(t, 'reply');
  let id = 0;
  const store = new SessionStore(stateDir, {
    now: () => 1_725_000_000_000 + id,
    randomUUID: () => `event-${++id}`,
  });
  const first = store.appendBrowserTurn(browserTurn({ message: 'first' }));
  store.appendBrowserTurn(browserTurn({ message: 'second' }));

  const reply = store.publishAgentReply({
    replyTo: first.seq,
    message: 'I will revise the transport and keep SQLite.',
  });
  const snapshot = store.snapshot();

  assert.equal(reply.role, 'agent');
  assert.equal(reply.replyTo, first.seq);
  assert.equal(snapshot.cursor, first.seq);
  assert.equal(snapshot.pendingTurns, 1);
  assert.equal(store.nextUnacknowledgedTurn().message, 'second');
});

test('SessionStore retries reply publication without duplicating the response', t => {
  const stateDir = createScratchDirectory(t, 'reply-retry');
  const store = new SessionStore(stateDir);
  const turn = store.appendBrowserTurn(browserTurn());

  const first = store.publishAgentReply({ replyTo: turn.seq, message: 'First persisted response.' });
  fs.rmSync(path.join(stateDir, 'agent-cursor.json'));
  const retried = store.publishAgentReply({
    replyTo: turn.seq,
    message: 'Retry after an interrupted acknowledgement.',
  });

  assert.equal(retried.id, first.id);
  assert.equal(retried.message, 'First persisted response.');
  assert.equal(store.snapshot().events.filter(event => event.type === 'agent.message').length, 1);
  assert.equal(store.snapshot().cursor, turn.seq);
});

test('SessionStore rejects empty and oversized browser submissions at the trust boundary', t => {
  const store = new SessionStore(createScratchDirectory(t, 'invalid'));

  assert.throws(
    () => store.appendBrowserTurn(browserTurn({ message: '', annotations: [], choices: [] })),
    /message, annotation, or choice/i,
  );
  assert.throws(
    () => store.appendBrowserTurn(browserTurn({ message: 'x'.repeat(10_001) })),
    /10,000 characters/i,
  );
});

test('SessionStore deduplicates a browser retry by clientTurnId', t => {
  const store = new SessionStore(createScratchDirectory(t, 'deduplicate'));
  const submitted = browserTurn({ clientTurnId: 'browser-turn-1' });

  const first = store.appendBrowserTurn(submitted);
  const retried = store.appendBrowserTurn(submitted);

  assert.equal(retried.id, first.id);
  assert.equal(retried.seq, first.seq);
  assert.equal(store.readEvents().length, 1);
});

test('SessionStore tolerates a truncated final line instead of bricking the session', t => {
  const stateDir = createScratchDirectory(t, 'truncated');
  const store = new SessionStore(stateDir);
  const good = store.appendBrowserTurn(browserTurn({ clientTurnId: 'good-turn' }));
  // Simulate a crash/full-disk mid-append leaving a partial JSON line at the tail.
  fs.appendFileSync(path.join(stateDir, 'session.jsonl'), '{"version":1,"seq":2,"type":"user.tur');

  const snapshot = store.snapshot();
  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.events[0].clientTurnId, 'good-turn');
  // A fresh submit still succeeds and gets a monotonic seq past the surviving record.
  const next = store.appendBrowserTurn(browserTurn({ clientTurnId: 'after-truncation', message: 'still works' }));
  assert.equal(next.seq, good.seq + 1);
});

test('SessionStore waits for the next unacknowledged browser turn without polling the agent', async t => {
  const stateDir = createScratchDirectory(t, 'wait');
  const store = new SessionStore(stateDir);
  const waiting = store.waitForUnacknowledgedTurn({ timeoutMs: 1_000 });

  setTimeout(() => {
    store.appendBrowserTurn(browserTurn({ clientTurnId: 'browser-turn-wait', message: 'Queued while agent waits.' }));
  }, 20);

  const turn = await waiting;

  assert.equal(turn.clientTurnId, 'browser-turn-wait');
  assert.equal(turn.message, 'Queued while agent waits.');
  assert.equal(store.readCursor(), 0, 'delivery does not acknowledge the Feedback Batch');
});

test('SessionStore treats an absent watcher filename as a reconciliation signal', async t => {
  const harness = deterministicWaitStore(t, 'wait-absent-filename');
  let available = null;
  harness.store.nextUnacknowledgedTurn = () => available;
  const waiting = harness.store.waitForUnacknowledgedTurn({ timeoutMs: 20 });
  available = { seq: 1, clientTurnId: 'absent-filename-turn' };

  assert.equal(harness.watchCount, 1);
  harness.watcher.change(undefined);
  harness.scheduler.runImmediate();

  assert.equal((await waiting).clientTurnId, 'absent-filename-turn');
  assert.equal(harness.watcher.closeCount, 1);
  assert.equal(harness.scheduler.pendingCount, 0);
});

test('SessionStore recovers from watcher errors through bounded fallback reconciliation', async t => {
  const harness = deterministicWaitStore(t, 'wait-watcher-error');
  let available = null;
  let reads = 0;
  harness.store.nextUnacknowledgedTurn = () => {
    reads += 1;
    return available;
  };
  const waiting = harness.store.waitForUnacknowledgedTurn({ timeoutMs: 20 });

  assert.equal(harness.watchCount, 1);
  harness.watcher.emit('error', new Error('simulated watcher loss'));
  available = { seq: 1, clientTurnId: 'fallback-turn' };
  assert.ok(harness.scheduler.timeouts.size <= 2, 'fallback and overall timeout are the only timer handles');
  harness.scheduler.runTimeout(5);

  assert.equal((await waiting).clientTurnId, 'fallback-turn');
  assert.equal(reads, 2, 'initial scan plus one bounded fallback scan');
  assert.equal(harness.watcher.closeCount, 1);
  assert.equal(harness.scheduler.pendingCount, 0);
});

test('SessionStore performs bounded fallback reconciliation while the watcher is silent', async t => {
  const harness = deterministicWaitStore(t, 'wait-silent-fallback');
  let available = null;
  let reads = 0;
  harness.store.nextUnacknowledgedTurn = () => {
    reads += 1;
    return available;
  };
  const waiting = harness.store.waitForUnacknowledgedTurn({ timeoutMs: 20 });
  available = { seq: 1, clientTurnId: 'silent-fallback-turn' };

  assert.equal(harness.scheduler.timeouts.size, 2, 'one fallback and one overall timeout are scheduled');
  harness.scheduler.runTimeout(5);

  assert.equal((await waiting).clientTurnId, 'silent-fallback-turn');
  assert.equal(reads, 2, 'the fallback performs one reconciliation per interval');
  assert.equal(harness.watcher.closeCount, 1);
  assert.equal(harness.scheduler.pendingCount, 0);
});

test('SessionStore performs a final reconciliation before reporting timeout', async t => {
  const harness = deterministicWaitStore(t, 'wait-final-timeout-scan', { reconciliationIntervalMs: 100 });
  let available = null;
  harness.store.nextUnacknowledgedTurn = () => available;
  const waiting = harness.store.waitForUnacknowledgedTurn({ timeoutMs: 20 });
  available = { seq: 1, clientTurnId: 'final-scan-turn' };

  harness.scheduler.runTimeout(20);

  assert.equal((await waiting).clientTurnId, 'final-scan-turn');
  assert.equal(harness.watcher.closeCount, 1);
  assert.equal(harness.scheduler.pendingCount, 0);
});

test('SessionStore coalesces repeated wake signals and releases watcher and timer handles once', async t => {
  const harness = deterministicWaitStore(t, 'wait-idempotent-wake');
  let reads = 0;
  const turn = { seq: 1, clientTurnId: 'idempotent-turn' };
  harness.store.nextUnacknowledgedTurn = () => (++reads === 1 ? null : turn);
  const waiting = harness.store.waitForUnacknowledgedTurn({ timeoutMs: 20 });

  assert.ok(harness.watcher, 'the injected watcher owns the active Wait');
  harness.watcher.change('session.jsonl');
  harness.watcher.change(undefined, 'rename');
  assert.equal(harness.scheduler.immediates.size, 1, 'wake signals share one scheduled reconciliation');
  harness.scheduler.runImmediate();
  harness.watcher.change('agent-cursor.json');

  assert.equal(await waiting, turn);
  assert.equal(reads, 2, 'multiple wake signals do not duplicate delivery scans');
  assert.equal(harness.watcher.closeCount, 1);
  assert.equal(harness.scheduler.pendingCount, 0);
});

test('SessionStore cancellation and timeout leave later Feedback Batches pending', async t => {
  const cancelled = deterministicWaitStore(t, 'wait-cancelled');
  const controller = new AbortController();
  const cancelledWait = cancelled.store.waitForUnacknowledgedTurn({ timeoutMs: 20, signal: controller.signal });
  controller.abort();

  await assert.rejects(cancelledWait, error => error?.name === 'AbortError');
  const cancelledTurn = cancelled.store.appendBrowserTurn(browserTurn({ clientTurnId: 'after-cancel' }));
  assert.equal(cancelled.store.nextUnacknowledgedTurn().seq, cancelledTurn.seq);
  assert.equal(cancelled.store.readCursor(), 0);
  assert.equal(cancelled.watcher.closeCount, 1);
  assert.equal(cancelled.scheduler.pendingCount, 0);

  const timedOut = deterministicWaitStore(t, 'wait-timed-out', { reconciliationIntervalMs: 100 });
  const timedOutWait = timedOut.store.waitForUnacknowledgedTurn({ timeoutMs: 20 });
  timedOut.scheduler.runTimeout(20);
  assert.equal(await timedOutWait, null);
  const timedOutTurn = timedOut.store.appendBrowserTurn(browserTurn({ clientTurnId: 'after-timeout' }));
  assert.equal(timedOut.store.nextUnacknowledgedTurn().seq, timedOutTurn.seq);
  assert.equal(timedOut.store.readCursor(), 0);
  assert.equal(timedOut.watcher.closeCount, 1);
  assert.equal(timedOut.scheduler.pendingCount, 0);
});

test('SessionStore exposes one synchronous snapshot transaction for identity-preserving migration', t => {
  const store = new SessionStore(createScratchDirectory(t, 'snapshot-transaction'), {
    randomUUID: () => 'snapshot-event-1',
  });
  store.appendBrowserTurn({ clientTurnId: 'snapshot-turn-1', message: 'Preserve this batch.' });

  const result = store.withSnapshotLock(snapshot => ({
    eventId: snapshot.events[0].id,
    pendingTurns: snapshot.pendingTurns,
  }));
  assert.deepEqual(result, { eventId: 'snapshot-event-1', pendingTurns: 1 });
  assert.throws(
    () => store.withSnapshotLock(() => Promise.resolve()),
    /synchronous/i,
  );
  assert.equal(store.snapshot().events.length, 1, 'the lock is released after a rejected async callback');
});
