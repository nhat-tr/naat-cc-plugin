const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  extraVerifyPath,
  finalVerificationCommands,
  verify,
} = require('../scripts/pair-task');
const { parsePlan } = require('../scripts/lib/pair-core');

const PAIR_TASK = path.join(__dirname, '..', 'scripts', 'pair-task');

function testRepo(t) {
  const scratchRoot = process.env.CLAUDE_SCRATCH_DIR || path.join(os.homedir(), '.claude-scratch');
  fs.mkdirSync(path.join(scratchRoot, 'my-claude-code', 'pair-v3-tests'), { recursive: true });
  const root = fs.mkdtempSync(path.join(scratchRoot, 'my-claude-code', 'pair-v3-tests', 'extra-verify-rt-'));
  childProcess.spawnSync('git', ['init', '-q'], { cwd: root });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function addVerify(root, args) {
  return childProcess.spawnSync(process.execPath, [PAIR_TASK, '--add-verify', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

const WORKER = { status: 'completed', tests: [] };

function planWith(taskLine) {
  return ['## Streams', '### Stream 1: Behavior - complexity: M', taskLine, ''].join('\n');
}

test('pair-loop --add-verify records a provenance entry in the runtime store', t => {
  const root = testRepo(t);
  const run = addVerify(root, ['node -e "process.exit(0)"']);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /recorded extra verification/);

  const store = JSON.parse(fs.readFileSync(extraVerifyPath(root), 'utf8'));
  assert.equal(store.entries.length, 1);
  const entry = store.entries[0];
  assert.equal(entry.command, 'node -e "process.exit(0)"');
  assert.equal(entry.task_id, null);
  assert.equal(entry.source, 'human');
  assert.ok(entry.added_at, 'provenance timestamp recorded');
});

test('a failing runtime store command blocks acceptance at the next verification', t => {
  const root = testRepo(t);
  const task = { id: '1.1', files: ['src/a.js'], verify: 'true' };

  assert.equal(verify(root, task, WORKER).status, 'pass', 'passes before the store entry exists');

  assert.equal(addVerify(root, ['exit 7']).status, 0);
  const gated = verify(root, task, WORKER);
  assert.equal(gated.status, 'fail');
  assert.equal(gated.command, 'exit 7');
  assert.equal(gated.extraVerify.source, 'runtime');
});

test('a task-scoped entry runs only for its task', t => {
  const root = testRepo(t);
  assert.equal(addVerify(root, ['exit 7', '--task', '9.9']).status, 0);

  assert.equal(verify(root, { id: '1.1', files: [], verify: 'true' }, WORKER).status, 'pass');
  assert.equal(verify(root, { id: '9.9', files: [], verify: 'true' }, WORKER).status, 'fail');
});

test('the final gate includes runtime store commands and plan extra-verify commands', t => {
  const root = testRepo(t);
  assert.equal(addVerify(root, ['npm run lint']).status, 0);
  const parsed = parsePlan(planWith('- [ ] Task 1.1 - deliver behavior - files: `src/a.js` - verify: `true` - extra-verify: `node --test x.js` - **S**'));

  const commands = finalVerificationCommands(root, parsed);
  assert.ok(commands.includes('npm run lint'), 'runtime store command joins the final gate');
  assert.ok(commands.includes('node --test x.js'), 'plan extra-verify joins the final gate');
});

test('an absent or empty store leaves verification and the final gate unchanged', t => {
  const root = testRepo(t);
  const task = { id: '1.1', files: [], verify: 'true' };
  const parsed = parsePlan(planWith('- [ ] Task 1.1 - deliver behavior - files: `src/a.js` - verify: `true` - **S**'));

  const absent = verify(root, task, WORKER);
  assert.equal(absent.status, 'pass');
  assert.equal('extraVerify' in absent, false);
  assert.deepEqual(finalVerificationCommands(root, parsed), ['true']);

  fs.mkdirSync(path.join(root, '.pair'), { recursive: true });
  fs.writeFileSync(extraVerifyPath(root), JSON.stringify({ schema: 1, entries: [] }));
  const empty = verify(root, task, WORKER);
  assert.equal(empty.status, 'pass');
  assert.equal('extraVerify' in empty, false);
  assert.deepEqual(finalVerificationCommands(root, parsed), ['true']);
});
