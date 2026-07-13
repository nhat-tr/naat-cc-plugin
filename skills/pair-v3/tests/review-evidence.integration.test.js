const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createAttempt,
  parsePlan,
  planContractDigest,
  validatePlan,
} = require('../scripts/lib/pair-core');
const {
  buildPatchSet,
  buildReviewSliceManifest,
  createPatchSetReview,
  persistAttemptReviewEvidence,
  updatePatchSetReview,
} = require('../scripts/review-index.cjs');
const {
  createWorkRoot,
  writeDecisionRecord,
} = require('../../brainstorming/scripts/work-lineage.cjs');
const { validPairPlan } = require('./support/pair-plan-fixture');

const workId = 'work-20260712-review-evidence';
const canonicalSpecPath = `docs/work/${workId}/spec.md`;
const decisionRecordId = 'DR-001-review-evidence';

function write(root, relativePath, content) {
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function git(root, ...args) {
  const result = childProcess.spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  return result.stdout.trim();
}

function digest(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function linkedPlan() {
  return validPairPlan()
    .replace(
      '[ac:AC-1] - files: `src/greeting.js` - verify: `node --test tests/greeting.test.js tests/greeting.integration.test.js`',
      '[ac:AC-2,AC-1] - files: `src/greeting.js`, `tests/greeting.test.js` - verify: `node --test tests/greeting.test.js tests/greeting.integration.test.js`',
    )
    .replace(
      '- [ ] AC-1: the command prints the requested greeting.',
      '- [ ] AC-1: the command prints the requested greeting.\n- [ ] AC-2: the greeting remains covered by integration evidence.',
    );
}

function createRepository(t) {
  const scratchRoot = process.env.CLAUDE_SCRATCH_DIR || path.join(os.homedir(), '.claude-scratch');
  const parent = path.join(scratchRoot, 'my-claude-code', 'review-evidence');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'repo-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'pair-v3@example.test');
  git(root, 'config', 'user.name', 'Pair v3 Test');
  return root;
}

test('attempt review evidence persists immutable Work-linked patch sets and a cumulative verdict', t => {
  const root = createRepository(t);
  const dataDirectory = path.join(root, '.pair-data');
  const plan = linkedPlan();
  const planValidation = validatePlan(plan);
  assert.equal(planValidation.valid, true, planValidation.errors.join('\n'));

  const spec = [
    '# Approved greeting specification',
    '',
    `- **Work ID:** \`${workId}\``,
    '',
    '## Engineering Quality Contract',
    '',
    'Approved review lineage obligations.',
    '',
  ].join('\n');
  const specDigest = digest(spec);
  const planDigest = planContractDigest(plan);
  write(root, '.gitignore', '.pair/\n.pair-data/\n');
  createWorkRoot({ repositoryRoot: root, workId, canonicalSpec: spec });
  writeDecisionRecord({
    repositoryRoot: root,
    record: {
      schema: 1,
      id: decisionRecordId,
      status: 'accepted',
      workId,
      title: 'Review evidence lineage',
      originSpec: canonicalSpecPath,
      acceptanceCriteria: ['AC-1', 'AC-2'],
      context: 'Pair attempts need durable review evidence.',
      decision: 'Persist immutable patch sets and Review Slice manifests.',
      rationale: 'Later review must recover exact attribution and verdict state.',
      alternatives: ['Infer ownership from paths after implementation.'],
      consequences: ['Attempt evidence becomes append-only and patch-set-specific.'],
      evidence: [],
      changes: [],
      supersedes: null,
      supersededBy: null,
    },
  });
  write(root, '.pair/plan.md', plan);
  write(root, 'src/greeting.js', 'module.exports = () => "hello";\n');
  write(root, 'tests/greeting.test.js', '// base greeting evidence\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'base');
  const baseTree = git(root, 'rev-parse', 'HEAD^{tree}');

  write(root, 'src/greeting.js', 'module.exports = name => `hello ${name}`;\n');
  write(root, 'tests/greeting.test.js', '// verifies the named greeting\n');
  git(root, 'add', 'src/greeting.js', 'tests/greeting.test.js');
  git(root, 'commit', '-qm', 'implement greeting');
  const headTree = git(root, 'rev-parse', 'HEAD^{tree}');

  const task = parsePlan(plan).tasks.find(candidate => candidate.id === '1.3');
  const attempt = createAttempt({
    task,
    route: { id: 'codex-default-medium', runtime: 'codex', model: 'default', effort: 'medium' },
    policyVersion: '3.1.0',
    baseline: baseTree,
    now: '2026-07-12T12:00:00.000Z',
    workId,
    specDigest,
    planDigest,
    decisionRecordIds: [decisionRecordId],
  });

  assert.deepEqual({
    workId: attempt.workId,
    specDigest: attempt.specDigest,
    planDigest: attempt.planDigest,
    decisionRecordIds: attempt.decisionRecordIds,
    acceptanceCriteria: attempt.acceptanceCriteria,
    expectedFiles: attempt.expectedFiles,
    baseTree: attempt.baseline,
  }, {
    workId,
    specDigest,
    planDigest,
    decisionRecordIds: [decisionRecordId],
    acceptanceCriteria: ['AC-1', 'AC-2'],
    expectedFiles: ['src/greeting.js', 'tests/greeting.test.js'],
    baseTree,
  });

  const manifestResult = buildReviewSliceManifest({
    repositoryRoot: root,
    workId,
    plan,
    baseTree,
    headTree,
    planDigest,
    indexerVersion: 'review-index.v1',
  });
  const changeIds = new Map(manifestResult.manifest.review_slices.flatMap(slice => (
    slice.actual_changes.map(change => [change.path, change.hunk_id])
  )));
  for (const change of manifestResult.manifest.unmapped_changes) {
    changeIds.set(change.path, change.hunk_id);
  }
  const fileEvidence = ['src/greeting.js', 'tests/greeting.test.js'].map(file => ({
    path: file,
    patch_digest: changeIds.get(file),
    acceptance_criteria: file.startsWith('src/') ? ['AC-2'] : ['AC-1'],
    attribution: file.startsWith('src/')
      ? { kind: 'review_slice', review_slice_ids: ['1.3'] }
      : { kind: 'cross_slice', review_slice_ids: ['1.1', '1.3'] },
  }));
  const patchSet = buildPatchSet({
    attempt_id: attempt.attemptId,
    work_id: workId,
    spec_digest: specDigest,
    plan_digest: planDigest,
    decision_record_ids: [decisionRecordId],
    base_tree: baseTree,
    head_tree: headTree,
    files: fileEvidence,
  });
  let review = createPatchSetReview(patchSet);
  review = updatePatchSetReview(review, {
    type: 'file_viewed',
    patch_set_id: patchSet.patch_set_id,
    path: 'src/greeting.js',
  });
  review = updatePatchSetReview(review, {
    type: 'whole_feature_verdict_recorded',
    patch_set_id: patchSet.patch_set_id,
    verdict: 'approved',
    acceptance_criteria: ['AC-1', 'AC-2'],
    evidence_ids: ['EVD-whole-feature-001'],
  });

  const malformedManifest = {
    manifest: {
      work_id: workId,
      base_tree: baseTree,
      head_tree: headTree,
      plan_digest: planDigest,
    },
  };
  malformedManifest.bytes = `${JSON.stringify(Object.fromEntries(
    Object.entries(malformedManifest.manifest).sort(([left], [right]) => left.localeCompare(right)),
  ))}\n`;
  malformedManifest.digest = digest(malformedManifest.bytes);
  assert.throws(
    () => persistAttemptReviewEvidence({
      repositoryRoot: root,
      dataDirectory,
      attempt,
      patchSet,
      manifest: malformedManifest,
      review,
      disposition: 'accepted',
      cause: 'malformed-manifest',
    }),
    /manifest.*(?:schema|required|Review Slice)|Review Slice.*manifest/i,
  );

  const inconsistentPatchSet = buildPatchSet({
    attempt_id: attempt.attemptId,
    work_id: workId,
    spec_digest: specDigest,
    plan_digest: planDigest,
    decision_record_ids: [decisionRecordId],
    base_tree: baseTree,
    head_tree: headTree,
    files: fileEvidence.map((file, index) => index === 0 ? {
      ...file,
      attribution: { kind: 'cross_slice', review_slice_ids: ['1.1', '1.3'] },
    } : file),
  });
  const inconsistentReview = updatePatchSetReview(createPatchSetReview(inconsistentPatchSet), {
    type: 'whole_feature_verdict_recorded',
    patch_set_id: inconsistentPatchSet.patch_set_id,
    verdict: 'approved',
    acceptance_criteria: ['AC-1', 'AC-2'],
    evidence_ids: ['EVD-whole-feature-001'],
  });
  assert.throws(
    () => persistAttemptReviewEvidence({
      repositoryRoot: root,
      dataDirectory,
      attempt,
      patchSet: inconsistentPatchSet,
      manifest: manifestResult,
      review: inconsistentReview,
      disposition: 'accepted',
      cause: 'inconsistent-attribution',
    }),
    /attribution|Review Slice manifest/i,
  );

  assert.throws(
    () => persistAttemptReviewEvidence({
      repositoryRoot: root,
      dataDirectory,
      attempt,
      patchSet,
      manifest: manifestResult,
      review: { ...review, work_id: 'work-20260712-forged-review' },
      disposition: 'accepted',
      cause: 'forged-review',
    }),
    /review.*(?:lineage|Work ID)|Work ID.*review/i,
  );

  const persisted = persistAttemptReviewEvidence({
    repositoryRoot: root,
    dataDirectory,
    attempt,
    patchSet,
    manifest: manifestResult,
    review,
    disposition: 'accepted',
    cause: 'verified',
  });
  const patchSetBytes = fs.readFileSync(persisted.patchSetPath, 'utf8');
  const storedPatchSet = JSON.parse(patchSetBytes);
  const storedManifest = JSON.parse(fs.readFileSync(persisted.manifestPath, 'utf8'));
  const storedReview = JSON.parse(fs.readFileSync(persisted.reviewPath, 'utf8'));
  const ledgerRecord = JSON.parse(fs.readFileSync(persisted.ledgerPath, 'utf8').trim());

  assert.deepEqual({
    attempt_id: storedPatchSet.attempt_id,
    work_id: storedPatchSet.work_id,
    spec_digest: storedPatchSet.spec_digest,
    plan_digest: storedPatchSet.plan_digest,
    decision_record_ids: storedPatchSet.decision_record_ids,
    base_tree: storedPatchSet.base_tree,
    head_tree: storedPatchSet.head_tree,
    acceptance_criteria: [...new Set(storedPatchSet.files.flatMap(file => file.acceptance_criteria))].sort(),
  }, {
    attempt_id: attempt.attemptId,
    work_id: workId,
    spec_digest: specDigest,
    plan_digest: planDigest,
    decision_record_ids: [decisionRecordId],
    base_tree: baseTree,
    head_tree: headTree,
    acceptance_criteria: ['AC-1', 'AC-2'],
  });
  assert.equal(storedManifest.digest, manifestResult.digest);
  assert.deepEqual(storedManifest.manifest.cross_slice_changes.map(change => change.path), [
    'tests/greeting.test.js',
  ]);
  assert.equal(storedReview.patch_set_id, patchSet.patch_set_id);
  assert.equal(storedReview.files['src/greeting.js'].viewed_patch_set_id, patchSet.patch_set_id);
  assert.equal(storedReview.files['tests/greeting.test.js'].viewed, false);
  assert.equal(storedReview.whole_feature_verdict.verdict, 'approved');
  assert.deepEqual(storedReview.whole_feature_verdict.acceptance_criteria, ['AC-1', 'AC-2']);
  assert.equal(storedReview.can_approve, true);
  assert.deepEqual({
    event: ledgerRecord.event,
    attemptId: ledgerRecord.attemptId,
    workId: ledgerRecord.workId,
    patchSetId: ledgerRecord.patchSetId,
    manifestDigest: ledgerRecord.manifestDigest,
    disposition: ledgerRecord.disposition,
    cause: ledgerRecord.cause,
  }, {
    event: 'attempt.review-evidence.persisted',
    attemptId: attempt.attemptId,
    workId,
    patchSetId: patchSet.patch_set_id,
    manifestDigest: manifestResult.digest,
    disposition: 'accepted',
    cause: 'verified',
  });

  assert.throws(
    () => persistAttemptReviewEvidence({
      repositoryRoot: root,
      dataDirectory,
      attempt,
      patchSet: { ...patchSet, head_tree: 'replacement-tree' },
      manifest: manifestResult,
      review,
      disposition: 'accepted',
      cause: 'replacement',
    }),
    /immutable|already exists/i,
  );
  assert.equal(fs.readFileSync(persisted.patchSetPath, 'utf8'), patchSetBytes);
});
