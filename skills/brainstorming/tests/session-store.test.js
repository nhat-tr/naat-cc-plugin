const assert = require('node:assert/strict');
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
});
