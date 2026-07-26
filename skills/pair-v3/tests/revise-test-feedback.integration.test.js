const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  hitlGate,
  proposalPrompt,
  readTestProposal,
  reviseTestProposal,
  writeTestProposal,
} = require('../scripts/pair-task');
const { planContractDigest } = require('../scripts/lib/pair-core');

const PAIR_TASK = path.join(__dirname, '..', 'scripts', 'pair-task');

function testRepo(t) {
  const scratchRoot = process.env.CLAUDE_SCRATCH_DIR || path.join(os.homedir(), '.claude-scratch');
  fs.mkdirSync(path.join(scratchRoot, 'my-claude-code', 'pair-v3-tests'), { recursive: true });
  const root = fs.mkdtempSync(path.join(scratchRoot, 'my-claude-code', 'pair-v3-tests', 'revise-'));
  childProcess.spawnSync('git', ['init', '-q'], { cwd: root });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function runCli(root, args) {
  return childProcess.spawnSync(process.execPath, [PAIR_TASK, ...args], { cwd: root, encoding: 'utf8' });
}

const PLAN = '- [ ] Task 1.1 - deliver greeting behavior through one RED to GREEN cycle\n';
const TASK = {
  id: '1.1',
  type: 'feature',
  tddMode: 'cycle',
  text: 'deliver greeting behavior',
  files: ['tests/g.test.js', 'src/g.js'],
  testFiles: ['tests/g.test.js'],
};

function proposalFor(overrides = {}) {
  return {
    schema: 1,
    taskId: '1.1',
    planDigest: planContractDigest(PLAN),
    status: 'proposed',
    tests: [
      { name: 'Greet_WhenAsked_ThenPrints', purpose: 'pins greeting', file: 'tests/g.test.js', approved: false },
      { name: 'Greet_WhenMissing_ThenFails', purpose: 'pins rejection', file: 'tests/g.test.js', approved: false },
    ],
    ...overrides,
  };
}

test('pair-loop --revise-test records a note, demotes the test, and flags re-proposal', t => {
  const root = testRepo(t);
  writeTestProposal(root, proposalFor());

  const run = runCli(root, ['--revise-test', '2', '--note', 'assert only the exit code, drop the snapshot']);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /recorded revision note for test \[2\] Greet_WhenMissing_ThenFails/);

  const stored = JSON.parse(fs.readFileSync(path.join(root, '.pair', 'test-proposal.json'), 'utf8'));
  assert.equal(stored.status, 'revise');
  assert.deepEqual(stored.tests[1].feedback, ['assert only the exit code, drop the snapshot']);
  assert.equal(stored.tests[1].approved, false);
  assert.equal(stored.tests[0].feedback, undefined, 'other tests untouched');
});

test('--revise-test is an explicit error without a proposal, a note, or a valid index', t => {
  const root = testRepo(t);

  const missing = runCli(root, ['--revise-test', '1', '--note', 'x']);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /no test proposal is awaiting review/);

  writeTestProposal(root, proposalFor());
  const noNote = runCli(root, ['--revise-test', '1']);
  assert.notEqual(noNote.status, 0);
  assert.match(noNote.stderr, /requires --note/);

  const badIndex = runCli(root, ['--revise-test', '9', '--note', 'x']);
  assert.notEqual(badIndex.status, 0);
  assert.match(badIndex.stderr, /invalid test index 9/);
});

test('the next proposal for the task incorporates prior notes for still-unwritten tests', t => {
  const root = testRepo(t);
  const revised = reviseTestProposal(proposalFor(), 2, 'lean form please');
  writeTestProposal(root, revised);

  const seen = {};
  const generate = (args) => {
    seen.revisionNotes = args.revisionNotes;
    return {
      status: 0,
      tests: [{ name: 'Greet_WhenMissing_ThenFailsLean', purpose: 'pins rejection leanly', file: 'tests/g.test.js' }],
      usage: null,
      elapsedMs: 1,
    };
  };
  const paths = { plan: 'plan.md', scratch: root, ledger: path.join(root, 'ledger.jsonl') };
  const gate = hitlGate(
    { root, plan: PLAN, task: TASK, runtime: 'claude', route: { id: 'r' }, paths, options: { hitl: true } },
    generate,
  );

  assert.deepEqual(seen.revisionNotes, [{ name: 'Greet_WhenMissing_ThenFails', notes: ['lean form please'] }]);
  assert.equal(gate.action, 'await', 'regenerated proposal awaits approval');
  const stored = readTestProposal(root, TASK, PLAN);
  assert.equal(stored.status, 'proposed');
  assert.deepEqual(stored.revisions, [{ name: 'Greet_WhenMissing_ThenFails', notes: ['lean form please'] }]);
  assert.equal(stored.tests[0].name, 'Greet_WhenMissing_ThenFailsLean');
});

test('proposalPrompt carries revision notes into the re-proposal request', () => {
  const prompt = proposalPrompt(TASK, 'plan.md', [{ name: 'Greet_WhenMissing_ThenFails', notes: ['lean form please'] }]);
  assert.match(prompt, /declined with revision notes/);
  assert.match(prompt, /Greet_WhenMissing_ThenFails: lean form please/);

  const bare = proposalPrompt(TASK, 'plan.md');
  assert.doesNotMatch(bare, /revision notes/);
});

test('bare --approve-tests behavior is unchanged, including on a proposal carrying feedback', t => {
  const root = testRepo(t);
  writeTestProposal(root, reviseTestProposal(proposalFor(), 1, 'note kept'));

  const run = runCli(root, ['--approve-tests', 'all']);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /approved 2\/2 proposed test\(s\)/);

  const stored = JSON.parse(fs.readFileSync(path.join(root, '.pair', 'test-proposal.json'), 'utf8'));
  assert.equal(stored.status, 'approved');
  assert.deepEqual(stored.tests.map((item) => item.approved), [true, true]);
  assert.deepEqual(stored.tests[0].feedback, ['note kept'], 'feedback survives approval');
});
