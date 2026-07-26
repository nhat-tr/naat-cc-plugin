'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { deriveSequenceActivations } = require('../scripts/uml-sequence-activations.cjs');

function message(id, from, to, message_kind, label = id) {
  return { id, component_id: `cmp-${id}`, label, message_kind, from, to };
}

test('a synchronous call activates its callee until the matching reply', () => {
  const activations = deriveSequenceActivations([
    message('call', 'client', 'api', 'sync'),
    message('answer', 'api', 'client', 'reply'),
  ]);

  assert.deepEqual(activations, [{
    lifelineId: 'api',
    messageId: 'call',
    componentId: 'cmp-call',
    label: 'call',
    openRow: 0,
    closeRow: 1,
    depth: 0,
    terminator: 'reply',
  }]);
});

test('a fire-and-forget async message opens no activation bar', () => {
  const activations = deriveSequenceActivations([
    message('emit', 'channel', 'log', 'async'),
    message('emit-again', 'channel', 'log', 'async'),
  ]);

  assert.deepEqual(activations, [], 'an async message has no observable return, so it owns no bar');
});

test('a self message owns one bar that returns on its own row', () => {
  const activations = deriveSequenceActivations([
    message('sanitize', 'channel', 'channel', 'self'),
    message('persist', 'channel', 'channel', 'self'),
  ]);

  assert.deepEqual(
    activations.map(item => [item.messageId, item.openRow, item.closeRow, item.depth, item.terminator]),
    [
      ['sanitize', 0, 0, 0, 'self-return'],
      ['persist', 1, 1, 0, 'self-return'],
    ],
    'consecutive self work must not nest deeper each time',
  );
});

test('a self message nests inside the activation that encloses it', () => {
  const activations = deriveSequenceActivations([
    message('call', 'client', 'api', 'sync'),
    message('validate', 'api', 'api', 'self'),
    message('answer', 'api', 'client', 'reply'),
  ]);

  const nested = activations.find(item => item.messageId === 'validate');
  assert.equal(nested.depth, 1, 'self work inside an open activation draws one level in');
  assert.equal(activations.find(item => item.messageId === 'call').depth, 0);
});

test('nested synchronous calls close innermost first', () => {
  const activations = deriveSequenceActivations([
    message('outer', 'client', 'api', 'sync'),
    message('inner', 'client', 'api', 'sync'),
    message('inner-reply', 'api', 'client', 'reply'),
    message('outer-reply', 'api', 'client', 'reply'),
  ]);

  assert.deepEqual(
    activations.map(item => [item.messageId, item.depth, item.openRow, item.closeRow]),
    [
      ['outer', 0, 0, 3],
      ['inner', 1, 1, 2],
    ],
    'the inner call takes the earlier reply; the outer bar paints first so it sits underneath',
  );
});

test('an unanswered call closes at the last row its lifeline takes part in', () => {
  const activations = deriveSequenceActivations([
    message('call', 'client', 'api', 'sync'),
    message('forward', 'api', 'store', 'sync'),
    message('stored', 'store', 'api', 'reply'),
    message('unrelated', 'client', 'ui', 'sync'),
  ]);

  const open = activations.find(item => item.messageId === 'call');
  assert.equal(open.closeRow, 2, 'the bar ends where its lifeline stops working, not at the diagram bottom');
  assert.equal(open.terminator, 'open-ended');
});

test('an unanswered call with no later work keeps a single-row bar', () => {
  const activations = deriveSequenceActivations([
    message('a', 'client', 'ui', 'sync'),
    message('b', 'client', 'api', 'sync'),
  ]);

  const ui = activations.find(item => item.lifelineId === 'ui');
  assert.equal(ui.openRow, 0);
  assert.equal(ui.closeRow, 0);
  assert.equal(ui.terminator, 'open-ended');
});

test('a reply with no open activation is ignored rather than mispaired', () => {
  const activations = deriveSequenceActivations([
    message('stray', 'api', 'client', 'reply'),
    message('call', 'client', 'api', 'sync'),
    message('answer', 'api', 'client', 'reply'),
  ]);

  assert.deepEqual(
    activations.map(item => [item.messageId, item.openRow, item.closeRow]),
    [['call', 1, 2]],
  );
});

test('a create message activates the created lifeline and destroy closes it', () => {
  const activations = deriveSequenceActivations([
    message('spawn', 'factory', 'worker', 'create'),
    message('gone', 'worker', 'factory', 'destroy'),
  ]);

  assert.deepEqual(
    activations.map(item => [item.messageId, item.lifelineId, item.closeRow, item.terminator]),
    [['spawn', 'worker', 1, 'reply']],
  );
});

test('a message with no kind is treated as a synchronous call', () => {
  const activations = deriveSequenceActivations([
    { id: 'call', component_id: 'cmp-call', label: 'call', from: 'client', to: 'api' },
    message('answer', 'api', 'client', 'reply'),
  ]);

  assert.equal(activations.length, 1);
  assert.equal(activations[0].lifelineId, 'api');
});

// The regression this module exists for: an event bus that only ever receives async
// notifications and does self work used to grow one full-height bar per message, so eight
// overlapping bars hid which action each one belonged to.
test('an event bus fed by async notifications never stacks a wall of bars', () => {
  const activations = deriveSequenceActivations([
    message('tool-start', 'choke', 'channel', 'async'),
    message('render', 'emitter', 'channel', 'async'),
    message('patch', 'emitter', 'channel', 'async'),
    message('tool-done', 'choke', 'channel', 'async'),
    message('completed', 'planner', 'channel', 'async'),
    message('sanitize', 'channel', 'channel', 'self'),
    message('persist', 'channel', 'channel', 'self'),
    message('pull', 'api', 'channel', 'sync'),
  ]);

  const onChannel = activations.filter(item => item.lifelineId === 'channel');
  assert.deepEqual(
    onChannel.map(item => [item.messageId, item.depth]),
    [['sanitize', 0], ['persist', 0], ['pull', 0]],
    'only self work and the synchronous pull own a bar, and none of them nest',
  );
  assert.deepEqual(
    [...new Set(onChannel.map(item => item.depth))],
    [0],
    'no bar may be pushed sideways by a phantom parent',
  );
  for (const item of onChannel) {
    assert.ok(item.componentId, `${item.messageId} bar must name the Component it belongs to`);
    assert.ok(item.label, `${item.messageId} bar must carry the action label`);
  }
});

test('every activation names the message that owns it', () => {
  const messages = [
    message('call', 'client', 'api', 'sync'),
    message('work', 'api', 'api', 'self'),
    message('answer', 'api', 'client', 'reply'),
  ];
  const activations = deriveSequenceActivations(messages);
  const byId = new Map(messages.map(item => [item.id, item]));

  for (const activation of activations) {
    const owner = byId.get(activation.messageId);
    assert.ok(owner, `activation must point at a real message, got ${activation.messageId}`);
    assert.equal(activation.componentId, owner.component_id);
    assert.equal(activation.label, owner.label);
  }
});

test('activations come back in draw order so parents paint under their children', () => {
  const activations = deriveSequenceActivations([
    message('outer', 'client', 'api', 'sync'),
    message('inner', 'client', 'api', 'sync'),
    message('deep', 'api', 'api', 'self'),
    message('inner-reply', 'api', 'client', 'reply'),
    message('outer-reply', 'api', 'client', 'reply'),
  ]);

  const depths = activations.map(item => item.depth);
  assert.deepEqual([...depths].sort((left, right) => left - right), depths.slice().sort((left, right) => left - right));
  assert.ok(
    activations.every((item, index) => index === 0 || item.openRow >= 0),
    'rows must stay resolvable',
  );
  assert.deepEqual(
    activations.map(item => item.messageId).sort(),
    ['deep', 'inner', 'outer'],
  );
});

test('an empty message list yields no activations', () => {
  assert.deepEqual(deriveSequenceActivations([]), []);
  assert.deepEqual(deriveSequenceActivations(undefined), []);
});
