const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const hook = path.resolve(__dirname, '../../../hooks/stop-gate.sh');
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

function captureOwner(root, sessionId, command) {
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

test('disabled Stop gate leaves both owning and unrelated Codex and Claude sessions unblocked', t => {
  const root = fixture(t);
  assert.equal(invoke(root, 'codex', 'owner-session'), null);
  assert.equal(invoke(root, 'codex', 'other-codex'), null);
  takeoverWork(root, 'claude-owner', 'claude');
  assert.equal(invoke(root, 'claude', 'claude-owner'), null);
  assert.equal(invoke(root, 'claude', 'other-claude'), null);
});

test('disabled Stop gate emits no native blocking response shape', t => {
  const root = fixture(t);
  const codex = invoke(root, 'codex', 'owner-session');
  assert.equal(codex, null);

  takeoverWork(root, 'claude-owner', 'claude');
  const claude = invoke(root, 'claude', 'claude-owner', { stop_hook_active: true });
  assert.equal(claude, null);
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
  assert.equal(invoke(root, 'claude', 'claude-pair-owner'), null);
  assert.equal(invoke(root, 'claude', 'unrelated-session'), null);
});

test('unrelated sessions stop normally while pause releases continuation ownership', t => {
  const root = fixture(t);
  assert.equal(invoke(root, 'codex', 'unrelated-session'), null);
  pauseWork(root);
  assert.equal(invoke(root, 'codex', 'owner-session'), null);
  assert.equal(loadPairState(root).continuation.owner_session_id, null);

  takeoverWork(root, 'new-owner', 'codex');
  assert.equal(invoke(root, 'codex', 'owner-session'), null);
  assert.equal(invoke(root, 'codex', 'new-owner'), null, 'paused Work does not auto-continue even after takeover');
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

test('disabled Stop gate never emits continuation instructions despite evidence progress', t => {
  const root = fixture(t);
  for (let index = 0; index < 10; index++) {
    assert.equal(invoke(root, 'codex', 'owner-session'), null);
  }
  appendPairEvent(root, {
    event: 'phase.progressed', attemptId: '1.1-stop', taskId: '1.1', phase: 'verifying',
    evidence_digest: 'a'.repeat(64),
  });
  assert.equal(invoke(root, 'codex', 'owner-session'), null);
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
