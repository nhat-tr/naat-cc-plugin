// AC-5: for every prompt kind, two calls of the same kind share a byte-identical prefix covering the kind
// boilerplate — and the slice-stable block for same-slice calls — with call-variable content strictly
// after it. A prefix cache matches from byte 0, so this is the whole of what makes the boilerplate
// reachable: put one call-unique byte in front of it and none of it can ever hit.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  KIND_BOILERPLATE,
  correctionPrompt,
  implementationPrompt,
  postDiffDesignPrompt,
  promptPrefix,
  reviewPrompt,
  sliceStableBlock,
} = require('../scripts/lib/pair-prompts');

const SLICE = { id: 'S1', outcome: 'Existing value returns two.' };
const OTHER_SLICE = { id: 'S2', outcome: 'Callers observe the new value.' };
const CRITERIA = '- AC-1: value becomes two';
const OTHER_CRITERIA = '- AC-2: callers see it';
const DESIGN_CHECK = 'Seam: value.js -> callers.\nOwnership: the module owns it.';

function sharedPrefix(left, right) {
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) index++;
  return left.slice(0, index);
}

// Two calls of a kind, differing only in their call-variable tail. Whatever else changes between rounds,
// these are the bytes the cache is entitled to match.
const SAME_SLICE_PAIRS = [
  ['implementation', [
    implementationPrompt({ slice: SLICE, criteria: CRITERIA }),
    implementationPrompt({ slice: SLICE, criteria: CRITERIA, steering: 'try the retry path first' }),
  ], promptPrefix('implementation', sliceStableBlock({ slice: SLICE, criteria: CRITERIA }))],

  ['design-implementation', [
    implementationPrompt({ slice: SLICE, criteria: CRITERIA, designCheck: DESIGN_CHECK }),
    implementationPrompt({ slice: SLICE, criteria: CRITERIA, designCheck: DESIGN_CHECK, steering: 'start at the caller' }),
  ], promptPrefix('design-implementation', sliceStableBlock({ slice: SLICE, criteria: CRITERIA, designCheck: DESIGN_CHECK }))],

  ['correction', [
    correctionPrompt({ slice: SLICE, criteria: CRITERIA, evidence: [{ claim: 'first round' }] }),
    correctionPrompt({ slice: SLICE, criteria: CRITERIA, evidence: [{ claim: 'second round' }], direction: 'narrower' }),
  ], promptPrefix('correction', sliceStableBlock({ slice: SLICE, criteria: CRITERIA }))],

  ['review', [
    reviewPrompt({ slice: SLICE, criteria: CRITERIA, baseCommit: 'aaa', checkpointCommit: 'bbb', verification: { status: 0 } }),
    reviewPrompt({ slice: SLICE, criteria: CRITERIA, baseCommit: 'aaa', checkpointCommit: 'ccc', verification: { status: 0 }, diff: 'patch text' }),
  ], promptPrefix('review', sliceStableBlock({ slice: SLICE, criteria: CRITERIA }))],

  ['post-diff-design', [
    postDiffDesignPrompt({ slice: SLICE, criteria: CRITERIA, baseCommit: 'aaa', checkpointCommit: 'bbb' }),
    postDiffDesignPrompt({ slice: SLICE, criteria: CRITERIA, baseCommit: 'aaa', checkpointCommit: 'ccc' }),
  ], promptPrefix('post-diff-design', sliceStableBlock({ slice: SLICE, criteria: CRITERIA }))],
];

for (const [kind, [first, second], expected] of SAME_SLICE_PAIRS) {
  test(`two ${kind} calls about one Review Slice share the boilerplate and the slice-stable block`, () => {
    assert.ok(first.startsWith(KIND_BOILERPLATE[kind]), 'the invariant text is at byte 0');
    assert.notEqual(first, second, 'the pair must differ somewhere, or the assertion proves nothing');
    const prefix = sharedPrefix(first, second);
    assert.ok(prefix.startsWith(expected),
      `shared prefix stops after ${prefix.length} bytes; the stable package needs ${expected.length}`);
    // And what follows the guaranteed prefix really is the call-variable half.
    assert.notEqual(first.slice(expected.length), second.slice(expected.length));
  });
}

test('two calls about different Review Slices still share the whole kind boilerplate', () => {
  for (const kind of ['implementation', 'correction', 'review']) {
    const first = kind === 'review'
      ? reviewPrompt({ slice: SLICE, criteria: CRITERIA, baseCommit: 'a', checkpointCommit: 'b', verification: {} })
      : kind === 'correction'
        ? correctionPrompt({ slice: SLICE, criteria: CRITERIA, evidence: [] })
        : implementationPrompt({ slice: SLICE, criteria: CRITERIA });
    const second = kind === 'review'
      ? reviewPrompt({ slice: OTHER_SLICE, criteria: OTHER_CRITERIA, baseCommit: 'a', checkpointCommit: 'b', verification: {} })
      : kind === 'correction'
        ? correctionPrompt({ slice: OTHER_SLICE, criteria: OTHER_CRITERIA, evidence: [] })
        : implementationPrompt({ slice: OTHER_SLICE, criteria: OTHER_CRITERIA });
    assert.ok(sharedPrefix(first, second).startsWith(KIND_BOILERPLATE[kind]),
      `${kind} loses its boilerplate the moment the slice changes`);
  }
});

// A warm resumed call drops the stable block entirely — the session already holds it — and two warm calls
// of a kind still share the boilerplate they both open with.
test('warm calls omit the slice-stable block and still share their boilerplate', () => {
  const first = correctionPrompt({ slice: SLICE, criteria: CRITERIA, evidence: [{ claim: 'one' }], warm: true });
  const second = correctionPrompt({ slice: SLICE, criteria: CRITERIA, evidence: [{ claim: 'two' }], warm: true });
  assert.doesNotMatch(first, /Acceptance Criteria/u);
  assert.doesNotMatch(first, /Review Slice: S1/u);
  assert.ok(sharedPrefix(first, second).startsWith(KIND_BOILERPLATE.correction));
  assert.ok(implementationPrompt({ slice: SLICE, criteria: CRITERIA, warm: true }).startsWith(KIND_BOILERPLATE.implementation));
});

// The regression this replaces: every prompt used to open with the slice id and its findings, so the
// identical paragraph at the end of sixty-two calls was unreachable to a cache that matches from byte 0.
test('no prompt opens with call-unique content', () => {
  const prompts = [
    implementationPrompt({ slice: SLICE, criteria: CRITERIA }),
    correctionPrompt({ slice: SLICE, criteria: CRITERIA, evidence: [{ claim: 'x' }], direction: 'y' }),
    reviewPrompt({ slice: SLICE, criteria: CRITERIA, baseCommit: 'deadbeef', checkpointCommit: 'cafe', verification: {} }),
    postDiffDesignPrompt({ slice: SLICE, criteria: CRITERIA, baseCommit: 'deadbeef', checkpointCommit: 'cafe' }),
  ];
  for (const prompt of prompts) {
    const head = prompt.slice(0, 120);
    assert.doesNotMatch(head, /S1|deadbeef|cafe/u, `call-unique bytes in the first 120: ${head}`);
  }
});

// Observed live across one Work: the same defect class came back four times — a guard missing at call sites,
// then at a state transition, then in cross-Work reclamation, then in a signal handler. Each review found its
// own instance and none swept for the siblings, so every round paid for a finding the previous correction
// could have closed for free. The instruction belongs in the correction boilerplate rather than in a per-call
// tail: it is true of every correction, which is exactly what makes it byte-stable and cacheable.
test('a correction is told to sweep for the same defect elsewhere', () => {
  assert.match(KIND_BOILERPLATE.correction, /sweep for the same defect elsewhere/u);
  assert.match(KIND_BOILERPLATE.correction, /other callers of the function you guarded/u,
    'the sweep is named concretely, because "check for similar issues" is advice a session can satisfy by thinking');
  assert.match(KIND_BOILERPLATE.correction, /Name in your report every sibling you found/u,
    'a sweep nobody reports is indistinguishable from one that never happened');
  assert.match(KIND_BOILERPLATE.correction, /new design is not/u,
    'and it stays inside the bound, or it becomes licence to broaden the correction');
});

// The sweep must not cost the prefix cache: it is fixed text in the boilerplate, so two corrections about
// different slices still share every byte of it.
test('the sweep instruction stays inside the cacheable prefix', () => {
  const left = correctionPrompt({ slice: SLICE, criteria: CRITERIA, evidence: [{ claim: 'a' }], direction: null });
  const right = correctionPrompt({ slice: OTHER_SLICE, criteria: OTHER_CRITERIA, evidence: [{ claim: 'b' }], direction: null });

  assert.ok(sharedPrefix(left, right).includes('sweep for the same defect elsewhere'),
    'two corrections about different slices share the instruction, so it is paid for once');
});
