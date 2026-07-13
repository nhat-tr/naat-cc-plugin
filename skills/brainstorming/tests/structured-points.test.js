const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { normalizeVisualDocument } = require('../scripts/visual-document.cjs');

function documentWith(items) {
  return {
    version: 1,
    profile: 'technical',
    title: 'Points grammar',
    sections: [{ kind: 'cards', id: 'facts', title: 'Facts', items }],
  };
}

test('items accept short claim points and keep them as an ordered list', () => {
  const document = normalizeVisualDocument(documentWith([{
    id: 'purpose',
    title: 'Purpose',
    detail: 'One-sentence lede.',
    points: [
      'Multi-tool turns ALREADY render one component per tool result (Node.cs:27).',
      'Goal is simplification, not net-new rendering.',
    ],
  }]));
  assert.deepEqual(document.sections[0].items[0].points, [
    'Multi-tool turns ALREADY render one component per tool result (Node.cs:27).',
    'Goal is simplification, not net-new rendering.',
  ]);
});

test('an empty points array is dropped instead of rendered as an empty list', () => {
  const document = normalizeVisualDocument(documentWith([{ id: 'a', title: 'A', points: [] }]));
  assert.equal('points' in document.sections[0].items[0], false);
});

test('points reject blobs: more than 6 entries or entries over 160 characters', () => {
  assert.throws(
    () => normalizeVisualDocument(documentWith([{ id: 'a', title: 'A', points: Array.from({ length: 7 }, (_v, i) => `p${i}`) }])),
    /points/,
  );
  assert.throws(
    () => normalizeVisualDocument(documentWith([{ id: 'a', title: 'A', points: ['x'.repeat(161)] }])),
    /points\[0\]/,
  );
});

test('a normalized document with points is canonical under re-normalization', () => {
  const once = normalizeVisualDocument(documentWith([{ id: 'a', title: 'A', points: [' trimmed  '] }]));
  assert.deepEqual(normalizeVisualDocument(once), once);
  assert.deepEqual(once.sections[0].items[0].points, ['trimmed']);
});

test('decision options accept points for claim-level scanning', () => {
  const document = normalizeVisualDocument({
    version: 1,
    profile: 'technical',
    title: 'Decision points',
    sections: [{
      kind: 'decision',
      id: 'direction',
      title: 'Pick one',
      options: [
        { id: 'a', label: 'Option A', points: ['Lowest risk.', 'Reuses the shipped path.'] },
        { id: 'b', label: 'Option B', detail: 'Prose fallback still works.' },
      ],
    }],
  });
  assert.deepEqual(document.sections[0].options[0].points, ['Lowest risk.', 'Reuses the shipped path.']);
  assert.equal('points' in document.sections[0].options[1], false);
});

test('the shell renders points as individually annotatable fragments', () => {
  const app = fs.readFileSync(path.join(__dirname, '../ui/app/WorkspaceHost.tsx'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '../assets/visual-shell/styles.css'), 'utf8');
  assert.match(app, /point-list/);
  assert.match(app, /-p\$\{|\-p' \+/); // derived per-point ids like <item-id>-p1
  assert.match(styles, /\.point\b/);
});
