const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  beginActivePairLoop,
  chooseRoute,
  endActivePairLoop,
  isExpectedFailingTestTask,
  parseWorkerResult,
  readWorkLinkage,
  reconcileOrphanedAttempts,
  recoverActiveAttempt,
  revertToSnapshot,
  snapshotWorktree,
  verify,
} = require('../scripts/pair-task');
const { planContractDigest } = require('../scripts/lib/pair-core');
const {
  createWorkRoot,
  writeDecisionRecord,
} = require('../../brainstorming/scripts/work-lineage.cjs');

function testRepo(t) {
  const scratchRoot = process.env.CLAUDE_SCRATCH_DIR
    || path.join(os.homedir(), '.claude-scratch');
  fs.mkdirSync(path.join(scratchRoot, 'my-claude-code', 'pair-v3-tests'), { recursive: true });
  const root = fs.mkdtempSync(path.join(scratchRoot, 'my-claude-code', 'pair-v3-tests', 'repo-'));
  require('node:child_process').spawnSync('git', ['init', '-q'], { cwd: root });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('verify replays a reported passing command', t => {
  const root = testRepo(t);
  const result = verify(root, { type: 'feature', text: 'implement behavior' }, {
    tests: [{ command: 'node -e "process.exit(0)"', status: 'pass' }],
  });

  assert.equal(result.status, 'pass');
  assert.match(result.command, /replayed worker verification/);
});

test('verify rejects a claimed pass when command replay fails', t => {
  const root = testRepo(t);
  const result = verify(root, { type: 'feature', text: 'implement behavior' }, {
    tests: [{ command: 'node -e "process.exit(1)"', status: 'pass' }],
  });

  assert.equal(result.status, 'fail');
});

test('verify proves a tests-first task by replaying the expected failure', t => {
  const root = testRepo(t);
  const result = verify(root, { type: 'test', text: 'write failing tests for behavior' }, {
    tests: [{ command: 'node -e "process.exit(1)"', status: 'fail' }],
  });

  assert.equal(result.status, 'pass');
  assert.match(result.output, /expected failure reproduced/);
});

test('tests-first detection honors the explicit red phase', () => {
  assert.equal(isExpectedFailingTestTask({ type: 'test', phase: 'red', text: 'capture expected behavior' }), true);
});

test('recoverActiveAttempt classifies an interrupted attempt before retry', t => {
  const root = testRepo(t);
  const pairDir = path.join(root, '.pair');
  fs.mkdirSync(pairDir);
  const paths = {
    active: path.join(pairDir, 'active-attempt.json'),
    ledger: path.join(root, 'attempts.jsonl'),
  };
  fs.writeFileSync(paths.active, JSON.stringify({
    attemptId: '1.1-interrupted',
    taskId: '1.1',
    routeId: 'codex-default-low',
    profile: { type: 'feature', risk: 'low' },
  }));

  assert.equal(recoverActiveAttempt(paths), true);
  assert.equal(fs.existsSync(paths.active), false);
  const record = JSON.parse(fs.readFileSync(paths.ledger, 'utf8').trim());
  assert.equal(record.disposition, 'regenerated');
  assert.equal(record.action, 'retry-infrastructure');
  assert.equal(record.valid, false);
});

test('parseWorkerResult flags shape failures, not just JSON-parse failures', () => {
  const wrap = result => JSON.stringify({ structured_output: result });

  const completed = parseWorkerResult('claude', wrap({ status: 'completed', summary: 'done', files_changed: [], tests: [] }));
  assert.equal(completed.status, 'completed');
  assert.notEqual(completed.parseError, true, 'a schema-shaped result is not a parse error');

  const blocked = parseWorkerResult('claude', wrap({ status: 'blocked', blocker: 'incorrect-plan: no API', summary: 's', files_changed: [], tests: [] }));
  assert.equal(blocked.blocker, 'incorrect-plan: no API', 'a real authored blocker is preserved, not overwritten');
  assert.notEqual(blocked.parseError, true);

  // Valid JSON but wrong shape (no recognized status) — a weak model emitting {} must
  // be treated as a parse error so it escalates, not as a silent reviewer-error.
  const shapeless = parseWorkerResult('claude', wrap({ foo: 1 }));
  assert.equal(shapeless.parseError, true);
  assert.equal(shapeless.status, 'blocked');

  const notJson = parseWorkerResult('claude', 'this is not json');
  assert.equal(notJson.parseError, true);
});

test('chooseRoute escalates after an unparseable result (retry-stronger) but holds after a spawn failure', () => {
  const task = { id: '6.1', type: 'test', complexity: 'S', risk: 'low', scope: 'local', uncertainty: 'low' };
  const priorRecord = action => ([{
    event: 'attempt.completed',
    taskId: '6.1',
    repositoryId: 'repo-A',
    routeId: 'claude-haiku-low',
    action,
    valid: false,
    status: 'completed',
  }]);

  const escalated = chooseRoute(task, 'claude', priorRecord('retry-stronger'), {}, 'repo-A');
  assert.equal(escalated.strength > 1, true, 'a weak model that could not emit the schema must escalate');
  assert.notEqual(escalated.id, 'claude-haiku-low');

  const held = chooseRoute(task, 'claude', priorRecord('retry-infrastructure'), {}, 'repo-A');
  assert.equal(held.id, 'claude-haiku-low', 'a transient spawn failure retries the same route');
});

test('reconcileOrphanedAttempts closes stranded starts for this working root only', t => {
  const root = testRepo(t);
  const ledger = path.join(root, 'attempts.jsonl');
  const rows = [
    { event: 'attempt.started', attemptId: 'orphan-1', taskId: '1.1', root: '/root-A', routeId: 'r', profile: {} },
    { event: 'attempt.started', attemptId: 'done-1', taskId: '1.2', root: '/root-A', routeId: 'r', profile: {} },
    { event: 'attempt.completed', attemptId: 'done-1', taskId: '1.2', root: '/root-A', status: 'completed' },
    // A live in-flight attempt in a sibling worktree of the SAME origin: different root,
    // so it must never be mistaken for an orphan (regression guard for cross-worktree corruption).
    { event: 'attempt.started', attemptId: 'sibling-worktree', taskId: '1.1', root: '/root-B', routeId: 'r', profile: {} },
  ];
  fs.writeFileSync(ledger, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);

  const closed = reconcileOrphanedAttempts({ ledger }, '/root-A');
  assert.equal(closed, 1, 'only the stranded /root-A start is reconciled');

  const records = fs.readFileSync(ledger, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const completions = records.filter(record => record.event === 'attempt.completed');
  const orphanCompletion = completions.find(record => record.attemptId === 'orphan-1');
  assert.ok(orphanCompletion, 'the orphan gets a completion record');
  assert.equal(orphanCompletion.status, 'interrupted');
  assert.equal(orphanCompletion.cause, 'environment-failure');
  assert.equal(orphanCompletion.valid, false);
  assert.ok(!completions.some(record => record.attemptId === 'sibling-worktree'), 'a sibling worktree is never touched');

  // Idempotent: a second pass closes nothing because the orphan is now completed.
  assert.equal(reconcileOrphanedAttempts({ ledger }, '/root-A'), 0);
});

function planWithCheckedTask() {
  return [
    '## Streams',
    '### Stream 1: s - complexity: S',
    '**Depends on:** none',
    '- [x] Task 9.1 - done outside loop [type:feature] [risk:low] [scope:local] [uncertainty:low] [ac:AC-1] - files: `a.js` - verify: `x` - **S**',
  ].join('\n');
}

test('reconcileOrphanedAttempts records work completed outside the loop as accepted', t => {
  const root = testRepo(t);
  const ledger = path.join(root, 'attempts.jsonl');
  const plan = path.join(root, 'plan.md');
  fs.writeFileSync(plan, planWithCheckedTask());
  fs.writeFileSync(ledger, `${JSON.stringify({ event: 'attempt.started', attemptId: 'z', taskId: '9.1', root: '/root-A', routeId: 'r', profile: {} })}\n`);

  assert.equal(reconcileOrphanedAttempts({ ledger, plan }, '/root-A'), 1);
  const records = fs.readFileSync(ledger, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const completion = records.find(record => record.event === 'attempt.completed' && record.attemptId === 'z');
  assert.equal(completion.disposition, 'accepted', 'a checked-off task was done out of band, not interrupted');
  assert.equal(completion.status, 'completed-out-of-band');
  assert.equal(completion.success, true);
  assert.equal(completion.valid, false, 'an unmeasured out-of-band completion must not train routing');
});

test('recoverActiveAttempt records an out-of-band completion when the task is already checked', t => {
  const root = testRepo(t);
  const pairDir = path.join(root, '.pair');
  fs.mkdirSync(pairDir);
  const plan = path.join(pairDir, 'plan.md');
  fs.writeFileSync(plan, planWithCheckedTask());
  const paths = {
    active: path.join(pairDir, 'active-attempt.json'),
    ledger: path.join(root, 'attempts.jsonl'),
    plan,
  };
  fs.writeFileSync(paths.active, JSON.stringify({ attemptId: '9.1-x', taskId: '9.1', routeId: 'r', profile: {} }));

  assert.equal(recoverActiveAttempt(paths), true);
  assert.equal(fs.existsSync(paths.active), false);
  const record = JSON.parse(fs.readFileSync(paths.ledger, 'utf8').trim());
  assert.equal(record.disposition, 'accepted');
  assert.equal(record.status, 'completed-out-of-band');
});

function gitIn(root, args) {
  return require('node:child_process').spawnSync('git', args, { cwd: root, encoding: 'utf8' });
}

test('revert-to-snapshot drops the failed attempt but preserves earlier uncommitted work and .pair', t => {
  const root = testRepo(t);
  fs.writeFileSync(path.join(root, 'a.txt'), 'v1\n');
  gitIn(root, ['add', 'a.txt']);
  gitIn(root, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'base']);
  // Earlier accepted-but-uncommitted work from previous tasks (the loop never commits).
  fs.writeFileSync(path.join(root, 'a.txt'), 'accepted work\n');
  fs.writeFileSync(path.join(root, 'earlier.txt'), 'earlier accepted new file\n');

  const snapshot = snapshotWorktree(root);

  // The failed attempt mangles tracked work and adds a file; the loop writes review evidence.
  fs.writeFileSync(path.join(root, 'a.txt'), 'bad rewrite\n');
  fs.writeFileSync(path.join(root, 'bad.txt'), 'junk\n');
  fs.mkdirSync(path.join(root, '.pair'), { recursive: true });
  fs.writeFileSync(path.join(root, '.pair', 'review.json'), '{"verdict":"fix-needed"}\n');

  const patch = path.join(root, 'rejected.patch');
  revertToSnapshot(root, snapshot, patch);

  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'accepted work\n', 'earlier uncommitted work survives');
  assert.equal(fs.existsSync(path.join(root, 'earlier.txt')), true, 'pre-attempt untracked file survives');
  assert.equal(fs.existsSync(path.join(root, 'bad.txt')), false, 'attempt-introduced file is removed');
  assert.equal(fs.existsSync(path.join(root, '.pair', 'review.json')), true, 'review evidence survives the revert');
  assert.match(fs.readFileSync(patch, 'utf8'), /bad rewrite/, 'rejected work is preserved as a patch');
});

test('pair-loop owns one live Active Pair Loop marker for its process lifetime', t => {
  const root = testRepo(t);
  const pairDir = path.join(root, '.pair');
  const plan = path.join(pairDir, 'plan.md');
  fs.mkdirSync(pairDir, { recursive: true });
  fs.writeFileSync(plan, '- [ ] Task 1\n');

  const active = beginActivePairLoop(root, plan);
  const markerFile = path.join(pairDir, 'active-loop.json');
  const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
  assert.equal(marker.schema, 1);
  assert.equal(marker.run_id, active.run_id);
  assert.equal(marker.pid, process.pid);
  assert.equal(marker.plan, '.pair/plan.md');

  assert.throws(() => beginActivePairLoop(root, plan), /already active/i);
  endActivePairLoop(root, { run_id: 'different-owner' });
  assert.equal(fs.existsSync(markerFile), true, 'a different owner cannot remove the marker');
  endActivePairLoop(root, active);
  assert.equal(fs.existsSync(markerFile), false);
});

test('readWorkLinkage resolves the canonical Work envelope and rejects mirror tampering', t => {
  const root = testRepo(t);
  const workId = 'work-20260712-pair-linkage';
  const spec = [
    '# Pair linkage',
    '',
    `- **Work ID:** \`${workId}\``,
    '',
    '## Engineering Quality Contract',
    '',
    'Approved attempt-linkage obligations.',
    '',
  ].join('\n');
  createWorkRoot({ repositoryRoot: root, workId, canonicalSpec: spec });
  writeDecisionRecord({
    repositoryRoot: root,
    record: {
      schema: 1,
      id: 'DR-001-pair-linkage',
      status: 'accepted',
      workId,
      title: 'Pair linkage',
      originSpec: `docs/work/${workId}/spec.md`,
      acceptanceCriteria: ['AC-1'],
      context: 'Attempts need canonical Work lineage.',
      decision: 'Record the Work envelope at attempt start.',
      rationale: 'Later evidence must resolve the approved intent.',
      alternatives: ['Keep linkage only in the active prompt.'],
      consequences: ['Attempt records carry stable semantic references.'],
      evidence: [],
      changes: [],
      supersedes: null,
      supersededBy: null,
    },
  });
  const plan = '# validated plan bytes\n';
  const approvedPlanDigest = planContractDigest(plan);
  const workFile = path.join(root, 'docs', 'work', workId, 'work.json');
  const work = JSON.parse(fs.readFileSync(workFile, 'utf8'));
  work.plan = {
    path: '.pair/plan.md',
    sha256: approvedPlanDigest,
    status: 'validated',
    independent_review: 'no-blockers',
  };
  fs.writeFileSync(workFile, `${JSON.stringify(work, null, 2)}\n`);

  assert.deepEqual(readWorkLinkage(root, plan), {
    workId,
    specDigest: crypto.createHash('sha256').update(spec).digest('hex'),
    planDigest: approvedPlanDigest,
    planStateDigest: crypto.createHash('sha256').update(plan).digest('hex'),
    decisionRecordIds: ['DR-001-pair-linkage'],
  });

  assert.throws(
    () => readWorkLinkage(root, `${plan}mapping changed\n`),
    /plan.*digest|approved.*plan/i,
  );

  fs.writeFileSync(workFile, `${JSON.stringify({
    ...work,
    decision_records: [`docs/work/${workId}/decisions/DR-999-missing.md`],
  }, null, 2)}\n`);
  assert.throws(() => readWorkLinkage(root, plan), /Decision Record|missing|canonical Work/i);
  fs.writeFileSync(workFile, `${JSON.stringify(work, null, 2)}\n`);

  fs.appendFileSync(path.join(root, '.pair', 'spec.md'), 'tampered\n');
  assert.throws(() => readWorkLinkage(root, plan), /mirror bytes/i);
});
