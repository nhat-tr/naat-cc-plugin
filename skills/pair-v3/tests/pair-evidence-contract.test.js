const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../../..');

test('active Pair contract contains only Evidence-at-Commit artifacts', () => {
  const removed = [
    'skills/pair-promote/SKILL.md',
    'commands/pair-promote.md',
    'bin/pair-plan-challenge',
    'bin/validate-implementation-design',
    'bin/validate-plan',
    'skills/pair-v3/schemas/implementation-design.schema.json',
    'skills/pair-v3/schemas/review-slice-execution-packet.schema.json',
  ];
  for (const file of removed) assert.equal(fs.existsSync(path.join(root, file)), false, `${file} must stay removed`);
  const active = [
    'README.md',
    'skills/pair-v4/SKILL.md',
    'skills/brainstorming/SKILL.md',
    'metadata/runtime-asset-map.json',
  ].map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
  assert.doesNotMatch(active, /pair-promote|Implementation Design Contract|Review Slice Execution Packet|--legacy-v3/u);
});

test('Pair CLI exposes bounded workflow without plan challenge or session reuse', () => {
  const help = childProcess.spawnSync(path.join(root, 'bin', 'pair-loop'), ['--help'], { cwd: root, encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Evidence-at-Commit/u);
  assert.match(help.stdout, /review-slices\.json/u);
  assert.doesNotMatch(help.stdout, /promote|challenge|resume|execution packet|TDD/iu);
  for (const schema of ['slice-result.json', 'precision-review-result.json']) {
    assert.ok(fs.statSync(path.join(root, 'skills/pair-v3/schemas', schema)).size < 16 * 1024);
  }
  const sliceSchemaPath = path.join(root, 'skills/pair-v3/schemas/slice-result.json');
  const sliceSchema = fs.readFileSync(sliceSchemaPath, 'utf8');
  assert.ok(fs.statSync(sliceSchemaPath).size < 2 * 1024);
  assert.doesNotMatch(sliceSchema, /architecture_facts|facts_complete/u);
});
