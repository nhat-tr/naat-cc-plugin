// Per-process machine scope, required before the engine reads it (see known-failure-baseline.test.js).
require('./helpers/isolate-machine-lease');

const assert = require('node:assert/strict');
const test = require('node:test');

const { activeSlice, currentState, workContext } = require('../scripts/lib/pair-engine');
const { digestLines } = require('../scripts/pair-cli');
const { openTestWork } = require('./helpers/warm-work');

// A fresh session orienting itself today reads the whole of .pair/spec.md to learn the slices, their
// Acceptance Criteria, and what to run next — every byte of prose along with the handful of facts that
// actually matter. digest is the compact substitute: it is built only from workContext's already-bounded
// pieces (criteria text, the capped manifest, the projected slices) and must never surface the raw spec.
const DIGEST_SLICES = [
  { id: 'S1', acceptance_criteria: ['AC-1'], outcome: 'Existing value returns two.', depends_on: [], verify: 'node verify.js' },
  { id: 'S2', acceptance_criteria: ['AC-2'], outcome: 'The value is memoised.', depends_on: ['S1'], verify: 'node verify.js' },
];
const DIGEST_SPEC_MARKDOWN = [
  '# Spec',
  '',
  '## Problem',
  '',
  'This paragraph is prose explaining the motivation in exhaustive detail and must never leak into a',
  'compact orientation view meant to replace reading spec.md end to end.',
  '',
  '## Acceptance Criteria',
  '',
  '- [ ] AC-1: value becomes two',
  '- [ ] AC-2: value is memoised',
  '',
].join('\n');

function openScratchWork(t, workId) {
  return openTestWork(t, { prefix: 'digest', workId, slices: DIGEST_SLICES, specMarkdown: DIGEST_SPEC_MARKDOWN });
}

test('digest names every Review Slice with its status and Acceptance Criteria ids, spells out the current slice\'s criteria in full, names the next command, and never surfaces the raw specification', t => {
  const opened = openScratchWork(t, 'work-digest');
  const state = currentState(opened.worktree, 'work-digest');
  const context = workContext(opened.worktree, state);
  const next = activeSlice(state, context)?.projected;

  const text = digestLines(state, context, next).join('\n');

  assert.match(text, /work-digest/u, 'the Work id orients the reader before anything else');
  assert.match(text, /S1\s+queued/u, 'every slice is named with its status');
  assert.match(text, /S2\s+queued/u);
  assert.match(text, /\[AC-1\]/u, 'each slice line names the Acceptance Criteria it maps');
  assert.match(text, /\[AC-2\]/u);
  assert.match(text, /AC-1: value becomes two/u, 'the current slice\'s Acceptance Criteria are spelled out in full, not just their ids');
  assert.match(text, /Command: pair-loop run/u, 'the next command is named, exactly as status names it');
  assert.doesNotMatch(text, /exhaustive detail/u, 'the raw specification body never reaches the digest');
});

test('digest stays a few hundred bytes for a small Work, because it replaces reading the whole specification', t => {
  const opened = openScratchWork(t, 'work-digest-size');
  const state = currentState(opened.worktree, 'work-digest-size');
  const context = workContext(opened.worktree, state);
  const next = state.slices.find(slice => slice.status === 'queued');

  const text = digestLines(state, context, next).join('\n');

  assert.ok(text.length < 2000, `digest for a two-slice Work should stay compact; was ${text.length} bytes`);
});
