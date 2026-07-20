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

function run(args, env = {}, cwd = undefined) {
  return spawnSync(process.execPath, [REPORT, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
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

test('pair-report defaults to the repository-local Pair v4 event store', t => {
  const root = scratchDir(t);
  const pairDirectory = path.join(root, '.pair');
  fs.mkdirSync(pairDirectory);
  const legacy = writeLedger(pairDirectory);
  fs.renameSync(legacy, path.join(pairDirectory, 'events.jsonl'));
  const result = run(['--json'], { PAIR_DATA_DIR: path.join(root, 'ignored-external-data') }, root);
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

test('pair-report accounts for every model role and plan-review usage', t => {
  const dir = scratchDir(t);
  const ledger = path.join(dir, 'all-usage.jsonl');
  const usage = (inputTokens, cachedInputTokens, outputTokens, reasoningTokens) => ({
    inputTokens, cachedInputTokens, outputTokens, reasoningTokens, costUsd: null,
  });
  fs.writeFileSync(ledger, [
    {
      event: 'attempt.completed', attemptId: 'all', taskId: '1.1', routeId: 'codex-default',
      profile: { type: 'feature', risk: 'high' }, disposition: 'accepted', valid: true,
      status: 'completed', usage: {
        worker: usage(10, 2, 3, 4),
        redWorker: usage(20, 5, 6, 7),
        reviewer: usage(30, 8, 9, 10),
        anchorReviewer: usage(40, 11, 12, 13),
      },
    },
    {
      event: 'plan-review.completed', reviewer: 'codex/default', classification: 'approved',
      usage: usage(50, 14, 15, 16), elapsedMs: 1234,
    },
    {
      event: 'final-review.completed', reviewer: 'codex/default', classification: 'approved',
      usage: usage(60, 17, 18, 19), elapsedMs: 2345,
    },
    {
      event: 'test-proposal.generated', routeId: 'codex-default', taskId: '1.1',
      usage: usage(70, 20, 21, 22), elapsedMs: 3456,
    },
  ].map(row => JSON.stringify(row)).join('\n'));

  const result = run([ledger, '--json']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const groups = JSON.parse(result.stdout);
  const task = groups.find(group => group.route === 'codex-default');
  assert.equal(task.inputTokens, 100);
  assert.equal(task.cachedInputTokens, 26);
  assert.equal(task.outputTokens, 30);
  assert.equal(task.reasoningTokens, 34);
  const plan = groups.find(group => group.route === 'plan-review:codex/default');
  assert.equal(plan.inputTokens, 50);
  assert.equal(plan.elapsedMs, 1234);
  const final = groups.find(group => group.route === 'final-review:codex/default');
  assert.equal(final.reasoningTokens, 19);
  assert.equal(final.elapsedMs, 2345);
  const proposal = groups.find(group => group.route === 'test-proposal:codex-default');
  assert.equal(proposal.cachedInputTokens, 20);
  assert.equal(proposal.elapsedMs, 3456);
});

test('pair-report shows resumed-turn cache telemetry without treating it as a quality gate', t => {
  const dir = scratchDir(t);
  const ledger = path.join(dir, 'resume-usage.jsonl');
  fs.writeFileSync(ledger, `${JSON.stringify({
    event: 'usage.recorded', runtime: 'codex', role: 'reviewer', phase: 'reviewing', resumed: true,
    checkpoint_bytes: 700, input_tokens: 400, cached_input_tokens: 250,
    uncached_input_tokens: 150, cache_hit_ratio: 0.625, output_tokens: 30,
    reasoning_tokens: 10, telemetry: 'observed', efficiency_warning: true,
  })}\n`);

  const result = run([ledger, '--json']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const resume = JSON.parse(result.stdout).find(group => group.route === 'resume:codex/reviewer/reviewing');
  assert.equal(resume.checkpointBytes, 700);
  assert.equal(resume.uncachedInputTokens, 150);
  assert.equal(resume.cacheHitRatio, 0.625);
  assert.equal(resume.efficiencyWarnings, 1);
  assert.equal(resume.accepted, 0, 'token efficiency is not a correctness verdict');
});
