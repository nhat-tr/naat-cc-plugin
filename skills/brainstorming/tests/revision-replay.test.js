const assert = require('node:assert/strict');
const test = require('node:test');

const { parseRevisionSnapshots, filterSessionEventsForRevision } = require('../assets/visual-shell/app.js');

test('parseRevisionSnapshots keeps well-formed snapshots in order', () => {
  const snapshots = parseRevisionSnapshots([
    { seq: 1, revision: 'aaaaaaaa', timestamp: 1000, document: { version: 1 } },
    { seq: 2, revision: 'bbbbbbbb', document: { version: 1 } },
  ]);
  assert.deepEqual(snapshots, [
    { seq: 1, revision: 'aaaaaaaa', timestamp: 1000, document: { version: 1 } },
    { seq: 2, revision: 'bbbbbbbb', document: { version: 1 } },
  ]);
});

test('parseRevisionSnapshots drops entries with a non-integer seq, non-string revision, or non-object document', () => {
  const snapshots = parseRevisionSnapshots([
    { seq: 1.5, revision: 'aaaaaaaa', document: { version: 1 } },
    { seq: 2, revision: 42, document: { version: 1 } },
    { seq: 3, revision: 'cccccccc', document: 'not-an-object' },
    { seq: 4, revision: 'dddddddd', document: null },
    { seq: 5, revision: 'eeeeeeee' },
    'garbage',
    null,
    42,
    { seq: 6, revision: 'ffffffff', document: { version: 1 } },
  ]);
  assert.deepEqual(snapshots, [
    { seq: 6, revision: 'ffffffff', document: { version: 1 } },
  ]);
});

test('parseRevisionSnapshots returns [] for non-array input', () => {
  assert.deepEqual(parseRevisionSnapshots(undefined), []);
  assert.deepEqual(parseRevisionSnapshots(null), []);
  assert.deepEqual(parseRevisionSnapshots('revisions'), []);
  assert.deepEqual(parseRevisionSnapshots({ seq: 1, revision: 'aaaaaaaa', document: {} }), []);
});

test('filterSessionEventsForRevision keeps only turns targeting the revision and their replies', () => {
  const events = [
    { type: 'user.turn', seq: 1, screen: { revision: 'aaaaaaaa' }, message: 'first pass' },
    { type: 'agent.message', seq: 2, replyTo: 1, message: 'reply to first' },
    { type: 'user.turn', seq: 3, screen: { revision: 'bbbbbbbb' }, message: 'second pass' },
    { type: 'agent.message', seq: 4, replyTo: 3, message: 'reply to second' },
  ];
  assert.deepEqual(filterSessionEventsForRevision(events, 'aaaaaaaa'), [
    { type: 'user.turn', seq: 1, screen: { revision: 'aaaaaaaa' }, message: 'first pass' },
    { type: 'agent.message', seq: 2, replyTo: 1, message: 'reply to first' },
  ]);
});

test('filterSessionEventsForRevision drops orphan replies whose target turn did not match', () => {
  const events = [
    { type: 'user.turn', seq: 1, screen: { revision: 'aaaaaaaa' }, message: 'targets aaaaaaaa' },
    { type: 'user.turn', seq: 2, screen: { revision: 'bbbbbbbb' }, message: 'targets bbbbbbbb' },
    { type: 'agent.message', seq: 3, replyTo: 2, message: 'reply to the other revision' },
  ];
  assert.deepEqual(filterSessionEventsForRevision(events, 'aaaaaaaa'), [
    { type: 'user.turn', seq: 1, screen: { revision: 'aaaaaaaa' }, message: 'targets aaaaaaaa' },
  ]);
});

test('filterSessionEventsForRevision drops events of other types and turns missing a screen stamp', () => {
  const events = [
    { type: 'user.turn', seq: 1, message: 'no screen stamp yet' },
    { type: 'user.turn', seq: 2, screen: { revision: 'aaaaaaaa' }, message: 'matches' },
    { type: 'session.opened', seq: 3 },
    { type: 'agent.message', seq: 4, replyTo: 2, message: 'reply to matching turn' },
  ];
  assert.deepEqual(filterSessionEventsForRevision(events, 'aaaaaaaa'), [
    { type: 'user.turn', seq: 2, screen: { revision: 'aaaaaaaa' }, message: 'matches' },
    { type: 'agent.message', seq: 4, replyTo: 2, message: 'reply to matching turn' },
  ]);
});

test('filterSessionEventsForRevision returns [] when nothing targets the revision', () => {
  const events = [
    { type: 'user.turn', seq: 1, screen: { revision: 'bbbbbbbb' }, message: 'other revision' },
    { type: 'agent.message', seq: 2, replyTo: 1, message: 'reply' },
  ];
  assert.deepEqual(filterSessionEventsForRevision(events, 'aaaaaaaa'), []);
});
