const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { assessAttempt, parseArgs, snapshotWorktree } = require('../scripts/pair-task');
const { parsePlan, planContractDigest } = require('../scripts/lib/pair-core');

const PLAN = [
  '## Streams',
  '### Stream 1: Greeting - complexity: M',
  '- [ ] Task 1.1 - deliver greeting behavior [type:feature] [risk:low] [ac:AC-1] - files: `src/g.js` - verify: `true` - **S**',
  '',
].join('\n');

test('unflagged defaults leave every new control off', () => {
  const options = parseArgs([]);
  assert.equal(options.reviewGate, false);
  assert.equal(options.reviseTest, undefined);
  assert.equal(options.reviewDecision, undefined);
  assert.equal(options.reviewStatus, undefined);
  assert.equal(options.addVerify, undefined);
  assert.equal(options.hitl, false);
  assert.equal(options.advisoryReview, false);
  assert.equal(options.handoverHelp, false);
});

test('an end-to-end slice with no new flags follows the pre-change transition sequence and evidence', t => {
  const scratchRoot = process.env.CLAUDE_SCRATCH_DIR || path.join(os.homedir(), '.claude-scratch');
  fs.mkdirSync(path.join(scratchRoot, 'my-claude-code', 'pair-v3-tests'), { recursive: true });
  const root = fs.mkdtempSync(path.join(scratchRoot, 'my-claude-code', 'pair-v3-tests', 'default-slice-'));
  const scratch = fs.mkdtempSync(path.join(scratchRoot, 'my-claude-code', 'pair-v3-tests', 'default-slice-scratch-'));
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
    attemptId: 'att-default-1',
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

  const result = assessAttempt({
    root,
    runtime: 'claude',
    options: parseArgs([]),
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

  assert.equal(result.action, 'complete-task');
  assert.match(fs.readFileSync(planPath, 'utf8'), /- \[x\] Task 1\.1/);

  const events = fs.readFileSync(paths.ledger, 'utf8').trim().split('\n').map(JSON.parse);
  const phases = events.filter((event) => event.event === 'phase.entered').map((event) => event.phase);
  assert.deepEqual(phases, ['verifying', 'reviewing'], 'the classic verifying -> reviewing sequence');
  const completed = events.find((event) => event.event === 'attempt.completed');
  assert.equal(completed.success, true);

  assert.equal(fs.existsSync(path.join(root, '.pair', 'review-gate.json')), false, 'no gate artifact appears');
  assert.equal(fs.existsSync(path.join(root, '.pair', 'review-ledger.jsonl')), false, 'no ledger appears');
  assert.equal(fs.existsSync(path.join(root, '.pair', 'extra-verify.json')), false, 'no store appears');
  const review = JSON.parse(fs.readFileSync(path.join(root, '.pair', 'review.json'), 'utf8'));
  assert.equal('review_gate' in review, false, 'review evidence carries no gate annotation');
});
