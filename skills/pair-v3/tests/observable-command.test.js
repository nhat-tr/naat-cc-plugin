const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { runObservableCommandSync } = require('../scripts/lib/observable-command');
const { verificationTimeouts } = require('../scripts/pair-task');

function scratchDirectory(t) {
  const base = process.env.CLAUDE_SCRATCH_DIR || path.join(os.homedir(), '.claude-scratch');
  const directory = fs.mkdtempSync(path.join(base, 'my-claude-code-observable-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function withEnvironment(overrides, run) {
  const saved = {};
  for (const [key, value] of Object.entries(overrides)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('stall cap still terminates a silent idle command', t => {
  const directory = scratchDirectory(t);
  const run = withEnvironment({ PAIR_STALL_ACTIVITY_SAMPLE_MS: '200' }, () =>
    runObservableCommandSync({
      command: { file: 'sleep', args: ['10'], cwd: directory },
      label: 'silent idle probe',
      outputFile: path.join(directory, 'idle.stdout'),
      hardTimeoutMs: 20_000,
      stallTimeoutMs: 900,
      heartbeatMs: 0,
    }));
  assert.equal(run.termination, 'stall-timeout');
});

test('stall cap spares a silent command that is still burning CPU', t => {
  const directory = scratchDirectory(t);
  const busyLoop = 'const end = Date.now() + 2500; while (Date.now() < end);';
  const run = withEnvironment({ PAIR_STALL_ACTIVITY_SAMPLE_MS: '200' }, () =>
    runObservableCommandSync({
      command: { file: process.execPath, args: ['-e', busyLoop], cwd: directory },
      label: 'silent busy probe',
      outputFile: path.join(directory, 'busy.stdout'),
      hardTimeoutMs: 20_000,
      stallTimeoutMs: 900,
      heartbeatMs: 0,
    }));
  assert.equal(run.termination, null);
  assert.equal(run.status, 0);
  assert.ok(
    run.elapsedMs >= 2000,
    `expected the busy probe to run to completion, got ${run.elapsedMs}ms`,
  );
});

test('verification timeouts default to caps sized for container-heavy suites', () => {
  const timeouts = verificationTimeouts({});
  assert.equal(timeouts.hardTimeoutMs, 45 * 60 * 1000);
  assert.equal(timeouts.stallTimeoutMs, 15 * 60 * 1000);
  assert.equal(timeouts.heartbeatMs, 15 * 1000);
});

test('verification timeouts honor explicit environment overrides', () => {
  const timeouts = verificationTimeouts({
    PAIR_VERIFY_COMMAND_TIMEOUT_MS: '3600000',
    PAIR_VERIFY_STALL_TIMEOUT_MS: '1800000',
    PAIR_VERIFY_HEARTBEAT_MS: '5000',
  });
  assert.equal(timeouts.hardTimeoutMs, 3_600_000);
  assert.equal(timeouts.stallTimeoutMs, 1_800_000);
  assert.equal(timeouts.heartbeatMs, 5_000);
});
