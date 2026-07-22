const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  beginActivePairLoop,
  bindAttemptLedger,
  changedPathsSinceSnapshot,
  chooseRoute,
  endActivePairLoop,
  finalReviewCapStatus,
  finalGateFailureCapStatus,
  isExpectedFailingTestTask,
  liveInFlightRequest,
  parseArgs,
  parseWorkerResult,
  readWorkLinkage,
  reconcileOrphanedAttempts,
  recoverActiveAttempt,
  revertToSnapshot,
  runReview,
  shouldRunTaskReview,
  shouldRunAnchorReview,
  snapshotWorktree,
  taskHistory,
  verify,
  verifyRed,
  writeCumulativeReviewPatch,
  writeReviewSlicePatch,
  workAttemptCapStatus,
} = require('../scripts/pair-task');
const { planContractDigest } = require('../scripts/lib/pair-core');
const { reviewSessionFile } = require('../scripts/lib/review-session');
const {
  createWorkRoot,
  writeDecisionRecord,
} = require('../../brainstorming/scripts/work-lineage.cjs');

test('Pair v4 has no implicit count ceilings while legacy v3 keeps its compatibility ceiling', () => {
  const keys = [
    'PAIR_MAX_TASK_ATTEMPTS',
    'PAIR_MAX_WORK_ATTEMPTS',
    'PAIR_MAX_FINAL_REVIEWS',
    'PAIR_LEGACY_V3',
  ];
  const prior = new Map(keys.map(key => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  try {
    assert.deepEqual(
      {
        task: parseArgs([]).maxAttempts,
        work: parseArgs([]).maxWorkAttempts,
        final: parseArgs([]).maxFinalReviews,
      },
      { task: null, work: null, final: null },
    );
    assert.equal(parseArgs(['--legacy-v3']).maxAttempts, 3);
    assert.equal(parseArgs(['--max-attempts', '7']).maxAttempts, 7);
    assert.equal(parseArgs(['--max-work-attempts', '11']).maxWorkAttempts, 11);
    assert.equal(parseArgs(['--max-final-reviews', '5']).maxFinalReviews, 5);
  } finally {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('explicit independent-review opt-out disables slice review', () => {
  assert.equal(parseArgs(['--no-independent-review']).independentReview, false);
  assert.equal(shouldRunTaskReview({ risk: 'critical' }, { independentReview: false }, {}), false);
});

test('advisory review keeps the independent reviewer enabled without requiring remediation', () => {
  assert.equal(parseArgs(['--advisory-review']).advisoryReview, true);
  assert.equal(parseArgs(['--advisory-review']).independentReview, true);
});

test('liveInFlightRequest preserves a journaled reviewer request until its completion event clears it', () => {
  const active = {
    request_id: 'review-1',
    request_pid: 321,
    request_kind: 'slice-review',
    phase: 'reviewing',
  };
  assert.equal(liveInFlightRequest({ in_flight_request: active }, pid => pid === 321), active);
  assert.equal(liveInFlightRequest({ in_flight_request: active }, () => false), active);
  assert.equal(liveInFlightRequest({ in_flight_request: null }, () => true), null);
});

function testRepo(t) {
  const scratchRoot = process.env.CLAUDE_SCRATCH_DIR
    || path.join(os.homedir(), '.claude-scratch');
  fs.mkdirSync(path.join(scratchRoot, 'my-claude-code', 'pair-v3-tests'), { recursive: true });
  const root = fs.mkdtempSync(path.join(scratchRoot, 'my-claude-code', 'pair-v3-tests', 'repo-'));
  require('node:child_process').spawnSync('git', ['init', '-q'], { cwd: root });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('attempt history stays repository-local when the optional legacy source changes', t => {
  const root = testRepo(t);
  fs.mkdirSync(path.join(root, '.pair'), { recursive: true });
  const first = path.join(root, 'data-a', 'attempts.jsonl');
  const second = path.join(root, 'data-b', 'attempts.jsonl');

  assert.equal(
    bindAttemptLedger(root, first, 'work-20260718-ledger').ledger,
    '.pair/runs/work-20260718-ledger/events.jsonl',
  );
  assert.doesNotThrow(() => bindAttemptLedger(root, second, 'work-20260718-ledger'));
  const binding = JSON.parse(fs.readFileSync(path.join(root, '.pair', 'ledger-bindings.json'), 'utf8'));
  assert.equal(binding.authority, 'repository');
  assert.equal(
    binding.bindings['work:work-20260718-ledger'].ledger,
    '.pair/runs/work-20260718-ledger/events.jsonl',
  );
});

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
  const redCommand = 'node -e "console.error(\'greeting assertion failed\'); process.exit(1)"';
  const result = verify(root, {
    type: 'test', phase: 'red', tddMode: 'red-contract', redMode: 'assertion',
    redVerify: redCommand, redExpected: 'greeting assertion failed', testFiles: [],
  }, {
    tests: [{ command: redCommand, status: 'fail' }],
  });

  assert.equal(result.status, 'pass');
  assert.match(result.output, /RED assertion failure reproduced/);
});

test('tests-first detection honors the explicit red phase', () => {
  assert.equal(isExpectedFailingTestTask({ type: 'test', phase: 'red', tddMode: 'red-contract' }), true);
  assert.equal(isExpectedFailingTestTask({ type: 'test', phase: 'red' }), false, 'legacy arbitrary RED tasks are not accepted');
});

test('Pair-lite uses a conditional task-review policy and always permits an explicit override', () => {
  assert.equal(shouldRunTaskReview({ risk: 'low' }, {}, {}), false);
  assert.equal(shouldRunTaskReview({ risk: 'high' }, {}, {}), false);
  assert.equal(shouldRunTaskReview({ risk: 'critical' }, {}, {}), true);
  assert.equal(shouldRunTaskReview({ risk: 'low' }, {}, { PAIR_TASK_REVIEW: 'all' }), true);
  assert.equal(shouldRunTaskReview({ risk: 'critical' }, {}, { PAIR_TASK_REVIEW: 'off' }), false);
  assert.equal(shouldRunTaskReview({ risk: 'low' }, { legacyV3: true }, {}), true);
});

test('Work-level attempt budget spans plan digests and ignores interruptions', () => {
  const ledger = [
    { event: 'attempt.completed', attemptId: 'attempt-a', status: 'completed', repositoryId: 'repo', workId: 'work', planDigest: 'old' },
    { event: 'attempt.completed', attemptId: 'attempt-a', status: 'completed', repositoryId: 'repo', workId: 'work', planDigest: 'old' },
    { event: 'attempt.completed', attemptId: 'attempt-b', status: 'interrupted', repositoryId: 'repo', workId: 'work', planDigest: 'new' },
    { event: 'attempt.completed', attemptId: 'attempt-c', status: 'completed', repositoryId: 'repo', workId: 'work', planDigest: 'new' },
    { event: 'attempt.completed', attemptId: 'attempt-d', status: 'completed', repositoryId: 'other', workId: 'work', planDigest: 'new' },
  ];

  assert.deepEqual(workAttemptCapStatus(ledger, 'repo', 'work', 2), {
    attempts: 2,
    maxAttempts: 2,
    overCap: true,
  });
});

test('Task retry history counts one completion per attempt ID', () => {
  const completion = {
    event: 'attempt.completed',
    attemptId: 'attempt-a',
    taskId: '1.1',
    repositoryId: 'repo',
    workId: 'work',
    planDigest: 'digest',
    status: 'completed',
    action: 'retry-verification',
  };
  assert.equal(
    taskHistory([completion, { ...completion }], '1.1', 'repo', 'work', 'digest').length,
    1,
  );
});

test('the cumulative verdict allows one closure review and then requires human takeover', () => {
  const ledger = [
    { event: 'final-review.completed', repositoryId: 'repo', workId: 'work', classification: 'findings' },
    { event: 'final-review.completed', repositoryId: 'repo', workId: 'other', classification: 'findings' },
  ];
  assert.deepEqual(finalReviewCapStatus(ledger, 'repo', 'work', 2), {
    reviews: 1,
    maxReviews: 2,
    overCap: false,
  });
  ledger.push({ event: 'final-review.completed', repositoryId: 'repo', workId: 'work', classification: 'findings' });
  assert.equal(finalReviewCapStatus(ledger, 'repo', 'work', 2).overCap, true);
});

test('the cumulative deterministic gate stops after two failed replays', () => {
  const ledger = [
    { event: 'final-gate.completed', repositoryId: 'repo', workId: 'work', status: 'fail' },
    { event: 'final-gate.completed', repositoryId: 'repo', workId: 'work', status: 'pass' },
    { event: 'final-gate.completed', repositoryId: 'repo', workId: 'work', status: 'fail' },
  ];
  assert.deepEqual(finalGateFailureCapStatus(ledger, 'repo', 'work', 2), {
    failures: 2,
    maxFailures: 2,
    overCap: true,
  });
});

test('verifyRed rejects arbitrary non-zero and infrastructure failures', t => {
  const root = testRepo(t);
  const wrongSignal = verifyRed(root, {
    redMode: 'assertion',
    redVerify: 'node -e "console.error(\'different failure\'); process.exit(1)"',
    redExpected: 'expected assertion',
    testFiles: [],
  });
  assert.equal(wrongSignal.status, 'fail');
  assert.match(wrongSignal.output, /was not reproduced/);

  const infrastructure = verifyRed(root, {
    redMode: 'runtime',
    redVerify: 'node -e "console.error(\'Cannot find module expected-signal\'); process.exit(1)"',
    redExpected: 'expected-signal',
    testFiles: [],
  });
  assert.equal(infrastructure.status, 'fail');
  assert.match(infrastructure.output, /infrastructure/);

  const declaredLocalCompileFailure = verifyRed(root, {
    redMode: 'compile',
    redVerify: 'node -e "console.error(\'Cannot find module ./src/greeting.js\'); process.exit(1)"',
    redExpected: 'Cannot find module ./src/greeting.js',
    testFiles: [],
  });
  assert.equal(declaredLocalCompileFailure.status, 'pass', 'an exact compile-mode missing local module can be the intended RED signal');
});

test('recoverActiveAttempt preserves the same attempt and exact phase', t => {
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
    phase: 'reviewing',
  }));

  assert.equal(recoverActiveAttempt(paths), true);
  assert.equal(fs.existsSync(paths.active), true);
  const record = JSON.parse(fs.readFileSync(paths.ledger, 'utf8').trim());
  assert.equal(record.event, 'attempt.recovered');
  assert.equal(record.attemptId, '1.1-interrupted');
  assert.equal(record.phase, 'reviewing');
  assert.equal(record.resume_target, 'reviewing');
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

test('runReview uses generic read-only Codex exec so its custom review prompt can coexist with the schema', t => {
  const root = testRepo(t);
  const result = runReview({
    runtime: 'codex',
    route: { id: 'codex-default-medium', model: 'default' },
    root,
    task: { id: '2.1', text: 'review a change', risk: 'medium' },
    planPath: '.pair/plan.md',
    scratchDir: root,
    attemptId: '2.1-review',
    timeoutMs: 1,
    dryRun: true,
    externalSandbox: false,
  });

  assert.equal(result.command.file, 'codex');
  assert.equal(result.command.args[0], 'exec');
  assert.ok(!result.command.args.includes('review'));
  assert.ok(!result.command.args.includes('--uncommitted'));
  assert.ok(!result.command.args.includes('--ephemeral'));
  assert.deepEqual(
    result.command.args.slice(2, 6),
    ['--sandbox', 'read-only', '-C', root],
  );
  assert.ok(result.command.args.includes('--output-schema'));
  assert.match(result.command.args.at(-1), /Independently review the immutable complete changed-file patch/);
  assert.match(result.command.args.at(-1), /complete changed-file patch.*additional files/i);
  assert.match(result.command.args.at(-1), /origin.*plan/s);
});

test('runReview uses an external sandbox command for hosted Codex', t => {
  const root = testRepo(t);
  const result = runReview({
    runtime: 'codex',
    route: { id: 'codex-default-medium', model: 'default' },
    root,
    task: { id: '2.2', text: 'review hosted work', risk: 'medium' },
    planPath: '.pair/plan.md',
    scratchDir: root,
    attemptId: '2.2-review',
    timeoutMs: 1,
    dryRun: true,
    externalSandbox: true,
    priorReview: {
      findings: [{
        severity: 'BLOCKER',
        origin: 'implementation',
        file: 'src/result.js',
        line: 7,
        title: 'Result drops required evidence',
        detail: 'The returned result omits the evidence field.',
        failure_scenario: 'A real caller cannot render evidence.',
        suggestion: 'Preserve evidence in the result.',
      }],
    },
  });

  assert.ok(result.command.args.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(result.command.args.includes('--skip-git-repo-check'));
  assert.equal(result.command.args.includes('--sandbox'), false);
  assert.ok(result.command.args.includes('model_reasoning_effort="medium"'));
  assert.match(result.command.args.at(-1), /Result drops required evidence/);
  assert.match(result.command.args.at(-1), /closure review/i);
  assert.match(result.command.args.at(-1), /at most 8 shell commands/i);
});

test('runReview materializes the canonical complete patch in the external reviewer snapshot', t => {
  const root = testRepo(t);
  const scratchRoot = fs.mkdtempSync(path.join(path.dirname(root), 'review-snapshot-parent-'));
  const fakeBin = path.join(scratchRoot, 'bin');
  const capture = path.join(scratchRoot, 'reviewer-capture.json');
  const completePatch = path.join(
    root,
    '.pair',
    'runs',
    'work-review-snapshot',
    'attempts',
    '1.1-snapshot',
    'complete.patch',
  );
  fs.mkdirSync(path.dirname(completePatch), { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(path.join(root, '.pair'), { recursive: true });
  fs.writeFileSync(path.join(root, '.pair', 'plan.md'), '# Plan\n');
  fs.writeFileSync(completePatch, 'Review Slice task: 1.1\n');
  const staleSessionFile = reviewSessionFile(root);
  fs.mkdirSync(path.dirname(staleSessionFile), { recursive: true });
  fs.writeFileSync(staleSessionFile, `${JSON.stringify({
    schema: 1,
    product: 'pair-v4',
    runtime: 'codex',
    session_id: 'reviewer-bound-to-an-old-snapshot',
    snapshot_digest: '0'.repeat(64),
  })}\n`);
  fs.writeFileSync(path.join(fakeBin, 'codex'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const output = args[args.indexOf('--output-last-message') + 1];
const prompt = args.at(-1);
const patch = prompt.match(/Review Slice patch: (.+)/)?.[1];
fs.writeFileSync(process.env.PAIR_TEST_REVIEW_CAPTURE, JSON.stringify({
  cwd: process.cwd(),
  patch,
  patchExists: Boolean(patch) && fs.existsSync(patch),
  planExists: fs.existsSync(path.join(process.cwd(), '.pair', 'plan.md')),
}));
fs.writeFileSync(output, JSON.stringify({
  verdict: 'approve', recommended_action: 'approve', summary: 'snapshot has the complete patch', findings: [],
}));
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'review-snapshot-session' }) + '\\n');
`);
  fs.chmodSync(path.join(fakeBin, 'codex'), 0o755);
  const previousPath = process.env.PATH;
  const previousCapture = process.env.PAIR_TEST_REVIEW_CAPTURE;
  const previousTransport = process.env.PAIR_REVIEW_TRANSPORT;
  process.env.PATH = `${fakeBin}${path.delimiter}${previousPath || ''}`;
  process.env.PAIR_TEST_REVIEW_CAPTURE = capture;
  process.env.PAIR_REVIEW_TRANSPORT = 'direct';
  t.after(() => {
    process.env.PATH = previousPath;
    if (previousCapture === undefined) delete process.env.PAIR_TEST_REVIEW_CAPTURE;
    else process.env.PAIR_TEST_REVIEW_CAPTURE = previousCapture;
    if (previousTransport === undefined) delete process.env.PAIR_REVIEW_TRANSPORT;
    else process.env.PAIR_REVIEW_TRANSPORT = previousTransport;
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  });

  const result = runReview({
    runtime: 'codex',
    route: { id: 'codex-default-medium', model: 'default' },
    root,
    task: { id: '1.1', text: 'review snapshot evidence', risk: 'medium' },
    planPath: '.pair/plan.md',
    scratchDir: scratchRoot,
    attemptId: '1.1-snapshot',
    timeoutMs: 5_000,
    dryRun: false,
    externalSandbox: true,
    reviewSlicePath: completePatch,
  });

  const observed = JSON.parse(fs.readFileSync(capture, 'utf8'));
  assert.equal(result.status, 0);
  assert.equal(result.command.resumed, false, 'a session bound to another snapshot must not be resumed');
  assert.match(observed.cwd, /review-snapshot-/);
  assert.equal(observed.planExists, true);
  assert.equal(observed.patchExists, true);
  assert.equal(
    observed.patch,
    path.join(observed.cwd, '.pair', 'runs', 'work-review-snapshot', 'attempts', '1.1-snapshot', 'complete.patch'),
  );
  assert.notEqual(observed.patch, completePatch, 'the reviewer must read the snapshot copy, never the source patch');
});

test('anchor reviews are opt-in instead of silently doubling successful review cost', () => {
  const review = { verdict: 'approve', recommended_action: 'approve', findings: [] };
  assert.equal(shouldRunAnchorReview('attempt-ff', { risk: 'high' }, review, {}), false);
  assert.equal(
    shouldRunAnchorReview('attempt-00', { risk: 'high' }, review, { PAIR_ANCHOR_REVIEW_RATE: '1' }),
    true,
  );
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

test('chooseRoute scopes retry history to the current plan contract and skips interruptions', () => {
  const task = { id: '6.1', type: 'feature', complexity: 'S', risk: 'low', scope: 'local', uncertainty: 'low' };
  const ledger = [
    {
      event: 'attempt.completed', taskId: '6.1', repositoryId: 'repo-A', workId: 'work-A',
      planDigest: 'old-plan', routeId: 'claude-opus-high', action: 'retry-stronger',
      valid: true, status: 'completed',
    },
    {
      event: 'attempt.completed', taskId: '6.1', repositoryId: 'repo-A', workId: 'work-A',
      planDigest: 'current-plan', routeId: 'claude-sonnet-medium', action: 'retry-review',
      valid: true, status: 'completed',
    },
    {
      event: 'attempt.completed', taskId: '6.1', repositoryId: 'repo-A', workId: 'work-A',
      planDigest: 'current-plan', routeId: 'claude-opus-high', action: 'retry-infrastructure',
      valid: false, status: 'interrupted',
    },
  ];

  assert.equal(
    chooseRoute(task, 'claude', ledger, {}, 'repo-A', 'work-A', 'current-plan').id,
    'claude-sonnet-medium',
    'the pending same-route review retry survives an interruption and old plan history is ignored',
  );
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

test('verify warns but accepts an ordinary additional repository file outside expected files', t => {
  const root = testRepo(t);
  fs.writeFileSync(path.join(root, 'owned.js'), 'base\n');
  fs.writeFileSync(path.join(root, 'outside.js'), 'base\n');
  gitIn(root, ['add', 'owned.js', 'outside.js']);
  gitIn(root, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'base']);
  const snapshot = snapshotWorktree(root);
  fs.writeFileSync(path.join(root, 'outside.js'), 'changed\n');

  const result = verify(root, {
    files: ['owned.js'],
    verify: 'node -e "process.exit(0)"',
    testFiles: [],
  }, { tests: [] }, snapshot);
  assert.equal(result.status, 'pass');
  assert.equal(result.ownership.status, 'warn');
  assert.deepEqual(result.ownership.additional, ['outside.js']);
  assert.match(result.ownership.output, /attribution warning.*outside\.js/i);
});

test('ownership exempts only Pair runtime markers, not worker changes under .pair', t => {
  const root = testRepo(t);
  fs.mkdirSync(path.join(root, '.pair'), { recursive: true });
  fs.writeFileSync(path.join(root, '.pair', 'plan.md'), 'approved plan\n');
  gitIn(root, ['add', '.pair/plan.md']);
  gitIn(root, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'plan']);
  const snapshot = snapshotWorktree(root);

  fs.writeFileSync(path.join(root, '.pair', 'active-attempt.json'), '{}\n');
  fs.writeFileSync(path.join(root, '.pair', 'active-loop.json'), '{}\n');
  fs.writeFileSync(path.join(root, '.pair', 'plan.md'), 'worker-mutated plan\n');
  const result = verify(root, {
    files: [],
    verify: 'node -e "process.exit(0)"',
    testFiles: [],
  }, { tests: [] }, snapshot);

  assert.equal(result.status, 'fail');
  assert.deepEqual(result.ownership.outside, ['.pair/plan.md']);
});

test('snapshot records whether tracked state required a synthetic commit', t => {
  const root = testRepo(t);
  fs.writeFileSync(path.join(root, 'a.txt'), 'base\n');
  gitIn(root, ['add', 'a.txt']);
  gitIn(root, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'base']);
  fs.writeFileSync(path.join(root, 'a.txt'), 'tracked change\n');

  const snapshot = snapshotWorktree(root);

  assert.deepEqual(snapshot.trackedDirtyPaths, ['a.txt']);
  assert.match(snapshot.commit, /^[a-f0-9]{40,64}$/);
});

test('read-only Git metadata still snapshots, compares, and restores a dirty worktree', t => {
  const root = testRepo(t);
  const snapshotRoot = `${root}-snapshots`;
  const gitDirectory = path.join(root, '.git');
  t.after(() => fs.rmSync(snapshotRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.pair'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, '.pair', 'plan-review.json'), '{"approval":"old"}\n');
  fs.writeFileSync(path.join(root, 'src', 'owned.js'), 'base\n');
  gitIn(root, ['add', '.pair/plan-review.json', 'src/owned.js']);
  gitIn(root, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'base']);
  fs.writeFileSync(path.join(root, '.pair', 'plan-review.json'), '{"approval":"human-override"}\n');
  const indexBefore = crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(gitDirectory, 'index')))
    .digest('hex');

  fs.chmodSync(gitDirectory, 0o555);
  try {
    const prohibited = gitIn(root, ['stash', 'create', 'permission-probe']);
    assert.notEqual(prohibited.status, 0, 'the test must exercise a real Git metadata-write denial');
    assert.match(prohibited.stderr, /index\.lock|could not write index|operation not permitted|permission denied/i);

    const snapshot = snapshotWorktree(root, snapshotRoot);
    assert.equal(snapshot.strategy, 'worktree-copy');
    assert.equal(snapshot.commit, null);

    fs.writeFileSync(path.join(root, 'src', 'owned.js'), 'attempt change\n');
    assert.deepEqual(changedPathsSinceSnapshot(root, snapshot), ['src/owned.js']);
    const reviewPatch = path.join(snapshotRoot, 'review-slice.patch');
    writeReviewSlicePatch(root, {
      id: '1.1',
      files: ['src/owned.js'],
      acceptanceCriteria: ['AC-1'],
    }, snapshot, reviewPatch);
    assert.match(fs.readFileSync(reviewPatch, 'utf8'), /attempt change/);
    assert.doesNotMatch(fs.readFileSync(reviewPatch, 'utf8'), /human-override/);

    fs.writeFileSync(path.join(root, '.pair', 'plan-review.json'), '{"approval":"worker-mutated"}\n');
    assert.deepEqual(changedPathsSinceSnapshot(root, snapshot), [
      '.pair/plan-review.json',
      'src/owned.js',
    ]);

    revertToSnapshot(root, snapshot, path.join(snapshotRoot, 'rejected.patch'));
    assert.equal(
      fs.readFileSync(path.join(root, '.pair', 'plan-review.json'), 'utf8'),
      '{"approval":"human-override"}\n',
    );
    assert.equal(fs.readFileSync(path.join(root, 'src', 'owned.js'), 'utf8'), 'base\n');
    assert.deepEqual(changedPathsSinceSnapshot(root, snapshot), []);
    const indexAfter = crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(gitDirectory, 'index')))
      .digest('hex');
    assert.equal(indexAfter, indexBefore, 'snapshot and restore must not mutate the Git index');

    fs.chmodSync(gitDirectory, 0o755);
    fs.writeFileSync(path.join(root, 'src', 'owned.js'), 'staged outside Pair\n');
    assert.equal(gitIn(root, ['add', 'src/owned.js']).status, 0);
    assert.throws(
      () => changedPathsSinceSnapshot(root, snapshot),
      /Git index changed.*refusing/i,
      'the metadata-free baseline must fail closed if another process changes the index',
    );
  } finally {
    fs.chmodSync(gitDirectory, 0o755);
  }
});

test('untracked-only dirty snapshot restores a rejected tracked deletion exactly', t => {
  const root = testRepo(t);
  const snapshotRoot = `${root}-snapshots`;
  t.after(() => fs.rmSync(snapshotRoot, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'a.txt'), 'base\n');
  gitIn(root, ['add', 'a.txt']);
  gitIn(root, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'base']);
  fs.writeFileSync(path.join(root, 'preexisting.txt'), 'before\n');
  const snapshot = snapshotWorktree(root, snapshotRoot);
  assert.equal(snapshot.commit, null, 'untracked-only dirtiness needs no tracked snapshot commit');
  assert.deepEqual(snapshot.trackedDirtyPaths, []);

  fs.rmSync(path.join(root, 'a.txt'));
  fs.writeFileSync(path.join(root, 'preexisting.txt'), 'damaged\n');
  fs.writeFileSync(path.join(root, 'attempt-only.txt'), 'junk\n');
  revertToSnapshot(root, snapshot, path.join(snapshotRoot, 'rejected.patch'));

  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'base\n');
  assert.equal(fs.readFileSync(path.join(root, 'preexisting.txt'), 'utf8'), 'before\n');
  assert.equal(fs.existsSync(path.join(root, 'attempt-only.txt')), false);
  assert.deepEqual(
    changedPathsSinceSnapshot(root, snapshot).filter(file => !file.startsWith('.pair/')),
    [],
    'post-restore worktree must equal the captured pre-attempt state',
  );
});

test('cumulative review patch includes accepted additional files beyond the plan forecast', t => {
  const root = testRepo(t);
  fs.writeFileSync(path.join(root, 'expected.js'), 'before expected\n');
  fs.writeFileSync(path.join(root, 'additional.js'), 'before additional\n');
  gitIn(root, ['add', 'expected.js', 'additional.js']);
  gitIn(root, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'base']);
  const base = gitIn(root, ['rev-parse', 'HEAD']).stdout.trim();
  fs.writeFileSync(path.join(root, 'expected.js'), 'after expected\n');
  fs.writeFileSync(path.join(root, 'additional.js'), 'after additional\n');
  const output = path.join(root, 'cumulative.patch');
  const plan = [
    '## Streams',
    '### Stream 1: cumulative - complexity: S',
    '**Depends on:** none',
    '- [x] Task 1.1 - finish behavior [type:feature] [risk:high] [scope:contract] [uncertainty:low] [ac:AC-1] - files: `expected.js` - verify: `node --test` - **S**',
    '',
  ].join('\n');
  const ledger = [
    { event: 'attempt.started', repositoryId: 'repo', workId: 'work', snapshotCommit: base },
    {
      event: 'attempt.completed', repositoryId: 'repo', workId: 'work', disposition: 'accepted',
      verification: { ownership: { changed: ['expected.js', 'additional.js'] } },
    },
  ];

  const result = writeCumulativeReviewPatch(
    root,
    plan,
    ledger,
    { workId: 'work', planDigest: 'digest' },
    'repo',
    output,
  );

  const patch = fs.readFileSync(output, 'utf8');
  assert.deepEqual(result.files, ['additional.js', 'expected.js']);
  assert.deepEqual(result.additional, ['additional.js']);
  assert.match(patch, /after expected/);
  assert.match(patch, /after additional/);
  assert.match(patch, /Additional changed files \(advisory attribution\): additional\.js/);
});

test('revert fails closed when Git cannot restore the tracked snapshot', t => {
  const root = testRepo(t);
  fs.writeFileSync(path.join(root, 'a.txt'), 'attempt change\n');

  assert.throws(
    () => revertToSnapshot(root, {
      commit: '0000000000000000000000000000000000000000',
      dirty: true,
      trackedDirtyPaths: ['a.txt'],
      untracked: [],
      untrackedHashes: {},
      untrackedCopies: {},
    }, path.join(root, 'rejected.patch')),
    /restoration invariant|could not restore/i,
  );
});

test('verify preserves phase separation by rejecting test changes during GREEN', t => {
  const root = testRepo(t);
  fs.writeFileSync(path.join(root, 'behavior.test.js'), 'base test\n');
  fs.writeFileSync(path.join(root, 'behavior.js'), 'base implementation\n');
  gitIn(root, ['add', 'behavior.test.js', 'behavior.js']);
  gitIn(root, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'base']);
  const sliceSnapshot = snapshotWorktree(root);
  fs.writeFileSync(path.join(root, 'behavior.test.js'), 'verified RED test\n');
  const greenSnapshot = snapshotWorktree(root);
  fs.writeFileSync(path.join(root, 'behavior.test.js'), 'weakened during GREEN\n');
  fs.writeFileSync(path.join(root, 'behavior.js'), 'implementation\n');

  const result = verify(root, {
    files: ['behavior.test.js', 'behavior.js'],
    testFiles: ['behavior.test.js'],
    verify: 'node -e "process.exit(0)"',
  }, { tests: [] }, sliceSnapshot, greenSnapshot);
  assert.equal(result.status, 'fail');
  assert.match(result.output, /GREEN phase modified RED-verified tests/);
});

test('revert-to-snapshot drops the failed attempt but preserves earlier uncommitted work and .pair', t => {
  const root = testRepo(t);
  const snapshotRoot = `${root}-snapshots`;
  t.after(() => fs.rmSync(snapshotRoot, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'a.txt'), 'v1\n');
  gitIn(root, ['add', 'a.txt']);
  gitIn(root, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'base']);
  // Earlier accepted-but-uncommitted work from previous tasks (the loop never commits).
  fs.writeFileSync(path.join(root, 'a.txt'), 'accepted work\n');
  fs.writeFileSync(path.join(root, 'earlier.txt'), 'earlier accepted new file\n');
  fs.mkdirSync(path.join(root, '.pair'), { recursive: true });
  fs.writeFileSync(path.join(root, '.pair', 'plan.md'), 'approved plan\n');

  const snapshot = snapshotWorktree(root, snapshotRoot);

  // The failed attempt mangles tracked work and adds a file; the loop writes review evidence.
  fs.writeFileSync(path.join(root, 'a.txt'), 'bad rewrite\n');
  fs.writeFileSync(path.join(root, 'earlier.txt'), 'bad untracked rewrite\n');
  fs.writeFileSync(path.join(root, 'bad.txt'), 'junk\n');
  fs.writeFileSync(path.join(root, '.pair', 'plan.md'), 'worker-mutated plan\n');
  fs.writeFileSync(path.join(root, '.pair', 'worker-junk.txt'), 'worker junk\n');
  fs.writeFileSync(path.join(root, '.pair', 'review.json'), '{"verdict":"fix-needed"}\n');

  const reviewPatch = path.join(snapshotRoot, 'review-slice.patch');
  writeReviewSlicePatch(root, {
    id: '1.2',
    files: ['earlier.txt'],
    acceptanceCriteria: ['AC-1'],
  }, snapshot, reviewPatch);
  const reviewPatchText = fs.readFileSync(reviewPatch, 'utf8');
  assert.match(reviewPatchText, /bad untracked rewrite/, 'review patch includes modified pre-existing untracked files');
  assert.match(reviewPatchText, /bad rewrite/, 'review patch includes ordinary changes outside the expected-file forecast');
  assert.match(reviewPatchText, /junk/, 'review patch includes newly-created additional files');
  assert.match(reviewPatchText, /Additional changed files \(advisory attribution\): .*a\.txt.*bad\.txt/);

  const patch = path.join(root, 'rejected.patch');
  revertToSnapshot(root, snapshot, patch);

  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'accepted work\n', 'earlier uncommitted work survives');
  assert.equal(fs.readFileSync(path.join(root, 'earlier.txt'), 'utf8'), 'earlier accepted new file\n', 'pre-attempt untracked bytes are restored');
  assert.equal(fs.existsSync(path.join(root, 'bad.txt')), false, 'attempt-introduced file is removed');
  assert.equal(fs.existsSync(path.join(root, '.pair', 'review.json')), true, 'review evidence survives the revert');
  assert.equal(fs.readFileSync(path.join(root, '.pair', 'plan.md'), 'utf8'), 'approved plan\n', 'worker plan edits are restored');
  assert.equal(fs.existsSync(path.join(root, '.pair', 'worker-junk.txt')), false, 'worker-created .pair files are removed');
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
    independent_review: `no-blockers:${approvedPlanDigest}:codex/default`,
  };
  fs.writeFileSync(workFile, `${JSON.stringify(work, null, 2)}\n`);

  assert.deepEqual(readWorkLinkage(root, plan), {
    workId,
    specDigest: crypto.createHash('sha256').update(spec).digest('hex'),
    planDigest: approvedPlanDigest,
    planStateDigest: crypto.createHash('sha256').update(plan).digest('hex'),
    decisionRecordIds: ['DR-001-pair-linkage'],
  });

  work.plan.independent_review = `human-override:${approvedPlanDigest}:user:${'a'.repeat(12)}`;
  fs.writeFileSync(workFile, `${JSON.stringify(work, null, 2)}\n`);
  assert.doesNotThrow(() => readWorkLinkage(root, plan));

  work.plan.independent_review = `human-override:${approvedPlanDigest}:unverified`;
  fs.writeFileSync(workFile, `${JSON.stringify(work, null, 2)}\n`);
  assert.throws(
    () => readWorkLinkage(root, plan),
    /independent challenge|explicit human override/i,
  );
  work.plan.independent_review = `no-blockers:${approvedPlanDigest}:codex/default`;
  fs.writeFileSync(workFile, `${JSON.stringify(work, null, 2)}\n`);

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
