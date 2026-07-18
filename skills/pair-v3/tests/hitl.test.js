const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  applyTestApproval,
  hitlGate,
  readTestProposal,
  workerPrompt,
  writeTestProposal,
} = require('../scripts/pair-task');
const { planContractDigest } = require('../scripts/lib/pair-core');

const PAIR_TASK = path.join(__dirname, '..', 'scripts', 'pair-task');

function testRepo(t) {
  const scratchRoot = process.env.CLAUDE_SCRATCH_DIR || path.join(os.homedir(), '.claude-scratch');
  fs.mkdirSync(path.join(scratchRoot, 'my-claude-code', 'pair-v3-tests'), { recursive: true });
  const root = fs.mkdtempSync(path.join(scratchRoot, 'my-claude-code', 'pair-v3-tests', 'hitl-'));
  childProcess.spawnSync('git', ['init', '-q'], { cwd: root });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const PLAN = '- [ ] Task 1.1 - write failing tests for greeting\n';
const TASK = { id: '1.1', type: 'test', text: 'write failing tests for greeting', files: ['tests/g.test.js'], acceptanceCriteria: ['AC-1'], verify: 'x' };

function proposalFor(plan, overrides = {}) {
  return {
    schema: 1,
    taskId: '1.1',
    planDigest: planContractDigest(plan),
    status: 'proposed',
    tests: [
      { name: 'Greet_WhenAsked_ThenPrintsGreeting', purpose: 'pins AC-1 greeting output', file: 'tests/g.test.js', approved: false },
      { name: 'Greet_WhenNameMissing_ThenFails', purpose: 'pins missing-name rejection', file: 'tests/g.test.js', approved: false },
    ],
    ...overrides,
  };
}

test('applyTestApproval supports all, index subsets, and none', () => {
  const proposal = proposalFor(PLAN);

  const all = applyTestApproval(proposal, 'all');
  assert.equal(all.status, 'approved');
  assert.deepEqual(all.tests.map(t => t.approved), [true, true]);

  const subset = applyTestApproval(proposal, '2');
  assert.deepEqual(subset.tests.map(t => t.approved), [false, true]);

  const none = applyTestApproval(proposal, 'none');
  assert.deepEqual(none.tests.map(t => t.approved), [false, false]);

  assert.throws(() => applyTestApproval(proposal, '9'), /invalid test selection/);
});

test('readTestProposal enforces task and plan-contract binding but survives checkbox progress', t => {
  const root = testRepo(t);
  writeTestProposal(root, proposalFor(PLAN));

  assert.ok(readTestProposal(root, TASK, PLAN), 'valid binding resolves');

  const progressed = PLAN.replace('- [ ] Task 1.1', '- [x] Task 1.1');
  assert.ok(readTestProposal(root, TASK, progressed), 'checkbox progress must not invalidate an approved proposal');

  assert.equal(readTestProposal(root, { ...TASK, id: '9.9' }, PLAN), null, 'a different task discards the proposal');
  writeTestProposal(root, proposalFor(PLAN));
  assert.equal(readTestProposal(root, TASK, `${PLAN}new contract line\n`), null, 'an edited plan contract discards the proposal');
  assert.equal(fs.existsSync(path.join(root, '.pair', 'test-proposal.json')), false, 'stale proposal file is removed');
});

test('hitlGate is inert when off or for non-test tasks', t => {
  const root = testRepo(t);
  const paths = { plan: 'plan.md', scratch: root, ledger: path.join(root, 'ledger.jsonl') };
  const explode = () => { throw new Error('generator must not run'); };

  assert.deepEqual(
    hitlGate({ root, plan: PLAN, task: TASK, runtime: 'claude', route: { id: 'r' }, paths, options: { hitl: false } }, explode),
    { action: 'proceed', approvedTests: null },
  );
  assert.deepEqual(
    hitlGate({ root, plan: PLAN, task: { ...TASK, type: 'feature' }, runtime: 'claude', route: { id: 'r' }, paths, options: { hitl: true } }, explode),
    { action: 'proceed', approvedTests: null },
  );
});

test('hitlGate generates a proposal, persists it, records usage, and awaits approval', t => {
  const root = testRepo(t);
  const paths = { plan: 'plan.md', scratch: root, ledger: path.join(root, 'ledger.jsonl') };
  const generate = () => ({
    status: 0,
    tests: [{ name: 'Greet_WhenAsked_ThenPrintsGreeting', purpose: 'pins AC-1', file: 'tests/g.test.js' }],
    usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, reasoningTokens: 0, costUsd: 0.01 },
  });

  const result = hitlGate({ root, plan: PLAN, task: TASK, runtime: 'claude', route: { id: 'r' }, paths, options: { hitl: true } }, generate);
  assert.equal(result.action, 'await', 'without a TTY the loop pauses for approval');

  const written = readTestProposal(root, TASK, PLAN);
  assert.equal(written.status, 'proposed');
  assert.equal(written.tests.length, 1);
  assert.equal(written.tests[0].approved, false, 'nothing is approved implicitly');

  const ledger = fs.readFileSync(paths.ledger, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(ledger[0].event, 'test-proposal.generated', 'proposal cost is recorded');
});

test('hitlGate proceeds with exactly the approved subset once approval exists', t => {
  const root = testRepo(t);
  const paths = { plan: 'plan.md', scratch: root, ledger: path.join(root, 'ledger.jsonl') };
  writeTestProposal(root, applyTestApproval(proposalFor(PLAN), '2'));
  const explode = () => { throw new Error('generator must not run for an existing proposal'); };

  const result = hitlGate({ root, plan: PLAN, task: TASK, runtime: 'claude', route: { id: 'r' }, paths, options: { hitl: true } }, explode);
  assert.equal(result.action, 'proceed');
  assert.equal(result.approvedTests.length, 1);
  assert.equal(result.approvedTests[0].name, 'Greet_WhenNameMissing_ThenFails');
});

test('workerPrompt constrains the worker to the approved test set', () => {
  const approved = [{ name: 'Greet_WhenAsked_ThenPrintsGreeting', purpose: 'pins AC-1', file: 'tests/g.test.js' }];
  const prompt = workerPrompt(TASK, '.pair/plan.md', null, approved);
  assert.match(prompt, /HITL-approved test set/);
  assert.match(prompt, /write exactly these tests and no others/);
  assert.match(prompt, /Greet_WhenAsked_ThenPrintsGreeting/);

  assert.doesNotMatch(workerPrompt(TASK, '.pair/plan.md', null, null), /HITL-approved/);
});

test('pair-task --approve-tests applies a selection from the command line', t => {
  const root = testRepo(t);
  writeTestProposal(root, proposalFor(PLAN));

  const run = childProcess.spawnSync(process.execPath, [PAIR_TASK, '--approve-tests', '1'], { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /approved 1\/2 proposed test\(s\) for task 1\.1/);

  const stored = JSON.parse(fs.readFileSync(path.join(root, '.pair', 'test-proposal.json'), 'utf8'));
  assert.equal(stored.status, 'approved');
  assert.deepEqual(stored.tests.map(test => test.approved), [true, false]);
});
