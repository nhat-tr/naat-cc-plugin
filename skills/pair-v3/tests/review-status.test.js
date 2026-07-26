const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { reviewStatusSummary } = require('../scripts/pair-task');

const PAIR_TASK = path.join(__dirname, '..', 'scripts', 'pair-task');

function testRepo(t) {
  const scratchRoot = process.env.CLAUDE_SCRATCH_DIR || path.join(os.homedir(), '.claude-scratch');
  fs.mkdirSync(path.join(scratchRoot, 'my-claude-code', 'pair-v3-tests'), { recursive: true });
  const root = fs.mkdtempSync(path.join(scratchRoot, 'my-claude-code', 'pair-v3-tests', 'review-status-'));
  childProcess.spawnSync('git', ['init', '-q'], { cwd: root });
  fs.mkdirSync(path.join(root, '.pair'), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const FINDING = {
  severity: 'MAJOR',
  origin: 'implementation',
  file: 'src/g.js',
  line: 3,
  title: 'greeting drops the name',
  detail: 'name is ignored',
  failure_scenario: 'greet("x") returns the default',
  suggestion: 'thread the name through',
};

function seed(root, name, payload, ageSeconds) {
  const file = path.join(root, '.pair', name);
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
  const when = new Date(Date.now() - ageSeconds * 1000);
  fs.utimesSync(file, when, when);
  return file;
}

test('reviewStatusSummary reads all three evidence kinds and picks the newest', t => {
  const root = testRepo(t);
  seed(root, 'review.json', { verdict: 'fix-needed', recommended_action: 'local-fix', summary: 'slice review', findings: [FINDING] }, 300);
  seed(root, 'plan-review.json', { review: { verdict: 'approve', recommended_action: 'approve', summary: 'plan ok', findings: [] }, planDigest: 'x' }, 200);
  seed(root, 'final-review.json', { verdict: 'approve', summary: 'cumulative ok', findings: [], plan_digest: 'x' }, 100);

  const summary = reviewStatusSummary(root);
  assert.equal(summary.kind, 'final', 'newest evidence wins');
  assert.equal(summary.verdict, 'approve');
  assert.deepEqual(
    summary.other.map((entry) => entry.kind).sort(),
    ['plan', 'slice'],
    'older kinds stay visible',
  );

  const slice = summary.other.find((entry) => entry.kind === 'slice');
  assert.equal(slice.verdict, 'fix-needed');
});

test('reviewStatusSummary unwraps evidence envelopes and surfaces findings', t => {
  const root = testRepo(t);
  seed(root, 'plan-review.json', { review: { verdict: 'fix-needed', recommended_action: 'redesign', summary: 'plan broken', findings: [FINDING] } }, 10);

  const summary = reviewStatusSummary(root);
  assert.equal(summary.kind, 'plan');
  assert.equal(summary.recommended_action, 'redesign');
  assert.equal(summary.findings.length, 1);
  assert.equal(summary.findings[0].title, 'greeting drops the name');
});

test('pair-loop --review-status --json prints the labeled summary', t => {
  const root = testRepo(t);
  seed(root, 'review.json', { verdict: 'fix-needed', recommended_action: 'local-fix', summary: 'slice review', findings: [FINDING] }, 10);

  const run = childProcess.spawnSync(process.execPath, [PAIR_TASK, '--review-status', '--json'], { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const parsed = JSON.parse(run.stdout);
  assert.equal(parsed.kind, 'slice');
  assert.equal(parsed.verdict, 'fix-needed');
  assert.equal(parsed.findings.length, 1);
});

test('pair-loop --review-status prints readable output and handles missing evidence', t => {
  const root = testRepo(t);

  const empty = childProcess.spawnSync(process.execPath, [PAIR_TASK, '--review-status'], { cwd: root, encoding: 'utf8' });
  assert.equal(empty.status, 0, empty.stderr);
  assert.match(empty.stdout, /no review evidence found/);

  seed(root, 'review.json', { verdict: 'fix-needed', recommended_action: 'local-fix', summary: 'slice review', findings: [FINDING] }, 10);
  const run = childProcess.spawnSync(process.execPath, [PAIR_TASK, '--review-status'], { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /latest review evidence — slice/);
  assert.match(run.stdout, /verdict: fix-needed — recommended action: local-fix/);
  assert.match(run.stdout, /\[MAJOR implementation\] greeting drops the name \(src\/g\.js:3\)/);
});
