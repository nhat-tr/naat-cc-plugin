const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  applyTestApproval,
  printTestProposal,
  proposalPrompt,
  readTestProposal,
  writeTestProposal,
} = require('../scripts/pair-task');
const { planContractDigest } = require('../scripts/lib/pair-core');

const SCHEMA = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'schemas', 'test-proposal.json'), 'utf8'),
);

function testRepo(t) {
  const scratchRoot = process.env.CLAUDE_SCRATCH_DIR || path.join(os.homedir(), '.claude-scratch');
  fs.mkdirSync(path.join(scratchRoot, 'my-claude-code', 'pair-v3-tests'), { recursive: true });
  const root = fs.mkdtempSync(path.join(scratchRoot, 'my-claude-code', 'pair-v3-tests', 'proposal-spec-'));
  childProcess.spawnSync('git', ['init', '-q'], { cwd: root });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const PLAN = '- [ ] Task 1.1 - deliver greeting behavior\n';
const TASK = { id: '1.1', files: ['src/g.js'], testFiles: ['tests/g.test.js'] };

test('the proposal schema accepts an optional bounded spec and keeps its contract otherwise', () => {
  const item = SCHEMA.properties.tests.items;
  assert.deepEqual(item.properties.spec, { type: 'string', maxLength: 700 });
  assert.deepEqual(item.required, ['name', 'purpose', 'file'], 'spec stays optional');
  assert.equal(item.additionalProperties, false, 'schema remains closed');
});

test('proposalPrompt requests the optional spec sketch', () => {
  const prompt = proposalPrompt(TASK, 'plan.md');
  assert.match(prompt, /optionally add a short `spec`/i);
  assert.match(prompt, /arranges and asserts/);
});

test('printTestProposal displays the spec when present and stays quiet without it', t => {
  const lines = [];
  t.mock.method(console, 'log', (line) => lines.push(String(line)));
  printTestProposal({
    taskId: '1.1',
    tests: [
      { name: 'A_WhenX_ThenY', purpose: 'pins X', file: 'tests/g.test.js', spec: 'Arranges a bare repo and asserts Y at the CLI boundary.' },
      { name: 'B_WhenZ_ThenW', purpose: 'pins Z', file: 'tests/g.test.js' },
    ],
  });
  const output = lines.join('\n');
  assert.match(output, /spec: Arranges a bare repo and asserts Y at the CLI boundary\./);
  assert.equal(output.match(/spec:/g).length, 1, 'no spec line for a test without one');
});

test('a proposal without spec still validates through the store and approval flow', t => {
  const root = testRepo(t);
  const proposal = {
    schema: 1,
    taskId: '1.1',
    planDigest: planContractDigest(PLAN),
    status: 'proposed',
    tests: [{ name: 'A_WhenX_ThenY', purpose: 'pins X', file: 'tests/g.test.js', approved: false }],
  };
  writeTestProposal(root, proposal);
  assert.ok(readTestProposal(root, TASK, PLAN), 'spec-less proposal still resolves');

  const approved = applyTestApproval(proposal, 'all');
  assert.equal(approved.status, 'approved');
});

test('a proposal carrying spec fields round-trips intact', t => {
  const root = testRepo(t);
  const proposal = {
    schema: 1,
    taskId: '1.1',
    planDigest: planContractDigest(PLAN),
    status: 'proposed',
    tests: [{ name: 'A_WhenX_ThenY', purpose: 'pins X', file: 'tests/g.test.js', spec: 'Short sketch.', approved: false }],
  };
  writeTestProposal(root, proposal);
  assert.equal(readTestProposal(root, TASK, PLAN).tests[0].spec, 'Short sketch.');
});
