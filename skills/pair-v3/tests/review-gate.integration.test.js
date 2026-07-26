const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

// If the gate machinery regressed, assessAttempt would try to spawn a real
// reviewer; a 1ms budget makes that path fail fast instead of hanging.
process.env.PAIR_REVIEW_TIMEOUT_MS = '1';

const {
  assessAttempt,
  decideReviewGate,
  resolveReviewGate,
  reviewGatePath,
  reviewLedgerPath,
  snapshotWorktree,
} = require('../scripts/pair-task');
const { classifyOutcome, parsePlan, planContractDigest } = require('../scripts/lib/pair-core');

const PAIR_TASK = path.join(__dirname, '..', 'scripts', 'pair-task');

const PLAN = [
  '## Streams',
  '### Stream 1: Greeting - complexity: M',
  '- [ ] Task 1.1 - deliver greeting behavior [type:feature] [risk:critical] [ac:AC-1] - files: `src/g.js` - verify: `true` - **S**',
  '',
].join('\n');

const REVIEW = {
  verdict: 'fix-needed',
  recommended_action: 'local-fix',
  summary: 'the slice drops the requested name',
  findings: [{
    severity: 'MAJOR',
    origin: 'implementation',
    file: 'src/g.js',
    line: 3,
    title: 'greeting drops the name',
    detail: 'name parameter is ignored',
    failure_scenario: 'greet("x") returns the default greeting',
    suggestion: 'thread the name through',
  }],
};

function harness(t) {
  const scratchRoot = process.env.CLAUDE_SCRATCH_DIR || path.join(os.homedir(), '.claude-scratch');
  fs.mkdirSync(path.join(scratchRoot, 'my-claude-code', 'pair-v3-tests'), { recursive: true });
  const root = fs.mkdtempSync(path.join(scratchRoot, 'my-claude-code', 'pair-v3-tests', 'review-gate-'));
  const scratch = fs.mkdtempSync(path.join(scratchRoot, 'my-claude-code', 'pair-v3-tests', 'review-gate-scratch-'));
  childProcess.spawnSync('git', ['init', '-q'], { cwd: root });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'g.js'), 'module.exports = () => "hi";\n');
  const planPath = path.join(root, 'plan.md');
  fs.writeFileSync(planPath, PLAN);
  childProcess.spawnSync('git', ['add', '.'], { cwd: root });
  childProcess.spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'base'], { cwd: root });
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  const task = parsePlan(PLAN).tasks[0];
  const attempt = {
    attemptId: 'att-gate-1',
    taskId: task.id,
    workId: null,
    planDigest: planContractDigest(PLAN),
    phase: 'implementing',
    startedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.join(root, '.pair'), { recursive: true });
  const paths = {
    plan: planPath,
    active: path.join(root, '.pair', 'active-attempt.json'),
    ledger: path.join(scratch, 'ledger.jsonl'),
    scratch,
  };
  fs.writeFileSync(paths.active, JSON.stringify(attempt, null, 2));
  const snapshot = snapshotWorktree(root, scratch);

  const run = (options = {}) => assessAttempt({
    root,
    runtime: 'claude',
    options: { reviewGate: true, advisoryReview: false, dryRun: false, legacyV3: false, independentReview: true, ...options },
    paths,
    task,
    attempt,
    prior: [],
    snapshot,
    route: { id: 'route', model: 'default', effort: 'default' },
    worker: { status: 'completed', tests: [] },
    workerRun: { status: 0, stdout: '' },
    workerError: null,
  });

  return { root, paths, task, attempt, run };
}

function ledgerEvents(paths) {
  if (!fs.existsSync(paths.ledger)) return [];
  return fs.readFileSync(paths.ledger, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}

test('a verdict with findings pauses before the coordinator acts', t => {
  const { root, paths, task, attempt, run } = harness(t);
  resolveReviewGate(root, { taskId: task.id, attemptId: attempt.attemptId, review: REVIEW });

  const result = run();
  assert.deepEqual(result, { done: false, action: 'await-review-decision', recoverable: true, gated: true });

  const active = JSON.parse(fs.readFileSync(paths.active, 'utf8'));
  assert.equal(active.phase, 'reviewing', 'attempt parks at reviewing');
  const events = ledgerEvents(paths).map((event) => event.event);
  assert.ok(events.includes('review-gate.awaiting'));
  assert.ok(!events.includes('attempt.completed'), 'no outcome recorded before the decision');
  assert.ok(!events.some((event) => event === 'attempt.outcome'), 'classifyOutcome has not acted');
  assert.match(fs.readFileSync(paths.plan, 'utf8'), /- \[ \] Task 1\.1/, 'task stays open');

  const evidence = JSON.parse(fs.readFileSync(path.join(root, '.pair', 'review.json'), 'utf8'));
  assert.equal(evidence.findings.length, 1, 'findings surfaced for inspection');
});

test('--review-decision approve proceeds exactly as the reviewer recommended', t => {
  const { root, paths, task, attempt, run } = harness(t);
  resolveReviewGate(root, { taskId: task.id, attemptId: attempt.attemptId, review: REVIEW });
  assert.equal(run().action, 'await-review-decision');

  const entry = decideReviewGate(root, { decision: 'approve' });
  assert.equal(entry.human_decision, 'approve');
  assert.equal(entry.reviewer_recommended_action, 'local-fix');

  const result = run();
  assert.equal(result.action, 'local-fix', 'reviewer-recommended local-fix is applied');
  assert.equal(result.blocked, false);
  const active = JSON.parse(fs.readFileSync(paths.active, 'utf8'));
  assert.equal(active.phase, 'implementing', 'local fix resumes at implementing');
  assert.equal(fs.existsSync(reviewGatePath(root)), false, 'gate record is consumed');

  const evidence = JSON.parse(fs.readFileSync(path.join(root, '.pair', 'review.json'), 'utf8'));
  assert.equal(evidence.review_gate.human_decision, 'approve');
});

test('--review-decision override applies the chosen action and never invents one', t => {
  const { root, paths, task, attempt, run } = harness(t);
  resolveReviewGate(root, { taskId: task.id, attemptId: attempt.attemptId, review: REVIEW });
  assert.equal(run().action, 'await-review-decision');

  assert.throws(() => decideReviewGate(root, { decision: 'override', action: 'yolo', reason: 'x' }), /requires --action/);
  assert.throws(() => decideReviewGate(root, { decision: 'override', action: 'approve' }), /requires --reason/);

  const entry = decideReviewGate(root, { decision: 'override', action: 'approve', reason: 'finding is a false positive' });
  assert.equal(entry.human_decision, 'override');
  assert.equal(entry.override_action, 'approve');

  const result = run();
  assert.equal(result.action, 'complete-task', 'override-to-approve accepts the verified slice');
  assert.match(fs.readFileSync(paths.plan, 'utf8'), /- \[x\] Task 1\.1/, 'task completed');
  assert.equal(fs.existsSync(paths.active), false, 'attempt closed');

  const evidence = JSON.parse(fs.readFileSync(path.join(root, '.pair', 'review.json'), 'utf8'));
  assert.equal(evidence.review_gate.human_decision, 'override');
  assert.equal(evidence.review_gate.override_reason, 'finding is a false positive');
});

test('both decisions append secret-safe ledger entries', t => {
  const { root, task, attempt, run } = harness(t);
  resolveReviewGate(root, { taskId: task.id, attemptId: attempt.attemptId, review: REVIEW });
  assert.equal(run().action, 'await-review-decision');
  decideReviewGate(root, { decision: 'approve' });
  run();

  resolveReviewGate(root, { taskId: task.id, attemptId: attempt.attemptId, review: REVIEW });
  decideReviewGate(root, { decision: 'override', action: 'rewrite', reason: 'tests are tautological' });

  const entries = fs.readFileSync(reviewLedgerPath(root), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(entries.length, 2);
  for (const entry of entries) {
    assert.deepEqual(
      Object.keys(entry).sort(),
      ['at', 'attempt_id', 'human_decision', 'override_action', 'override_reason', 'reviewer_recommended_action', 'task_id', 'verdict_digest'],
      'ledger carries the divergence tuple and nothing else',
    );
    const serialized = JSON.stringify(entry).toLowerCase();
    for (const forbidden of ['prompt', 'transcript', 'reasoning', 'apikey', 'token']) {
      assert.ok(!serialized.includes(forbidden), `ledger must not carry ${forbidden}`);
    }
  }
  assert.equal(entries[0].human_decision, 'approve');
  assert.equal(entries[1].override_action, 'rewrite');
});

test('the CLI decision surface matches the gate and errors without a pending verdict', t => {
  const { root, task, attempt, run } = harness(t);

  const none = childProcess.spawnSync(process.execPath, [PAIR_TASK, '--review-decision', 'approve'], { cwd: root, encoding: 'utf8' });
  assert.notEqual(none.status, 0);
  assert.match(none.stderr, /no review verdict is awaiting a decision/);

  resolveReviewGate(root, { taskId: task.id, attemptId: attempt.attemptId, review: REVIEW });
  assert.equal(run().action, 'await-review-decision');

  const decided = childProcess.spawnSync(
    process.execPath,
    [PAIR_TASK, '--review-decision', 'override', '--action', 'approve', '--reason', 'false positive'],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(decided.status, 0, decided.stderr);
  assert.match(decided.stdout, /recorded override \(approve\) for task 1\.1/);
});

test('an override can never stand in for verification', () => {
  const outcome = classifyOutcome({
    workerStatus: 'completed',
    verification: 'fail',
    findings: [],
    recommendedAction: 'approve',
    runtimeStatus: 0,
    reviewStatus: 0,
  });
  assert.notEqual(outcome.disposition, 'accepted', 'a failing verification still fails after an override');
});
