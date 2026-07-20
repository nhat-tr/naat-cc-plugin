const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ensureHost,
  hostStatus,
  sessionNameForRoot,
} = require('../scripts/lib/tmux-host');
const { runObservableCommandSync } = require('../scripts/lib/observable-command');
const {
  appendPairEvent,
  loadPairState,
  readPairEvents,
} = require('../scripts/lib/pair-state');

function fixture(t) {
  const base = process.env.CLAUDE_SCRATCH_DIR || path.join(os.homedir(), '.claude-scratch');
  const root = fs.mkdtempSync(path.join(base, 'pair-v4-tmux-'));
  const session = sessionNameForRoot(root);
  childProcess.spawnSync('tmux', ['kill-session', '-t', `=${session}`]);
  t.after(() => {
    childProcess.spawnSync('tmux', ['kill-session', '-t', `=${session}`]);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, session };
}

test('creates exactly three persistent panes idempotently', t => {
  if (childProcess.spawnSync('tmux', ['-V']).status !== 0) return t.skip('tmux unavailable');
  const { root, session } = fixture(t);

  const first = ensureHost(root);
  const second = ensureHost(root);
  const status = hostStatus(root);

  assert.equal(first.session, session);
  assert.deepEqual(Object.keys(first.panes).sort(), ['coordinator', 'editor', 'reviewer']);
  assert.deepEqual(second.panes, first.panes);
  assert.equal(status.panes.length, 3);
  assert.deepEqual(status.panes.map(pane => pane.title).sort(), ['coordinator', 'editor', 'reviewer']);
  const stateFile = path.join(root, '.pair', 'tmux.json');
  assert.equal(fs.statSync(stateFile).mode & 0o077, 0);
});

test('host refuses a conflicting fourth pane without deleting it', t => {
  if (childProcess.spawnSync('tmux', ['-V']).status !== 0) return t.skip('tmux unavailable');
  const { root, session } = fixture(t);
  ensureHost(root);
  childProcess.spawnSync('tmux', ['split-window', '-d', '-t', `${session}:`, '-c', root]);

  assert.throws(() => ensureHost(root), /expected exactly three panes.*found 4/i);
  const panes = childProcess.spawnSync(
    'tmux',
    ['list-panes', '-t', `=${session}`, '-F', '#{pane_id}'],
    { encoding: 'utf8' },
  ).stdout.trim().split('\n');
  assert.equal(panes.length, 4, 'Pair must never destroy an unknown pane to repair its layout');
});

test('the actual review request runs visibly in the reusable reviewer pane and journals request identity', t => {
  if (childProcess.spawnSync('tmux', ['-V']).status !== 0) return t.skip('tmux unavailable');
  const { root } = fixture(t);
  appendPairEvent(root, { event: 'work.opened', workId: 'work-visible-review' });
  appendPairEvent(root, {
    event: 'attempt.started',
    workId: 'work-visible-review',
    attemptId: '1.1-visible',
    taskId: '1.1',
    phase: 'reviewing',
  });
  const outputFile = path.join(root, 'review.stdout');

  const result = runObservableCommandSync({
    command: {
      file: process.execPath,
      args: ['-e', "process.stdout.write('VISIBLE_REVIEW_CANARY\\n')"],
      cwd: root,
    },
    label: 'visible review 1.1',
    outputFile,
    hardTimeoutMs: 5_000,
    stallTimeoutMs: 2_000,
    heartbeatMs: 100,
    visible: { root, role: 'reviewer' },
    stateContext: {
      root,
      workId: 'work-visible-review',
      attemptId: '1.1-visible',
      phase: 'reviewing',
      requestKind: 'review',
    },
  });

  const reviewerPane = hostStatus(root).configured.panes.reviewer;
  const captured = childProcess.spawnSync(
    'tmux',
    ['capture-pane', '-p', '-t', reviewerPane, '-S', '-100'],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, JSON.stringify({
    status: result.status,
    error: result.error?.message,
    termination: result.termination,
    stdout: result.stdout,
    stderr: result.stderr,
    pane: captured.stdout,
  }));
  assert.match(result.stdout, /VISIBLE_REVIEW_CANARY/);
  const state = loadPairState(root);
  assert.equal(state.active.request_pid, null);
  const requestEvents = readPairEvents(root).filter(event => event.event.startsWith('request.'));
  assert.deepEqual(requestEvents.map(event => event.event), ['request.started', 'request.completed']);
  assert.equal(requestEvents[0].request_id, requestEvents[1].request_id);
  assert.ok(Number.isInteger(requestEvents[0].request_pid));

  assert.equal(captured.status, 0, captured.stderr);
  assert.match(captured.stdout, /visible\s+review\s+1\.1/);
  assert.match(captured.stdout, /VISIBLE_REVIEW_CANARY/);
});
