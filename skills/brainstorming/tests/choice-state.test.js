const assert = require('node:assert/strict');
const test = require('node:test');

const {
  annotationSummary,
  groupAnnotationsByComponent,
  isChoiceSelected,
  normalizeFeedbackDraft,
  readResponseError,
  reconcileChoices,
} = require('../assets/visual-shell/app.js');

test('single-choice groups replace the previous value and support deselection', () => {
  const jsonl = { groupId: 'session-store', componentId: 'store-jsonl', value: 'jsonl', label: 'JSONL' };
  const sqlite = { groupId: 'session-store', componentId: 'store-sqlite', value: 'sqlite', label: 'SQLite' };

  let choices = reconcileChoices([], jsonl, { selected: true, multiselect: false });
  assert.deepEqual(choices, [jsonl]);

  choices = reconcileChoices(choices, sqlite, { selected: true, multiselect: false });
  assert.deepEqual(choices, [sqlite]);

  choices = reconcileChoices(choices, sqlite, { selected: false, multiselect: false });
  assert.deepEqual(choices, []);
});

test('multiselect groups retain independent selected values', () => {
  const email = { groupId: 'channels', componentId: 'channel-email', value: 'email', label: 'Email' };
  const chat = { groupId: 'channels', componentId: 'channel-chat', value: 'chat', label: 'Chat' };

  let choices = reconcileChoices([], email, { selected: true, multiselect: true });
  choices = reconcileChoices(choices, chat, { selected: true, multiselect: true });

  assert.deepEqual(choices, [email, chat]);
});

test('saved feedback drafts restore chat, idempotency key, and visible choice state', () => {
  const saved = normalizeFeedbackDraft({
    annotations: [{ id: 'note-1' }],
    choices: [{ componentId: 'channel-email', value: 'email' }],
    message: 'Keep the evidence visible.',
    clientTurnId: 'feedback-1',
  });

  assert.equal(saved.message, 'Keep the evidence visible.');
  assert.equal(saved.clientTurnId, 'feedback-1');
  assert.equal(isChoiceSelected(saved.choices, 'channel-email'), true);
  assert.equal(isChoiceSelected(saved.choices, 'channel-chat'), false);
});

test('screen validation details are surfaced instead of a generic HTTP status', async () => {
  const message = await readResponseError({
    json: async () => ({ error: 'invalid screen.json: unsupported decision field' }),
  }, 'screen request failed: 422');

  assert.equal(message, 'invalid screen.json: unsupported decision field');
});

test('queued annotations group by rendered component and expose hover summaries', () => {
  const grouped = groupAnnotationsByComponent([
    { comment: 'First note.', target: { componentId: 'card-a', label: 'Card A' } },
    { comment: 'Second note.', target: { componentId: 'card-a', label: 'Card A' } },
    { comment: 'Different card.', target: { componentId: 'card-b', label: 'Card B' } },
    { comment: 'Missing target.', target: {} },
  ]);

  assert.equal(grouped.get('card-a').length, 2);
  assert.equal(grouped.get('card-b').length, 1);
  assert.equal(annotationSummary(grouped.get('card-a')), '2 annotations:\n1. First note.\n2. Second note.');
});
