const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const REPORT = path.join(__dirname, '..', 'scripts', 'pair-report');

function scratchDir(t) {
  const base = process.env.CLAUDE_SCRATCH_DIR || path.join(os.homedir(), '.claude-scratch');
  const dir = fs.mkdtempSync(path.join(base, 'pair-report-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function run(args, env = {}) {
  return spawnSync(process.execPath, [REPORT, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
}

function writeLedger(dir) {
  const ledger = path.join(dir, 'attempts.jsonl');
  const rows = [
    { event: 'attempt.started', attemptId: 'a', taskId: '1.1' },
    { event: 'attempt.completed', attemptId: 'a', taskId: '1.1', routeId: 'claude-sonnet-medium', profile: { type: 'feature', risk: 'low' }, disposition: 'accepted', valid: true, status: 'completed', totalCost: 0.2 },
    { event: 'attempt.completed', attemptId: 'b', taskId: '1.2', routeId: 'claude-sonnet-medium', profile: { type: 'feature', risk: 'low' }, disposition: 'regenerated', valid: false, status: 'interrupted' },
  ];
  fs.writeFileSync(ledger, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);
  return ledger;
}

test('pair-report --help prints usage instead of reading a file named --help', t => {
  const result = run(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: pair-report/);
  assert.doesNotMatch(result.stdout, /no attempts recorded/);
});

test('pair-report --json reports the ledger and never mistakes the flag for a path', t => {
  const dir = scratchDir(t);
  writeLedger(dir);
  const result = run(['--json'], { PAIR_DATA_DIR: dir });
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stdout, /no attempts recorded/);
  const groups = JSON.parse(result.stdout);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].attempts, 2);
  assert.equal(groups[0].accepted, 1);
  assert.equal(groups[0].interrupted, 1, 'interrupted attempts are reported separately');
});

test('pair-report accepts an explicit ledger path positional argument', t => {
  const dir = scratchDir(t);
  const ledger = writeLedger(dir);
  const result = run([ledger, '--json']);
  assert.equal(result.status, 0);
  const groups = JSON.parse(result.stdout);
  assert.equal(groups[0].attempts, 2);
});
