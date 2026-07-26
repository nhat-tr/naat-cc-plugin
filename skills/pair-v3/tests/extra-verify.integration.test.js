const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { verify } = require('../scripts/pair-task');
const { parsePlan } = require('../scripts/lib/pair-core');

function testRepo(t) {
  const scratchRoot = process.env.CLAUDE_SCRATCH_DIR || path.join(os.homedir(), '.claude-scratch');
  fs.mkdirSync(path.join(scratchRoot, 'my-claude-code', 'pair-v3-tests'), { recursive: true });
  const root = fs.mkdtempSync(path.join(scratchRoot, 'my-claude-code', 'pair-v3-tests', 'extra-verify-'));
  childProcess.spawnSync('git', ['init', '-q'], { cwd: root });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const WORKER = { status: 'completed', tests: [] };

function planWith(taskLine) {
  return ['## Streams', '### Stream 1: Behavior - complexity: M', taskLine, ''].join('\n');
}

test('plan parser extracts extra-verify without corrupting verify', () => {
  const plan = planWith('- [ ] Task 1.1 - deliver behavior - files: `src/a.js` - verify: `true` - extra-verify: `false` - **S**');
  const task = parsePlan(plan).tasks[0];
  assert.equal(task.verify, 'true');
  assert.equal(task.extraVerify, 'false');

  const onlyExtra = parsePlan(planWith('- [ ] Task 1.1 - deliver behavior - files: `src/a.js` - extra-verify: `false` - **S**')).tasks[0];
  assert.equal(onlyExtra.verify, '', 'extra-verify must not leak into verify');
  assert.equal(onlyExtra.extraVerify, 'false');
});

test('a failing plan extra-verify blocks acceptance even when the primary verify passes', t => {
  const root = testRepo(t);
  const task = { id: '1.1', files: ['src/a.js'], verify: 'true', extraVerify: 'exit 7' };

  const result = verify(root, task, WORKER);
  assert.equal(result.status, 'fail');
  assert.equal(result.command, 'exit 7');
  assert.equal(result.extraVerify.source, 'plan');
  assert.equal(result.extraVerify.primary, 'true');
});

test('a task without extra-verify behaves exactly as before', t => {
  const root = testRepo(t);
  const task = { id: '1.1', files: ['src/a.js'], verify: 'true' };

  const result = verify(root, task, WORKER);
  assert.equal(result.status, 'pass');
  assert.equal(result.command, 'true');
  assert.equal('extraVerify' in result, false, 'no additive annotation without extras');
});

test('a passing extra-verify keeps the primary result and records what ran', t => {
  const root = testRepo(t);
  const task = { id: '1.1', files: ['src/a.js'], verify: 'true', extraVerify: 'true' };

  const result = verify(root, task, WORKER);
  assert.equal(result.status, 'pass');
  assert.deepEqual(result.extraVerify.ran, ['true']);
});
