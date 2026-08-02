const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { appendPairEvent, loadPairState, readPairEvents } = require('../scripts/lib/pair-state');
const { runVerificationCommand } = require('../scripts/pair-task');

function fixture(t, { withWork = true } = {}) {
  const scratchBase = process.env.CLAUDE_SCRATCH_DIR || path.join(os.homedir(), '.claude-scratch');
  const root = fs.mkdtempSync(path.join(scratchBase, 'my-claude-code-verify-journal-'));
  childProcess.spawnSync('git', ['init', '-q'], { cwd: root });
  if (withWork) {
    appendPairEvent(root, { event: 'work.opened', workId: 'work-verify-journal', phase: 'ready' });
    appendPairEvent(root, {
      event: 'work.phase.entered',
      workId: 'work-verify-journal',
      phase: 'cumulative-verification',
    });
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('verification runs journal request.started and request.completed', t => {
  const root = fixture(t);
  const result = runVerificationCommand(root, 'true', 'final gate 1/2');
  assert.equal(result.status, 0);

  const events = readPairEvents(root);
  const started = events.find(event => event.event === 'request.started');
  assert.ok(started, 'expected verification to journal request.started');
  assert.equal(started.phase, 'cumulative-verification');
  assert.equal(started.request_kind, 'verification final gate 1/2');
  assert.ok(Number.isInteger(started.request_pid) && started.request_pid > 0);

  const completed = events.find(event => event.event === 'request.completed');
  assert.ok(completed, 'expected verification to journal request.completed');
  assert.equal(completed.request_id, started.request_id);
  assert.equal(completed.status, 0);

  assert.equal(loadPairState(root).in_flight_request, null);
});

test('verification exposes a live in-flight request while the gate runs', t => {
  const root = fixture(t);
  // The command itself proves in_flight_request is visible mid-run: it reads
  // the projection from inside the running verification gate.
  const probeFile = path.join(root, 'in-flight-probe.js');
  fs.writeFileSync(probeFile, `
    const { loadPairState } = require(${JSON.stringify(
      path.resolve(__dirname, '../scripts/lib/pair-state'),
    )});
    const request = loadPairState(process.cwd()).in_flight_request;
    process.exit(request && request.request_id ? 0 : 3);
  `);
  const result = runVerificationCommand(root, `node ${JSON.stringify(probeFile)}`, 'in-flight probe');
  assert.equal(result.status, 0, result.output);
});

test('verification keeps a repository without Pair state inert', t => {
  const root = fixture(t, { withWork: false });
  const result = runVerificationCommand(root, 'true', 'legacy probe');
  assert.equal(result.status, 0);
  assert.equal(
    fs.existsSync(path.join(root, '.pair')),
    false,
    'a legacy repository must not gain .pair state from verification',
  );
});
