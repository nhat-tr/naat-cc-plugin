const assert = require('node:assert/strict');
const test = require('node:test');

let reviewIndex = {};
try {
  reviewIndex = require('../scripts/review-index.cjs');
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
}

function contractFunction(name) {
  assert.equal(
    typeof reviewIndex[name],
    'function',
    `review-index.cjs must export ${name}`,
  );
  return reviewIndex[name];
}

function patchSetInput(overrides = {}) {
  return {
    attempt_id: '2.3-attempt-001',
    work_id: 'work-20260712-visual-companion-vnext',
    base_tree: 'base-tree-001',
    head_tree: 'head-tree-001',
    plan_digest: 'plan-digest-001',
    files: [
      {
        path: 'src/alpha.js',
        patch_digest: 'alpha-patch-001',
        acceptance_criteria: ['AC-1'],
        attribution: { kind: 'review_slice', review_slice_ids: ['1.3'] },
      },
      {
        path: 'src/beta.js',
        patch_digest: 'beta-patch-001',
        acceptance_criteria: ['AC-2'],
        attribution: { kind: 'review_slice', review_slice_ids: ['2.3'] },
      },
    ],
    ...overrides,
  };
}

test('patch set identity is deterministic and cannot be changed through mutable inputs', () => {
  const buildPatchSet = contractFunction('buildPatchSet');
  const input = patchSetInput();
  const first = buildPatchSet(input);
  const second = buildPatchSet(patchSetInput());

  assert.match(first.patch_set_id, /^[a-f0-9]{64}$/);
  assert.equal(first.patch_set_id, second.patch_set_id);

  input.files[0].patch_digest = 'mutated-after-construction';
  assert.equal(first.files[0].patch_digest, 'alpha-patch-001');

  const changed = buildPatchSet(patchSetInput({ head_tree: 'head-tree-002' }));
  assert.notEqual(changed.patch_set_id, first.patch_set_id);
});

test('patch sets preserve explicit Review Slice, cross-slice, and unmapped attribution', () => {
  const buildPatchSet = contractFunction('buildPatchSet');
  const patchSet = buildPatchSet(patchSetInput({
    files: [
      patchSetInput().files[0],
      {
        ...patchSetInput().files[1],
        attribution: { kind: 'cross_slice', review_slice_ids: ['2.3', '1.3'] },
      },
      {
        path: 'README.md',
        patch_digest: 'readme-patch-001',
        acceptance_criteria: [],
        attribution: { kind: 'unmapped' },
      },
    ],
  }));

  assert.deepEqual(patchSet.files.map(file => file.attribution), [
    { kind: 'unmapped' },
    { kind: 'review_slice', review_slice_ids: ['1.3'] },
    { kind: 'cross_slice', review_slice_ids: ['1.3', '2.3'] },
  ]);
  assert.throws(
    () => buildPatchSet(patchSetInput({
      files: [{
        ...patchSetInput().files[0],
        attribution: { kind: 'review_slice', review_slice_ids: ['1.2', '1.3'] },
      }],
    })),
    /cross.slice/i,
  );
});

test('File Viewed state belongs to one patch set and is not shared by path alone', () => {
  const buildPatchSet = contractFunction('buildPatchSet');
  const createPatchSetReview = contractFunction('createPatchSetReview');
  const updatePatchSetReview = contractFunction('updatePatchSetReview');
  const firstPatchSet = buildPatchSet(patchSetInput());
  const secondPatchSet = buildPatchSet(patchSetInput({
    attempt_id: '2.3-attempt-002',
    head_tree: 'head-tree-002',
  }));

  const firstReview = updatePatchSetReview(createPatchSetReview(firstPatchSet), {
    type: 'file_viewed',
    patch_set_id: firstPatchSet.patch_set_id,
    path: 'src/alpha.js',
  });
  const secondReview = createPatchSetReview(secondPatchSet);

  assert.equal(firstReview.files['src/alpha.js'].viewed, true);
  assert.equal(firstReview.files['src/alpha.js'].viewed_patch_set_id, firstPatchSet.patch_set_id);
  assert.equal(secondReview.files['src/alpha.js'].viewed, false);
  assert.throws(
    () => updatePatchSetReview(firstReview, {
      type: 'file_viewed',
      patch_set_id: secondPatchSet.patch_set_id,
      path: 'src/alpha.js',
    }),
    /patch set/i,
  );
});

test('a changed patch invalidates only the affected file and Acceptance Criteria evidence', () => {
  const buildPatchSet = contractFunction('buildPatchSet');
  const createPatchSetReview = contractFunction('createPatchSetReview');
  const updatePatchSetReview = contractFunction('updatePatchSetReview');
  const firstPatchSet = buildPatchSet(patchSetInput());
  let review = createPatchSetReview(firstPatchSet);

  for (const path of ['src/alpha.js', 'src/beta.js']) {
    review = updatePatchSetReview(review, {
      type: 'file_viewed',
      patch_set_id: firstPatchSet.patch_set_id,
      path,
    });
  }
  for (const acceptanceCriterionId of ['AC-1', 'AC-2']) {
    review = updatePatchSetReview(review, {
      type: 'acceptance_evidence_recorded',
      patch_set_id: firstPatchSet.patch_set_id,
      acceptance_criterion_id: acceptanceCriterionId,
      evidence_ids: [`EVD-${acceptanceCriterionId}`],
    });
  }

  const nextPatchSet = buildPatchSet(patchSetInput({
    head_tree: 'head-tree-002',
    files: [
      { ...patchSetInput().files[0], patch_digest: 'alpha-patch-002' },
      patchSetInput().files[1],
    ],
  }));
  const next = updatePatchSetReview(review, {
    type: 'patch_set_replaced',
    patch_set: nextPatchSet,
  });

  assert.equal(next.files['src/alpha.js'].viewed, false);
  assert.equal(next.acceptance_evidence['AC-1'].status, 'outdated');
  assert.equal(next.files['src/beta.js'].viewed, true);
  assert.equal(next.acceptance_evidence['AC-2'].status, 'current');
});

test('whole-feature verdict is required for approval and is independent of File Viewed progress', () => {
  const buildPatchSet = contractFunction('buildPatchSet');
  const createPatchSetReview = contractFunction('createPatchSetReview');
  const updatePatchSetReview = contractFunction('updatePatchSetReview');
  const patchSet = buildPatchSet(patchSetInput());
  let allViewed = createPatchSetReview(patchSet);

  for (const path of ['src/alpha.js', 'src/beta.js']) {
    allViewed = updatePatchSetReview(allViewed, {
      type: 'file_viewed',
      patch_set_id: patchSet.patch_set_id,
      path,
    });
  }
  assert.equal(allViewed.viewed_progress.viewed, 2);
  assert.equal(allViewed.can_approve, false);

  const verdictOnly = updatePatchSetReview(createPatchSetReview(patchSet), {
    type: 'whole_feature_verdict_recorded',
    patch_set_id: patchSet.patch_set_id,
    verdict: 'approved',
    acceptance_criteria: ['AC-1', 'AC-2'],
    evidence_ids: ['EVD-whole-feature-001'],
  });

  assert.equal(verdictOnly.viewed_progress.viewed, 0);
  assert.equal(verdictOnly.whole_feature_verdict.verdict, 'approved');
  assert.equal(verdictOnly.can_approve, true);
});
