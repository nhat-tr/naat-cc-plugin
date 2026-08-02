const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const hook = path.resolve(__dirname, '../../../hooks/stop-gate.sh');
const stopAdapter = path.resolve(__dirname, '../scripts/pair-stop-adapter');
const ownerAdapter = path.resolve(__dirname, '../scripts/pair-owner-adapter');
const orientAdapter = path.resolve(__dirname, '../scripts/pair-orient');
const { appendPairEvent, loadPairState } = require('../scripts/lib/pair-state');
const { pauseWork, takeoverWork } = require('../scripts/lib/pair-control');

function fixture(t) {
  const scratchBase = process.env.CLAUDE_SCRATCH_DIR || path.join(os.homedir(), '.claude-scratch');
  const root = fs.mkdtempSync(path.join(scratchBase, 'my-claude-code-stop-gate-'));
  childProcess.spawnSync('git', ['init', '-q'], { cwd: root });
  fs.mkdirSync(path.join(root, '.pair'), { recursive: true });
  appendPairEvent(root, { event: 'work.opened', workId: 'work-stop-contract', phase: 'ready' });
  appendPairEvent(root, {
    event: 'attempt.started', attemptId: '1.1-stop', taskId: '1.1', phase: 'implementing',
  });
  appendPairEvent(root, {
    event: 'continuation.claimed', workId: 'work-stop-contract', session_id: 'owner-session', runtime: 'codex',
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function invoke(root, runtime, sessionId, extra = {}) {
  const result = childProcess.spawnSync('bash', [hook], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PAIR_HOOK_RUNTIME: runtime,
      PAIR_STOP_GATE: 'on',
    },
    input: `${JSON.stringify({
      cwd: root,
      session_id: sessionId,
      hook_event_name: 'Stop',
      ...extra,
    })}\n`,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

function captureOwner(root, sessionId, command, extra = {}) {
  return childProcess.spawnSync(process.execPath, [ownerAdapter], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PAIR_HOOK_RUNTIME: 'claude' },
    input: `${JSON.stringify({
      cwd: root,
      session_id: sessionId,
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command },
      ...extra,
    })}\n`,
  });
}

function orient(root, sessionId = 'orient-session') {
  return childProcess.spawnSync(process.execPath, [orientAdapter], {
    cwd: root,
    encoding: 'utf8',
    input: `${JSON.stringify({ cwd: root, session_id: sessionId, hook_event_name: 'SessionStart' })}\n`,
  });
}

test('coordinated Stop gate continues only the owning Codex and Claude conversations', t => {
  const root = fixture(t);
  const codexOwner = invoke(root, 'codex', 'owner-session');
  assert.equal(codexOwner.decision, 'block');
  assert.match(codexOwner.reason, /Pair v4 continuation owns this chat/u);
  assert.equal(invoke(root, 'codex', 'other-codex'), null);
  takeoverWork(root, 'claude-owner', 'claude');
  const claudeOwner = invoke(root, 'claude', 'claude-owner');
  assert.equal(claudeOwner.decision, 'block');
  assert.match(claudeOwner.reason, /Pair v4 continuation owns this chat/u);
  assert.equal(invoke(root, 'claude', 'other-claude'), null);
});

test('coordinated Stop gate emits each provider native blocking response shape', t => {
  const root = fixture(t);
  const codex = invoke(root, 'codex', 'owner-session');
  assert.deepEqual(Object.keys(codex).sort(), ['decision', 'reason']);
  assert.equal(codex.decision, 'block');

  takeoverWork(root, 'claude-owner', 'claude');
  const claude = invoke(root, 'claude', 'claude-owner', { stop_hook_active: true });
  assert.deepEqual(Object.keys(claude).sort(), ['decision', 'reason']);
  assert.equal(claude.decision, 'block');
});

test('Stop adapter keeps empty malformed and unrelated hook input byte-inert', t => {
  const root = fixture(t);
  for (const input of ['{}\n', '{malformed\n', `${JSON.stringify({
    cwd: root,
    session_id: 'owner-session',
    hook_event_name: 'PostToolUse',
  })}\n`]) {
    const result = childProcess.spawnSync(process.execPath, [stopAdapter], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PAIR_HOOK_RUNTIME: 'codex' },
      input,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  }
});

test('Claude captures ownership from the exact Pair Bash invocation, not an unrelated command', t => {
  const root = fixture(t);
  appendPairEvent(root, {
    event: 'continuation.claimed', workId: 'work-stop-contract', session_id: null, runtime: null,
  });

  const unrelated = captureOwner(root, 'unrelated-session', 'rg -n pair-loop README.md');
  assert.equal(unrelated.status, 0, unrelated.stderr);
  assert.equal(loadPairState(root).continuation.owner_session_id, null);

  const captured = captureOwner(root, 'claude-pair-owner', 'PAIR_RUNTIME=auto pair-loop --runtime auto');
  assert.equal(captured.status, 0, captured.stderr);
  assert.equal(loadPairState(root).continuation.owner_session_id, 'claude-pair-owner');
  assert.equal(invoke(root, 'claude', 'claude-pair-owner').decision, 'block');
  assert.equal(invoke(root, 'claude', 'unrelated-session'), null);
});

test('Pair PostToolUse captures the pre-implementation Claude usage baseline', t => {
  const root = fixture(t);
  appendPairEvent(root, {
    event: 'continuation.claimed', workId: 'work-stop-contract', session_id: null, runtime: null,
  });
  const transcript = path.join(root, 'claude-transcript.jsonl');
  fs.writeFileSync(transcript, `${JSON.stringify({
    sessionId: 'claude-owner', type: 'assistant',
    message: {
      id: 'message-1', model: 'claude-sonnet-4-5',
      usage: { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 80, output_tokens: 10 },
    },
  })}\n`);

  const captured = captureOwner(root, 'claude-owner', 'pair-loop --runtime auto', {
    transcript_path: transcript,
  });

  assert.equal(captured.status, 0, captured.stderr);
  const usage = require('../scripts/lib/pair-state').readPairEvents(root)
    .filter(event => event.event === 'usage.recorded' && event.role === 'coordinator');
  assert.equal(usage.length, 1);
  assert.equal(usage[0].baseline, true);
  assert.equal(usage[0].runtime, 'claude');
  assert.equal(usage[0].model, 'claude-sonnet-4-5');
  assert.equal(loadPairState(root).continuation.owner_session_id, 'claude-owner');
});

test('unrelated sessions stop normally while pause releases continuation ownership', t => {
  const root = fixture(t);
  const unrelatedTranscript = path.join(root, 'unrelated-codex-transcript.jsonl');
  fs.writeFileSync(unrelatedTranscript, [
    { type: 'session_meta', payload: { id: 'unrelated-session' } },
    { type: 'turn_context', payload: { model: 'gpt-5.6-terra', effort: 'medium' } },
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: {
      input_tokens: 900, cached_input_tokens: 700, output_tokens: 90, reasoning_output_tokens: 10,
    } } } },
  ].map(record => JSON.stringify(record)).join('\n') + '\n');
  assert.equal(invoke(root, 'codex', 'unrelated-session', { transcript_path: unrelatedTranscript }), null);
  assert.equal(
    require('../scripts/lib/pair-state').readPairEvents(root)
      .filter(event => event.event === 'usage.recorded' && event.role === 'coordinator').length,
    0,
    'a non-owner transcript must never be attributed to the active Review Slice',
  );
  pauseWork(root);
  assert.equal(invoke(root, 'codex', 'owner-session'), null);
  assert.equal(loadPairState(root).continuation.owner_session_id, null);

  takeoverWork(root, 'new-owner', 'codex');
  assert.equal(invoke(root, 'codex', 'owner-session'), null);
  assert.equal(invoke(root, 'codex', 'new-owner'), null, 'paused Work does not auto-continue even after takeover');
});

function armInFlight(root, { requestId = 'req-live-1', startedAt, loopPid = process.pid } = {}) {
  appendPairEvent(root, {
    event: 'request.started',
    workId: 'work-stop-contract',
    request_id: requestId,
    request_pid: 4242,
    request_kind: 'verification final gate 1/11',
    phase: 'cumulative-verification',
    ...(startedAt ? { at: startedAt } : {}),
  });
  fs.writeFileSync(
    path.join(root, '.pair', 'active-loop.json'),
    `${JSON.stringify({ schema: 1, pid: loopPid })}\n`,
  );
}

test('Stop gate advises a wake path once while a request is in flight, then allows Stop', t => {
  const root = fixture(t);
  armInFlight(root);

  const advised = invoke(root, 'codex', 'owner-session');
  assert.equal(advised.decision, 'block');
  assert.match(advised.reason, /is executing cumulative-verification/u);
  assert.match(advised.reason, /wake path/u);
  assert.doesNotMatch(advised.reason, /Run pair-loop --status/u);

  assert.equal(invoke(root, 'codex', 'owner-session'), null, 'second Stop while the same request runs is allowed');
  assert.equal(invoke(root, 'codex', 'owner-session'), null, 'the allowance is stable across further Stops');
});

test('Stop gate re-advises when a new request starts in flight', t => {
  const root = fixture(t);
  armInFlight(root, { requestId: 'req-live-1' });
  assert.equal(invoke(root, 'codex', 'owner-session').decision, 'block');
  assert.equal(invoke(root, 'codex', 'owner-session'), null);

  appendPairEvent(root, {
    event: 'request.completed', workId: 'work-stop-contract', request_id: 'req-live-1', status: 0,
  });
  armInFlight(root, { requestId: 'req-live-2' });

  const readvised = invoke(root, 'codex', 'owner-session');
  assert.equal(readvised.decision, 'block');
  assert.match(readvised.reason, /wake path/u);
  assert.equal(invoke(root, 'codex', 'owner-session'), null);
});

test('Stop gate keeps demanding advancement when the pair-loop process is gone', t => {
  const root = fixture(t);
  // macOS caps pids at 99998, Linux defaults to 4194304: this pid is never alive.
  armInFlight(root, { loopPid: 99_999_999 });

  const blocked = invoke(root, 'codex', 'owner-session');
  assert.equal(blocked.decision, 'block');
  assert.match(blocked.reason, /Run pair-loop --status/u);
  assert.doesNotMatch(blocked.reason, /wake path/u);
});

test('Stop gate treats an overaged in-flight request as abandoned', t => {
  const root = fixture(t);
  armInFlight(root, {
    startedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
  });

  const blocked = invoke(root, 'codex', 'owner-session');
  assert.equal(blocked.decision, 'block');
  assert.match(blocked.reason, /Run pair-loop --status/u);
  assert.doesNotMatch(blocked.reason, /wake path/u);
});

test('orientation names a material blocker without telling a new session to advance it', t => {
  const root = fixture(t);
  appendPairEvent(root, {
    event: 'work.blocked', workId: 'work-stop-contract', phase: 'reviewing',
    reason: 'canonical contract needs a human decision',
  });

  const result = orient(root);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /canonical contract needs a human decision/i);
  assert.match(result.stdout, /do not dispatch/i);
  assert.doesNotMatch(result.stdout, /advance only the saved phase/i);
});

test('owning Stop gate keeps emitting continuation instructions across evidence progress', t => {
  const root = fixture(t);
  for (let index = 0; index < 10; index++) {
    assert.equal(invoke(root, 'codex', 'owner-session').decision, 'block');
  }
  appendPairEvent(root, {
    event: 'phase.progressed', attemptId: '1.1-stop', taskId: '1.1', phase: 'verifying',
    evidence_digest: 'a'.repeat(64),
  });
  assert.equal(invoke(root, 'codex', 'owner-session').decision, 'block');
});

test('owning Stop gate records observed coordinator usage without persisting transcript content', t => {
  const root = fixture(t);
  const transcript = path.join(root, 'codex-transcript.jsonl');
  const writeTranscript = usage => fs.writeFileSync(transcript, [
    { type: 'session_meta', payload: { id: 'owner-session' } },
    { type: 'turn_context', payload: { model: 'gpt-5.6-terra', effort: 'medium' } },
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: usage } } },
  ].map(record => JSON.stringify(record)).join('\n') + '\n');
  writeTranscript({ input_tokens: 1000, cached_input_tokens: 700, output_tokens: 100, reasoning_output_tokens: 20 });

  assert.equal(invoke(root, 'codex', 'owner-session', { transcript_path: transcript }).decision, 'block');
  writeTranscript({ input_tokens: 1500, cached_input_tokens: 1050, output_tokens: 160, reasoning_output_tokens: 30 });
  assert.equal(invoke(root, 'codex', 'owner-session', { transcript_path: transcript }).decision, 'block');

  const usage = require('../scripts/lib/pair-state').readPairEvents(root)
    .filter(event => event.event === 'usage.recorded' && event.role === 'coordinator');
  assert.equal(usage.length, 2);
  assert.equal(usage[0].baseline, true);
  assert.equal(usage[1].input_tokens, 500);
  assert.equal(usage[1].cached_input_tokens, 350);
  assert.equal(usage[1].output_tokens, 60);
  const bytes = fs.readFileSync(path.join(root, '.pair', 'runs', 'work-stop-contract', 'events.jsonl'), 'utf8');
  assert.doesNotMatch(bytes, /codex-transcript|token_count|turn_context/i);
});

test('hook infrastructure failure never deletes or rewrites the durable phase', t => {
  const root = fixture(t);
  const before = loadPairState(root);
  const pointer = path.join(root, '.pair', 'current-run.json');
  fs.writeFileSync(pointer, '{corrupt');
  assert.equal(invoke(root, 'codex', 'owner-session'), null);
  fs.writeFileSync(pointer, `${JSON.stringify({
    schema: 4,
    work_id: 'work-stop-contract',
    run: '.pair/runs/work-stop-contract',
  })}\n`);
  const after = loadPairState(root);
  assert.equal(after.active.attempt_id, before.active.attempt_id);
  assert.equal(after.active.phase, before.active.phase);
});

test('a dispatching Pair turn keeps the Freshness Gate warm without a Stop, and only a Pair invocation counts', t => {
  const root = fixture(t);
  const {
    FRESHNESS_WINDOW_MS, MAX_UNSTOPPED_ACTIVITY_MS, derivePairCheckpoint, freshnessProjection,
    readAgentConversationRegistry, registerAgentConversation, updateAgentConversationCheckpoint,
  } = require('../scripts/lib/handover-state');
  const identity = { runtime: 'claude', agentConversationId: 'live-dispatch-session', kind: 'pair' };
  const registered = registerAgentConversation(root, { ...identity, now: 1_000 });
  updateAgentConversationCheckpoint(root, { ...identity, now: 1_000, checkpoint: derivePairCheckpoint(root) });
  const stored = () => readAgentConversationRegistry(root).conversations[registered.sourceKey];

  const dispatchedAt = 1_000 + (FRESHNESS_WINDOW_MS / 2);
  assert.equal(captureOwner(root, 'live-dispatch-session', 'pair-loop', { now: dispatchedAt }).status, 0);
  assert.equal(stored().last_active_at, new Date(dispatchedAt).toISOString());
  assert.equal(
    freshnessProjection(root, 1_000 + FRESHNESS_WINDOW_MS + 60_000).conversations[0].status,
    'warm',
    'the gate reads a dispatching turn as live work',
  );

  const unrelatedAt = dispatchedAt + 60_000;
  assert.equal(captureOwner(root, 'live-dispatch-session', 'git status', { now: unrelatedAt }).status, 0);
  assert.equal(stored().last_active_at, new Date(dispatchedAt).toISOString(), 'only Pair dispatch carries liveness');

  const runawayAt = 1_000 + MAX_UNSTOPPED_ACTIVITY_MS + 1;
  assert.equal(captureOwner(root, 'live-dispatch-session', 'pair-loop', { now: runawayAt }).status, 0);
  assert.equal(stored().last_active_at, new Date(dispatchedAt).toISOString(), 'a wedged loop stops extending liveness');
  assert.equal(freshnessProjection(root, runawayAt).conversations[0].status, 'cold');
});

test('the owner hook stays inert for a conversation the Freshness Gate never registered', t => {
  const root = fixture(t);
  const result = captureOwner(root, 'never-registered-session', 'pair-loop', { now: 5_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    Object.keys(require('../scripts/lib/handover-state').readAgentConversationRegistry(root).conversations).length,
    0,
    'observed activity never registers a conversation on its own',
  );
});
