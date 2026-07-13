const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { SessionStore } = require('../scripts/session-store.cjs');
const { createScratchDirectory } = require('./test-support');

class ClosureWatcher extends EventEmitter {
  constructor(onChange) {
    super();
    this.onChange = onChange;
    this.closeCount = 0;
  }

  change(filename) {
    this.onChange('change', filename);
  }

  close() {
    this.closeCount += 1;
  }
}

test('Visual Session closure rejects an active Wait distinctly from timeout and cleans its watcher', async t => {
  let watcher;
  let closed = false;
  const timers = new Set();
  const store = new SessionStore(createScratchDirectory(t, 'closed-wait'), {
    watch: (_directory, onChange) => {
      watcher = new ClosureWatcher(onChange);
      return watcher;
    },
    setTimeout: (callback, delay) => {
      const handle = { callback, delay, unref() {} };
      timers.add(handle);
      return handle;
    },
    clearTimeout: handle => timers.delete(handle),
    setImmediate: callback => {
      callback();
      return null;
    },
    clearImmediate: () => {},
    reconciliationIntervalMs: 5,
  });
  const waiting = store.waitForUnacknowledgedTurn({
    timeoutMs: 20,
    isClosed: () => closed,
  });
  closed = true;

  assert.ok(watcher, 'the injected watcher owns the active Wait');
  watcher.change(undefined);

  await assert.rejects(waiting, error => {
    assert.equal(error?.code, 'VISUAL_SESSION_CLOSED');
    assert.notEqual(error?.name, 'AbortError');
    return true;
  });
  assert.equal(watcher.closeCount, 1);
  assert.equal(timers.size, 0);
});

test('browser delivery state is derived only from monotonic server and adapter evidence', () => {
  const { deriveBrowserDeliveryState } = require('../assets/visual-shell/app.js');
  assert.equal(typeof deriveBrowserDeliveryState, 'function');
  const evidence = {
    connection: 'open',
    listening: true,
    durableSeq: null,
    deliveredThrough: 0,
    acknowledgedThrough: 0,
  };

  assert.deepEqual([
    deriveBrowserDeliveryState(evidence),
    deriveBrowserDeliveryState({ ...evidence, durableSeq: 7 }),
    deriveBrowserDeliveryState({ ...evidence, durableSeq: 7, deliveredThrough: 7 }),
    deriveBrowserDeliveryState({ ...evidence, durableSeq: 7, deliveredThrough: 7, acknowledgedThrough: 7 }),
    deriveBrowserDeliveryState({ ...evidence, connection: 'reconnecting', durableSeq: 7, acknowledgedThrough: 7 }),
    deriveBrowserDeliveryState({ ...evidence, connection: 'closed', durableSeq: 7, acknowledgedThrough: 7 }),
  ], [
    'listening',
    'queued',
    'delivered',
    'acknowledged',
    'reconnecting',
    'closed',
  ]);

  assert.equal(deriveBrowserDeliveryState({
    ...evidence,
    optimisticSubmission: true,
    deliveredThrough: 99,
    acknowledgedThrough: 99,
  }), 'listening', 'delivery evidence cannot exist before a durable Feedback Batch sequence');
  assert.equal(deriveBrowserDeliveryState({
    ...evidence,
    durableSeq: 7,
    deliveredThrough: 6,
    acknowledgedThrough: 6,
  }), 'queued', 'delivery and acknowledgement must reach the durable Feedback Batch sequence');
});
