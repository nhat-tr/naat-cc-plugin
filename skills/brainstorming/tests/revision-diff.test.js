const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { computeComponentChanges } = require('../assets/visual-shell/app.js');

const baseDocument = () => ({
  version: 1,
  profile: 'technical',
  title: 'Doc',
  sections: [
    {
      kind: 'cards', id: 'facts', title: 'Facts', summary: 'Check these.',
      items: [
        { id: 'fact-a', title: 'Fact A', detail: '', tone: 'neutral', points: ['claim one', 'claim two'] },
        { id: 'fact-b', title: 'Fact B', detail: 'Lede.', tone: 'warning' },
      ],
    },
    {
      kind: 'decision', id: 'direction', title: 'Pick', summary: '', groupId: 'direction', multiselect: false,
      options: [
        { id: 'opt-a', label: 'Option A', detail: '', tone: 'neutral', score: 7, recommended: true },
      ],
    },
  ],
});

test('first render produces no change flags', () => {
  assert.deepEqual(computeComponentChanges(null, baseDocument()), { added: [], updated: [], removed: [] });
});

test('editing one point flags exactly that point, not its ancestors', () => {
  const next = baseDocument();
  next.sections[0].items[0].points[1] = 'claim two, revised';
  const changes = computeComponentChanges(baseDocument(), next);
  assert.deepEqual(changes.updated, ['fact-a-p2']);
  assert.deepEqual(changes.added, []);
  assert.deepEqual(changes.removed, []);
});

test('container edits flag the container itself', () => {
  const next = baseDocument();
  next.sections[0].summary = 'Check these, updated.';
  next.sections[0].items[1].detail = 'New lede.';
  const changes = computeComponentChanges(baseDocument(), next);
  assert.deepEqual(changes.updated.sort(), ['fact-b', 'facts']);
});

test('an added option is flagged once, without flagging its derived children', () => {
  const next = baseDocument();
  next.sections[1].options.push({ id: 'opt-b', label: 'Option B', detail: '', tone: 'neutral', points: ['cheap', 'safe'], score: 5, recommended: false });
  const changes = computeComponentChanges(baseDocument(), next);
  assert.deepEqual(changes.added, ['opt-b']);
  assert.deepEqual(changes.updated, []);
});

test('removed components are reported with human labels, ancestors only', () => {
  const next = baseDocument();
  next.sections[0].items.splice(0, 1);
  const changes = computeComponentChanges(baseDocument(), next);
  assert.deepEqual(changes.removed, [{ id: 'fact-a', label: 'Fact A' }]);
});

test('the shell wires change flags, the removed strip, and keyboard shortcuts', () => {
  const app = fs.readFileSync(path.join(__dirname, '../assets/visual-shell/app.js'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '../assets/visual-shell/styles.css'), 'utf8');
  const shell = fs.readFileSync(path.join(__dirname, '../assets/visual-shell/index.html'), 'utf8');
  const cli = fs.readFileSync(path.join(__dirname, '../scripts/visual-session.cjs'), 'utf8');
  assert.match(app, /component-flag/);
  assert.match(styles, /\.flag-updated\b/);
  assert.match(shell, /id="changes"/);
  assert.match(app, /metaKey|ctrlKey/); // ⌘/Ctrl+Enter submits the batch
  assert.match(cli, /async function wait[\s\S]{0,600}pending/); // wait reports queued batches like drain
});
