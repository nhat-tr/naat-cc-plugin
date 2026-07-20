const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { validPairLitePlan, validPairPlan } = require('./support/pair-plan-fixture');

function scratchFile(t, name, content) {
  const scratchRoot = process.env.CLAUDE_SCRATCH_DIR
    || path.join(os.homedir(), '.claude-scratch');
  const parent = path.join(scratchRoot, 'my-claude-code');
  fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, 'plan-validator-'));
  const file = path.join(directory, name);
  fs.writeFileSync(file, content);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return file;
}

function validate(file, validator = '../../pair-v3/scripts/validate-plan') {
  return childProcess.spawnSync(path.resolve(__dirname, validator), [file], {
    encoding: 'utf8',
  });
}

test('canonical validator accepts the canonical plan and rejects a non-runnable plan', t => {
  const valid = validate(scratchFile(t, 'valid-plan.md', validPairPlan()));
  assert.equal(valid.status, 0, `${valid.stdout}${valid.stderr}`);
  assert.match(valid.stdout, /validate-plan: OK/);
  assert.match(valid.stdout, /plan contract sha256: [a-f0-9]{64}/);

  const invalid = validate(scratchFile(t, 'invalid-plan.md', [
    '## Implementation Context',
    'anything',
    '## Streams',
    '### Stream 1: API',
    '- [ ] implement production first; mention test and integration-test',
  ].join('\n')));
  assert.equal(invalid.status, 1, `${invalid.stdout}${invalid.stderr}`);
  assert.match(invalid.stdout, /stable task ID|Intent Contract|Capability Evidence/);
});

test('pair-v2 validator wrapper delegates to the canonical validator', t => {
  const plan = scratchFile(t, 'valid-plan.md', validPairPlan());
  const wrapped = childProcess.spawnSync('bash', [
    path.resolve(__dirname, '../../pair-v2/scripts/validate-plan.sh'),
    plan,
  ], { encoding: 'utf8' });

  assert.equal(wrapped.status, 0, `${wrapped.stdout}${wrapped.stderr}`);
  assert.match(wrapped.stdout, /validate-plan: OK/);
});

test('canonical validator accepts the compact Pair-lite execution contract', t => {
  const plan = validPairLitePlan();
  const result = validate(scratchFile(t, 'pair-lite-plan.md', plan));

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /validate-plan: OK/);
  assert.ok(Buffer.byteLength(plan) < Buffer.byteLength(validPairPlan()) / 3);
});
