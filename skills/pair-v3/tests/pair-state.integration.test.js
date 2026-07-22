const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const STATE_MODULE = path.resolve(__dirname, '../scripts/lib/pair-state.js');
const CONTROL_MODULE = path.resolve(__dirname, '../scripts/lib/pair-control.js');
const OBSERVABLE_MODULE = path.resolve(__dirname, '../scripts/lib/observable-command.js');
const HANDOVER_MODULE = path.resolve(__dirname, '../scripts/lib/handover-state.js');

function fixture(t) {
  const scratchRoot = process.env.CLAUDE_SCRATCH_DIR
    || path.join(os.homedir(), '.claude-scratch');
  const parent = path.join(scratchRoot, 'my-claude-code', 'pair-v4-state-tests');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'repo-'));
  fs.mkdirSync(path.join(root, '.pair'), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function stateApi() {
  return require(STATE_MODULE);
}

function controlApi() {
  return require(CONTROL_MODULE);
}

function handoverApi() {
  return require(HANDOVER_MODULE);
}

test('real active Work creates repository events, atomic state, readable status, and private attempt evidence', t => {
  const root = fixture(t);
  const {
    appendPairEvent,
    loadPairState,
    pairStatePaths,
  } = stateApi();

  appendPairEvent(root, {
    event: 'work.opened',
    workId: 'work-visible-v4',
    planDigest: 'a'.repeat(64),
  });
  appendPairEvent(root, {
    event: 'attempt.started',
    attemptId: '1.1-one',
    taskId: '1.1',
    runtime: 'codex',
    role: 'coordinator',
    phase: 'implementing',
  });

  const paths = pairStatePaths(root, 'work-visible-v4');
  const state = loadPairState(root);
  assert.equal(state.product, 'pair-v4');
  assert.equal(state.work_id, 'work-visible-v4');
  assert.equal(state.active.attempt_id, '1.1-one');
  assert.equal(state.active.phase, 'implementing');
  assert.equal(state.active.worktree_id, null);
  assert.equal(state.active.base_digest, null);
  assert.match(fs.readFileSync(paths.status, 'utf8'), /Task:\*\* 1\.1[\s\S]*implementing/u);
  assert.ok(fs.existsSync(path.join(paths.attempts, '1.1-one', 'status.json')));
  for (const file of [paths.events, paths.state, paths.status]) {
    assert.equal(fs.statSync(file).mode & 0o077, 0, `${path.basename(file)} must be private`);
  }
});

test('one reducer retains Work authority and freshness projection survives restart', t => {
  const root = fixture(t);
  const { appendPairEvent, loadPairState } = stateApi();
  const { readAgentConversationRegistry, registerAgentConversation, sealAgentConversationHandover, updateAgentConversationCheckpoint } = handoverApi();
  appendPairEvent(root, { event: 'work.opened', workId: 'work-handover-integration', planDigest: 'a'.repeat(64) });
  appendPairEvent(root, { event: 'attempt.started', attemptId: '1.1-handover', taskId: '1.1', phase: 'implementing' });
  const source = { runtime: 'codex', agentConversationId: 'handover-source', kind: 'pair', now: 1_000 };
  registerAgentConversation(root, source);
  updateAgentConversationCheckpoint(root, {
    ...source,
    checkpoint: { coreAnchor: 'Preserve Work authority.', nextAction: 'Seal the Agent Conversation Handover.', artifacts: [] },
  });
  const sealed = sealAgentConversationHandover(root, { ...source, now: 2_000 });

  const registry = readAgentConversationRegistry(root);
  assert.equal(registry.work_id, undefined);
  assert.equal(registry.phase, undefined);
  assert.equal(registry.attempt_id, undefined);
  assert.equal(registry.conversations[sealed.sourceKey].status, 'sealed');
  assert.equal(loadPairState(root).active.phase, 'implementing');
  delete require.cache[require.resolve(STATE_MODULE)];
  const afterRestart = require(STATE_MODULE).loadPairState(root);
  assert.equal(afterRestart.active.attempt_id, '1.1-handover');
  assert.equal(afterRestart.active.phase, 'implementing');
});

test('opening a different Work starts an isolated event sequence and projection', t => {
  const root = fixture(t);
  const { appendPairEvent, loadPairState, readPairEvents } = stateApi();
  appendPairEvent(root, { event: 'work.opened', workId: 'work-first', planDigest: 'a'.repeat(64) });
  appendPairEvent(root, { event: 'warning.recorded', workId: 'work-first', code: 'first-only' });

  appendPairEvent(root, { event: 'work.opened', workId: 'work-second', planDigest: 'b'.repeat(64) });

  const second = loadPairState(root);
  assert.equal(second.work_id, 'work-second');
  assert.equal(second.sequence, 1);
  assert.equal(second.warnings.length, 0);
  assert.deepEqual(readPairEvents(root, 'work-first').map(event => event.sequence), [1, 2]);
  assert.deepEqual(readPairEvents(root, 'work-second').map(event => event.sequence), [1]);
});

test('concurrent multi-process append produces one monotonic event sequence and one reducer projection', t => {
  const root = fixture(t);
  const script = [
    `const { appendPairEvent } = require(${JSON.stringify(STATE_MODULE)});`,
    `const root = ${JSON.stringify(root)};`,
    'for (let index = 0; index < 12; index++) {',
    "  appendPairEvent(root, { event: 'phase.progressed', attemptId: process.argv[1], taskId: '1.1', phase: 'implementing', evidence: String(index) });",
    '}',
  ].join('\n');
  const children = ['writer-a', 'writer-b', 'writer-c'].map(id =>
    childProcess.spawn(process.execPath, ['-e', script, id], { stdio: 'pipe' }));

  return Promise.all(children.map(child => new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(stderr || `writer exited ${code}`)));
  }))).then(() => {
    const { loadPairState, readPairEvents } = stateApi();
    const events = readPairEvents(root);
    assert.equal(events.length, 36);
    assert.deepEqual(events.map(event => event.sequence), Array.from({ length: 36 }, (_value, index) => index + 1));
    assert.equal(new Set(events.map(event => event.event_id)).size, 36);
    assert.equal(loadPairState(root).sequence, 36);
  });
});

test('terminated lock owner and interrupted atomic projection recover without losing events', t => {
  const root = fixture(t);
  const { appendPairEvent, loadPairState, pairStatePaths } = stateApi();
  const paths = pairStatePaths(root, 'work-recovered');
  fs.mkdirSync(paths.lock, { recursive: true });
  fs.writeFileSync(path.join(paths.lock, 'owner.json'), JSON.stringify({ pid: 2147483647, acquired_at: '2000-01-01T00:00:00.000Z' }));

  appendPairEvent(root, { event: 'work.opened', workId: 'work-recovered' });
  fs.writeFileSync(paths.state, '{interrupted projection');

  const state = loadPairState(root);
  assert.equal(state.work_id, 'work-recovered');
  assert.equal(state.sequence, 1);
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(paths.state, 'utf8')));
});

test('superseding attempt outcome yields exactly one effective terminal result', t => {
  const root = fixture(t);
  const { appendPairEvent, effectiveAttemptRecords, loadPairState } = stateApi();
  appendPairEvent(root, { event: 'attempt.started', attemptId: '1.1-one', taskId: '1.1', phase: 'implementing' });
  const first = appendPairEvent(root, {
    event: 'attempt.outcome', attemptId: '1.1-one', taskId: '1.1', disposition: 'regenerated', action: 'retry-infrastructure', cause: 'environment-failure', terminal: true,
  });
  appendPairEvent(root, {
    event: 'attempt.outcome', attemptId: '1.1-one', taskId: '1.1', disposition: 'accepted', action: 'complete-task', terminal: true, supersedes: first.event_id,
  });

  const records = effectiveAttemptRecords(root);
  assert.equal(records.length, 1);
  assert.equal(records[0].disposition, 'accepted');
  assert.equal(loadPairState(root).attempts['1.1-one'].disposition, 'accepted');
});

test('missing legacy storage is a nonblocking warning and secret-like fields are never persisted', t => {
  const root = fixture(t);
  const { appendPairEvent, importLegacyAttemptHistory, pairStatePaths, readPairEvents } = stateApi();
  const missing = path.join(root, 'missing', 'attempts.jsonl');
  const result = importLegacyAttemptHistory(root, missing, 'work-v4');
  assert.equal(result.imported, 0);
  assert.equal(result.warning, 'legacy-storage-unavailable');
  importLegacyAttemptHistory(root, missing, 'work-v4');
  assert.equal(
    readPairEvents(root).filter(event => event.code === 'legacy-storage-unavailable').length,
    1,
    'the same optional legacy source warns once instead of growing the event log on every command',
  );

  appendPairEvent(root, {
    event: 'phase.progressed',
    attemptId: '1.1-one',
    prompt: 'do not store me',
    environment: { API_TOKEN: 'super-secret-canary' },
    command: 'tool --token=super-secret-canary',
    evidence: 'Bearer super-secret-canary',
  });
  const raw = fs.readFileSync(pairStatePaths(root).events, 'utf8');
  assert.doesNotMatch(raw, /super-secret-canary|do not store me/u);
  const events = readPairEvents(root);
  assert.equal(events.at(-1).prompt, undefined);
  assert.equal(events.at(-1).environment, undefined);
});

test('legacy import only brings records for the active Work', t => {
  const root = fixture(t);
  const legacy = path.join(root, 'legacy.jsonl');
  fs.writeFileSync(legacy, [
    { event: 'attempt.started', attemptId: 'a', workId: 'work-a' },
    { event: 'attempt.completed', attemptId: 'a', workId: 'work-a', disposition: 'accepted' },
    { event: 'attempt.started', attemptId: 'b', workId: 'work-b' },
    { event: 'attempt.completed', attemptId: 'b', workId: 'work-b', disposition: 'accepted' },
  ].map(row => JSON.stringify(row)).join('\n'));
  const { importLegacyAttemptHistory, readPairEvents } = stateApi();

  const result = importLegacyAttemptHistory(root, legacy, 'work-a');

  assert.equal(result.imported, 2);
  assert.deepEqual(
    readPairEvents(root).filter(event => event.legacy).map(event => event.attemptId),
    ['a', 'a'],
  );
});

test('pause, takeover, and exclusive human edit preserve the exact resume phase', t => {
  const root = fixture(t);
  const { appendPairEvent, loadPairState, readPairEvents } = stateApi();
  appendPairEvent(root, { event: 'work.opened', workId: 'work-control' });
  appendPairEvent(root, {
    event: 'attempt.started', attemptId: '1.1-control', taskId: '1.1', phase: 'reviewing',
  });
  appendPairEvent(root, {
    event: 'continuation.claimed', workId: 'work-control', session_id: 'codex-owner', runtime: 'codex',
  });
  const { beginHumanEdit, pauseWork, resumeWork, takeoverWork } = controlApi();

  pauseWork(root);
  let state = loadPairState(root);
  assert.equal(state.lifecycle, 'paused');
  assert.equal(state.continuation.resume_target, 'reviewing');
  assert.equal(state.continuation.owner_session_id, null);
  const pauseEvents = readPairEvents(root);
  const checkpoint = pauseEvents.find(event => event.event === 'pause.checkpointed');
  assert.ok(checkpoint, 'every pause must persist one bounded Resume Checkpoint');
  assert.equal(checkpoint.checkpoint.resume_target, 'reviewing');
  assert.equal(checkpoint.checkpoint.session_id, 'codex-owner');
  assert.ok(Buffer.byteLength(JSON.stringify(checkpoint.checkpoint), 'utf8') <= 8192);
  assert.ok(
    pauseEvents.findIndex(event => event.event === 'pause.checkpointed') <
      pauseEvents.findIndex(event => event.event === 'work.paused'),
    'the checkpoint must exist before the paused transition',
  );

  beginHumanEdit(root, 'code');
  assert.throws(() => beginHumanEdit(root, 'plan'), /human edit.*already active/i);
  assert.throws(() => resumeWork(root, 'codex-owner'), /human edit.*active/i);

  takeoverWork(root, 'claude-owner', 'claude');
  state = loadPairState(root);
  assert.equal(state.continuation.owner_session_id, 'claude-owner');
  assert.equal(state.continuation.human_edit.kind, 'code');
});

test('resume journals why it dispatches the exact saved phase', t => {
  const root = fixture(t);
  const { appendPairEvent, readPairEvents } = stateApi();
  appendPairEvent(root, { event: 'work.opened', workId: 'work-resume-reason' });
  appendPairEvent(root, {
    event: 'attempt.started', attemptId: '1.2-resume', taskId: '1.2', phase: 'verifying',
  });
  const { pauseWork, resumeWork } = controlApi();

  pauseWork(root);
  const resumed = resumeWork(root, 'new-owner', 'claude');

  assert.equal(resumed.lifecycle, 'verifying');
  const event = readPairEvents(root).findLast(candidate => candidate.event === 'work.resumed');
  assert.equal(event.resume_target, 'verifying');
  assert.equal(event.dispatch_reason, 'explicit-resume-to-saved-phase');
});

test('correctable cumulative findings remain actionable while terminal Work releases ownership', t => {
  const root = fixture(t);
  const { appendPairEvent, loadPairState } = stateApi();
  appendPairEvent(root, { event: 'work.opened', workId: 'work-cumulative-state' });
  appendPairEvent(root, {
    event: 'continuation.claimed', workId: 'work-cumulative-state', session_id: 'owner-session', runtime: 'codex',
  });
  appendPairEvent(root, {
    event: 'work.correction-needed', workId: 'work-cumulative-state', phase: 'cumulative-correction',
    reason: 'a reachable implementation defect remains',
  });

  let state = loadPairState(root);
  assert.equal(state.lifecycle, 'cumulative-correction');
  assert.equal(state.continuation.resume_target, 'cumulative-correction');
  assert.equal(state.continuation.owner_session_id, 'owner-session');

  appendPairEvent(root, { event: 'work.completed', workId: 'work-cumulative-state' });
  state = loadPairState(root);
  assert.equal(state.lifecycle, 'complete');
  assert.equal(state.continuation.resume_target, null);
  assert.equal(state.continuation.owner_session_id, null);
});

test('Cancel now terminates only the journaled in-flight request and preserves its exact phase', async t => {
  const root = fixture(t);
  const { appendPairEvent, loadPairState, readPairEvents } = stateApi();
  appendPairEvent(root, { event: 'work.opened', workId: 'work-cancel' });
  appendPairEvent(root, {
    event: 'attempt.started',
    workId: 'work-cancel',
    attemptId: '2.1-cancel',
    taskId: '2.1',
    phase: 'verifying',
  });
  const output = path.join(root, 'cancel.stdout');
  const script = [
    `const { runObservableCommandSync } = require(${JSON.stringify(OBSERVABLE_MODULE)});`,
    `runObservableCommandSync({`,
    `  command: { file: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd: ${JSON.stringify(root)} },`,
    `  label: 'cancellable verification', outputFile: ${JSON.stringify(output)},`,
    `  hardTimeoutMs: 30000, stallTimeoutMs: 30000, heartbeatMs: 0,`,
    `  stateContext: { root: ${JSON.stringify(root)}, workId: 'work-cancel', attemptId: '2.1-cancel', phase: 'verifying', requestKind: 'verification' },`,
    `});`,
  ].join('\n');
  const launcher = childProcess.spawn(process.execPath, ['-e', script], { stdio: 'pipe' });
  t.after(() => {
    if (launcher.exitCode === null) launcher.kill('SIGKILL');
  });

  const deadline = Date.now() + 5_000;
  while (!loadPairState(root).active?.request_pid && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const trackedPid = loadPairState(root).active?.request_pid;
  assert.ok(Number.isInteger(trackedPid), 'request.started must publish the exact child PID before cancellation');

  const { cancelInFlight } = controlApi();
  const cancelled = cancelInFlight(root);
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.pid, trackedPid);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('launcher did not observe cancellation')), 5_000);
    launcher.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });

  const state = loadPairState(root);
  assert.equal(state.active.phase, 'verifying');
  assert.equal(state.continuation.resume_target, 'verifying');
  assert.equal(state.active.request_pid, null);
  const requests = readPairEvents(root).filter(event => event.event.startsWith('request.'));
  assert.ok(requests.some(event => event.event === 'request.cancelled' && event.request_pid === trackedPid));
  assert.equal(new Set(requests.map(event => event.request_id).filter(Boolean)).size, 1);
});

test('pause waits for the current request boundary before releasing continuation ownership', async t => {
  const root = fixture(t);
  const { appendPairEvent, loadPairState } = stateApi();
  appendPairEvent(root, { event: 'work.opened', workId: 'work-boundary-pause' });
  appendPairEvent(root, {
    event: 'attempt.started', workId: 'work-boundary-pause', attemptId: '3.1-pause', taskId: '3.1', phase: 'reviewing',
  });
  appendPairEvent(root, {
    event: 'continuation.claimed', workId: 'work-boundary-pause', session_id: 'owner-session', runtime: 'codex',
  });
  const output = path.join(root, 'pause.stdout');
  const script = [
    `const { runObservableCommandSync } = require(${JSON.stringify(OBSERVABLE_MODULE)});`,
    `runObservableCommandSync({`,
    `  command: { file: process.execPath, args: ['-e', "setTimeout(() => process.stdout.write('done\\\\n'), 350)"], cwd: ${JSON.stringify(root)} },`,
    `  label: 'pause boundary review', outputFile: ${JSON.stringify(output)},`,
    `  hardTimeoutMs: 5000, stallTimeoutMs: 2000, heartbeatMs: 0,`,
    `  stateContext: { root: ${JSON.stringify(root)}, workId: 'work-boundary-pause', attemptId: '3.1-pause', phase: 'reviewing', requestKind: 'review' },`,
    `});`,
  ].join('\n');
  const launcher = childProcess.spawn(process.execPath, ['-e', script], { stdio: 'pipe' });
  t.after(() => {
    if (launcher.exitCode === null) launcher.kill('SIGKILL');
  });
  const deadline = Date.now() + 5_000;
  while (!loadPairState(root).in_flight_request?.request_pid && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }

  const { pauseWork } = controlApi();
  let state = pauseWork(root);
  assert.equal(state.continuation.pause_requested, true);
  assert.equal(state.continuation.paused, false);
  assert.equal(state.continuation.owner_session_id, 'owner-session');

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('request did not reach its pause boundary')), 5_000);
    launcher.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  state = loadPairState(root);
  assert.equal(state.continuation.pause_requested, false);
  assert.equal(state.continuation.paused, true);
  assert.equal(state.continuation.owner_session_id, null);
  assert.equal(state.continuation.resume_target, 'reviewing');
});
