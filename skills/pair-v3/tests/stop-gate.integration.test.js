const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const hook = path.resolve(__dirname, '../../../hooks/stop-gate.sh');

function fixture(t, tasks = 2) {
  const scratchBase = process.env.CLAUDE_SCRATCH_DIR || path.join(os.homedir(), '.claude-scratch');
  const root = fs.mkdtempSync(path.join(scratchBase, 'my-claude-code-stop-gate-'));
  const pairDir = path.join(root, '.pair');
  const scratch = path.join(root, 'scratch');
  fs.mkdirSync(pairDir, { recursive: true });
  fs.mkdirSync(scratch, { recursive: true });
  fs.writeFileSync(
    path.join(pairDir, 'plan.md'),
    Array.from({ length: tasks }, (_value, index) => `- [ ] Task ${index + 1}`).join('\n'),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { pairDir, root, scratch };
}

function activate(pairDir, runId = 'run-one', pid = process.pid) {
  fs.writeFileSync(path.join(pairDir, 'active-loop.json'), `${JSON.stringify({
    schema: 1,
    run_id: runId,
    pid,
    plan: '.pair/plan.md',
  })}\n`);
}

function stopGate(root, scratch, max = 2) {
  return childProcess.spawnSync('bash', [hook], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_SCRATCH_DIR: scratch,
      PAIR_STOP_GATE_MAX: String(max),
    },
    input: `${JSON.stringify({ cwd: root })}\n`,
  });
}

function decision(result) {
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

test('a dormant Pair plan never activates the Stop gate', t => {
  const { root, scratch } = fixture(t);
  assert.equal(decision(stopGate(root, scratch)), null);
});

test('a live Active Pair Loop marker activates the Stop gate', t => {
  const { pairDir, root, scratch } = fixture(t);
  activate(pairDir);
  assert.match(decision(stopGate(root, scratch)).reason, /Stop gate \(1\/2\).*2 unchecked/u);
});

test('an exhausted run stays allowed until progress or a new Pair Loop run', t => {
  const { pairDir, root, scratch } = fixture(t);
  activate(pairDir);

  assert.match(decision(stopGate(root, scratch)).reason, /\(1\/2\)/u);
  assert.match(decision(stopGate(root, scratch)).reason, /\(2\/2\)/u);
  assert.equal(decision(stopGate(root, scratch)), null);
  assert.equal(decision(stopGate(root, scratch)), null, 'same run must remain latched open');

  fs.writeFileSync(path.join(pairDir, 'plan.md'), '- [x] Task 1\n- [ ] Task 2\n');
  assert.match(decision(stopGate(root, scratch)).reason, /\(1\/2\).*1 unchecked/u);

  assert.match(decision(stopGate(root, scratch)).reason, /\(2\/2\)/u);
  assert.equal(decision(stopGate(root, scratch)), null);
  activate(pairDir, 'run-two');
  assert.match(decision(stopGate(root, scratch)).reason, /\(1\/2\)/u);
});

test('a stale Active Pair Loop marker cannot activate the Stop gate', t => {
  const { pairDir, root, scratch } = fixture(t);
  activate(pairDir, 'stale-run', 2147483647);
  assert.equal(decision(stopGate(root, scratch)), null);
});

