const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const adapter = path.resolve(__dirname, '../scripts/pair-handover-adapter');
const handover = require('../scripts/lib/handover-state');
const FRESHNESS_WINDOW_MS = 60 * 60 * 1000;
const hooksFile = path.resolve(__dirname, '../../../hooks/hooks.json');
const installer = path.resolve(__dirname, '../../../scripts/install-runtime.js');
const pairTask = path.resolve(__dirname, '../scripts/pair-task');
const orient = path.resolve(__dirname, '../scripts/pair-orient');

function fixture(t) {
  const scratchBase = process.env.CLAUDE_SCRATCH_DIR || path.join(os.homedir(), '.claude-scratch');
  const root = fs.mkdtempSync(path.join(scratchBase, 'my-claude-code-handover-gate-'));
  childProcess.spawnSync('git', ['init', '-q'], { cwd: root });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function registerWarmConversation(root, runtime = 'codex', agentConversationId = 'registered-agent', now = 1_000) {
  const identity = { runtime, agentConversationId, kind: 'pair', now };
  handover.registerAgentConversation(root, identity);
  handover.updateAgentConversationCheckpoint(root, {
    ...identity,
    checkpoint: {
      purpose: 'Protect registered Agent Conversations.',
      currentDirection: 'Implement the Freshness Gate.',
      nextAction: 'Run the handover integration contract.',
    },
  });
  return identity;
}

function invoke(root, runtime, input) {
  const result = childProcess.spawnSync(process.execPath, [adapter], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PAIR_HOOK_RUNTIME: runtime },
    input: `${JSON.stringify({ cwd: root, ...input })}\n`,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

function registry(root) {
  return handover.readAgentConversationRegistry(root);
}

test('below exact and above sixty-minute boundary preserves warm continuation then blocks stale continuation', t => {
  const root = fixture(t);
  const identity = registerWarmConversation(root);
  const below = invoke(root, 'codex', {
    hook_event_name: 'UserPromptSubmit', session_id: identity.agentConversationId,
    now: 1_000 + FRESHNESS_WINDOW_MS - 1,
  });
  assert.equal(below, null);

  const exact = invoke(root, 'codex', {
    hook_event_name: 'UserPromptSubmit', session_id: identity.agentConversationId,
    now: 1_000 + FRESHNESS_WINDOW_MS,
  });
  assert.equal(exact.continue, false);
  assert.match(exact.stopReason, /handover-[a-f0-9-]{36}/u);

  const above = invoke(root, 'codex', {
    hook_event_name: 'UserPromptSubmit', session_id: identity.agentConversationId,
    now: 1_000 + FRESHNESS_WINDOW_MS + 1,
  });
  assert.equal(above.continue, false);
});

test('blocks before model launch for a stale registered Agent Conversation', t => {
  const root = fixture(t);
  const identity = registerWarmConversation(root);
  const marker = path.join(root, 'provider-started');
  const response = invoke(root, 'codex', {
    hook_event_name: 'UserPromptSubmit', session_id: identity.agentConversationId,
    now: 1_000 + FRESHNESS_WINDOW_MS,
    prompt: `Do not run a provider; marker=${marker}`,
  });
  assert.equal(response.continue, false);
  assert.equal(fs.existsSync(marker), false);
});

test('native Codex and Claude stale responses use their exact blocking shapes', t => {
  const root = fixture(t);
  const codex = registerWarmConversation(root, 'codex', 'codex-agent');
  const claude = registerWarmConversation(root, 'claude', 'claude-agent');
  const codexResponse = invoke(root, 'codex', {
    hook_event_name: 'UserPromptSubmit', session_id: codex.agentConversationId,
    now: 1_000 + FRESHNESS_WINDOW_MS,
  });
  const claudeResponse = invoke(root, 'claude', {
    hook_event_name: 'UserPromptSubmit', session_id: claude.agentConversationId,
    now: 1_000 + FRESHNESS_WINDOW_MS,
  });
  assert.deepEqual(Object.keys(codexResponse).sort(), ['continue', 'stopReason']);
  assert.equal(codexResponse.continue, false);
  assert.deepEqual(Object.keys(claudeResponse).sort(), ['decision', 'reason']);
  assert.equal(claudeResponse.decision, 'block');
});

test('seals one handover on the first stale prompt and records registered Stop activity', t => {
  const root = fixture(t);
  const identity = registerWarmConversation(root);
  assert.equal(invoke(root, 'codex', {
    hook_event_name: 'Stop', session_id: identity.agentConversationId, now: 2_000,
  }), null);
  assert.equal(invoke(root, 'codex', {
    hook_event_name: 'UserPromptSubmit', session_id: identity.agentConversationId,
    now: 2_000 + FRESHNESS_WINDOW_MS,
  }).continue, false);
  assert.equal(invoke(root, 'codex', {
    hook_event_name: 'UserPromptSubmit', session_id: identity.agentConversationId,
    now: 2_000 + FRESHNESS_WINDOW_MS + 1,
  }).continue, false);
  assert.equal(Object.keys(registry(root).handovers).length, 1);
});

test('submitted prompt is never persisted', t => {
  const root = fixture(t);
  const identity = registerWarmConversation(root);
  const prompt = 'submitted-prompt-must-never-reach-handover-storage';
  invoke(root, 'codex', {
    hook_event_name: 'UserPromptSubmit', session_id: identity.agentConversationId,
    now: 1_000 + FRESHNESS_WINDOW_MS, prompt,
  });
  const stored = childProcess.spawnSync('rg', ['-l', prompt, path.join(root, '.pair')], { encoding: 'utf8' });
  assert.equal(stored.stdout, '');
});

test('malformed and future activity time fail closed without creating a handover', t => {
  const root = fixture(t);
  const malformed = registerWarmConversation(root, 'codex', 'malformed-agent');
  const future = registerWarmConversation(root, 'codex', 'future-agent');
  const registryFile = handover.handoverPaths(root).registry;
  const persisted = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
  persisted.conversations[handover.registerAgentConversation(root, malformed).sourceKey].last_active_at = 'not-a-time';
  persisted.conversations[handover.registerAgentConversation(root, future).sourceKey].last_active_at = new Date(9_999_999).toISOString();
  fs.writeFileSync(registryFile, `${JSON.stringify(persisted, null, 2)}\n`);

  const malformedResponse = invoke(root, 'codex', {
    hook_event_name: 'UserPromptSubmit', session_id: malformed.agentConversationId, now: 2_000,
  });
  const futureResponse = invoke(root, 'codex', {
    hook_event_name: 'UserPromptSubmit', session_id: future.agentConversationId, now: 2_000,
  });
  assert.match(malformedResponse.stopReason, /malformed/i);
  assert.match(futureResponse.stopReason, /future/i);
  assert.equal(Object.keys(registry(root).handovers).length, 0);
});

test('PreCompact and PostCompact cannot bypass freshness and compact summary is never persisted', t => {
  const root = fixture(t);
  const identity = registerWarmConversation(root);
  const compactSummary = 'provider-compact-summary-must-not-be-persisted';
  for (const hook_event_name of ['PreCompact', 'PostCompact']) {
    assert.equal(invoke(root, 'codex', {
      hook_event_name, session_id: identity.agentConversationId,
      now: 1_000 + FRESHNESS_WINDOW_MS + 1,
      compact_summary: compactSummary,
    }), null);
  }
  const response = invoke(root, 'codex', {
    hook_event_name: 'UserPromptSubmit', session_id: identity.agentConversationId,
    now: 1_000 + FRESHNESS_WINDOW_MS + 1,
  });
  assert.equal(response.continue, false);
  const stored = childProcess.spawnSync('rg', ['-l', compactSummary, path.join(root, '.pair')], { encoding: 'utf8' });
  assert.equal(stored.stdout, '');
});

test('Codex and Claude runtime hook installation uses the UserPromptSubmit Freshness Gate without reviving stop-gate', () => {
  const hooks = fs.readFileSync(hooksFile, 'utf8');
  const installerSource = fs.readFileSync(installer, 'utf8');
  assert.match(hooks, /"UserPromptSubmit"/u);
  assert.match(hooks, /hooks\/handover-gate\.sh/u);
  assert.match(hooks, /hooks\/stop-gate\.sh/u);
  assert.match(installerSource, /hooks\/handover-gate\.sh/u);
  const disabledStopGate = fs.readFileSync(path.resolve(__dirname, '../../../hooks/stop-gate.sh'), 'utf8');
  assert.doesNotMatch(disabledStopGate, /^exec node /mu);
});

test('status orientation doctor and hooks agree on the sealed Agent Conversation Handover', t => {
  const root = fixture(t);
  const identity = registerWarmConversation(root);
  const hook = invoke(root, 'codex', {
    hook_event_name: 'UserPromptSubmit', session_id: identity.agentConversationId,
    now: 1_000 + FRESHNESS_WINDOW_MS,
  });
  const handoverId = hook.stopReason.match(/handover-[a-f0-9-]{36}/u)[0];
  const status = childProcess.spawnSync(process.execPath, [pairTask, '--status', '--json'], {
    cwd: root, encoding: 'utf8',
  });
  const orientation = childProcess.spawnSync(process.execPath, [orient], {
    cwd: root, encoding: 'utf8', input: `${JSON.stringify({ cwd: root })}\n`,
  });
  const doctor = childProcess.spawnSync(process.execPath, [pairTask, '--doctor'], {
    cwd: root, encoding: 'utf8',
  });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(orientation.status, 0, orientation.stderr);
  assert.match(JSON.stringify(JSON.parse(status.stdout)), new RegExp(handoverId));
  assert.match(orientation.stdout, new RegExp(handoverId));
  assert.match(doctor.stdout, new RegExp(handoverId));
});
