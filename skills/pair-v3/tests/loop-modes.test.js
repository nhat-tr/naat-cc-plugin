const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { chooseRoute, isDelegable } = require('../scripts/pair-task');
const { validPairPlan } = require('./support/pair-plan-fixture');

const PAIR_TASK = path.join(__dirname, '..', 'scripts', 'pair-task');

function testRepo(t) {
  const scratchRoot = process.env.CLAUDE_SCRATCH_DIR || path.join(os.homedir(), '.claude-scratch');
  fs.mkdirSync(path.join(scratchRoot, 'my-claude-code', 'pair-v3-tests'), { recursive: true });
  const root = fs.mkdtempSync(path.join(scratchRoot, 'my-claude-code', 'pair-v3-tests', 'modes-'));
  childProcess.spawnSync('git', ['init', '-q'], { cwd: root });
  fs.writeFileSync(path.join(root, 'a.txt'), 'base\n');
  childProcess.spawnSync('git', ['add', 'a.txt'], { cwd: root });
  childProcess.spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'base'], { cwd: root });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function runPairTask(root, args, env = {}) {
  return childProcess.spawnSync(process.execPath, [PAIR_TASK, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

test('isDelegable only delegates low-risk local work to headless workers', () => {
  assert.equal(isDelegable({ risk: 'low', scope: 'local' }), true);
  assert.equal(isDelegable({ risk: 'high', scope: 'local' }), false);
  assert.equal(isDelegable({ risk: 'low', scope: 'contract' }), false);
});

test('chooseRoute escalates an inline attempt straight to the strongest route', () => {
  const task = { id: '9.1', type: 'feature', complexity: 'M', risk: 'high', scope: 'contract', uncertainty: 'low' };
  const ledger = [{
    event: 'attempt.completed',
    taskId: '9.1',
    repositoryId: 'repo-A',
    routeId: 'inline-coordinator',
    action: 'escalate',
    valid: true,
    status: 'completed',
  }];

  assert.equal(chooseRoute(task, 'claude', ledger, {}, 'repo-A').id, 'claude-opus-max');
});

test('pair-doctor fails without a plan and passes on a valid one', t => {
  const root = testRepo(t);
  const dataDir = path.join(root, 'pair-data');

  const missing = runPairTask(root, ['--doctor'], { PAIR_DATA_DIR: dataDir });
  assert.equal(missing.status, 1, missing.stdout);
  assert.match(missing.stdout, /fail plan — no \.pair\/plan\.md/);

  fs.mkdirSync(path.join(root, '.pair'), { recursive: true });
  fs.writeFileSync(path.join(root, '.pair', 'plan.md'), validPairPlan());
  const healthy = runPairTask(root, ['--doctor'], { PAIR_DATA_DIR: dataDir });
  assert.equal(healthy.status, 0, healthy.stdout + healthy.stderr);
  assert.match(healthy.stdout, /ok {3}plan — \.pair\/plan\.md validates/);
  assert.match(healthy.stdout, /0 fail/);
});

test('inline handoff opens an attempt with a brief and --complete closes it through the pipeline', t => {
  const root = testRepo(t);
  const dataDir = path.join(root, 'pair-data');
  const env = { PAIR_SKIP_PLAN_VALIDATION: '1', PAIR_DATA_DIR: dataDir };
  const plan = [
    '## Streams',
    '### Stream 1: risky - complexity: M',
    '**Depends on:** none',
    '- [ ] Task 9.1 - implement risky contract change [type:feature] [risk:high] [scope:contract] [uncertainty:low] [ac:AC-1] - files: `src/x.js` - verify: `node -e "process.exit(0)"` - **M**',
    '',
  ].join('\n');
  fs.mkdirSync(path.join(root, '.pair'), { recursive: true });
  fs.writeFileSync(path.join(root, '.pair', 'plan.md'), plan);

  const handoff = runPairTask(root, ['--inline', '--once'], env);
  assert.equal(handoff.status, 0, handoff.stderr);
  assert.match(handoff.stdout, /INLINE TASK BRIEF/);
  assert.match(handoff.stdout, /pair-loop --complete/);
  const active = JSON.parse(fs.readFileSync(path.join(root, '.pair', 'active-attempt.json'), 'utf8'));
  assert.equal(active.mode, 'inline');
  assert.equal(active.taskId, '9.1');
  const started = fs.readFileSync(path.join(dataDir, 'attempts.jsonl'), 'utf8');
  assert.match(started, /"attempt\.started"/);

  // The coordinator implements the task in-session…
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'x.js'), 'module.exports = 1;\n');

  // …then completes the attempt (dry-run stubs only the independent review).
  const complete = runPairTask(root, ['--complete', '--dry-run'], env);
  assert.equal(complete.status, 0, complete.stderr);
  assert.match(complete.stdout, /task 9\.1 completed inline and accepted/);
  assert.match(fs.readFileSync(path.join(root, '.pair', 'plan.md'), 'utf8'), /- \[x\] Task 9\.1/);
  assert.equal(fs.existsSync(path.join(root, '.pair', 'active-attempt.json')), false);
  const ledger = fs.readFileSync(path.join(dataDir, 'attempts.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const completed = ledger.find(record => record.event === 'attempt.completed' && record.taskId === '9.1');
  assert.equal(completed.disposition, 'accepted');
  assert.equal(completed.routeId, 'inline-coordinator');
});
