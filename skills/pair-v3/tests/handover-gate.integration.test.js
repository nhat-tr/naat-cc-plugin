const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const adapter = path.resolve(__dirname, '../scripts/pair-handover-adapter');
const stopAdapter = path.resolve(__dirname, '../scripts/pair-stop-adapter');
const handover = require('../scripts/lib/handover-state');
const FRESHNESS_WINDOW_MS = 60 * 60 * 1000;
const hooksFile = path.resolve(__dirname, '../../../hooks/hooks.json');
const hookValidator = path.resolve(__dirname, '../../../scripts/ci/validate-hooks.js');
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
      coreAnchor: 'Protect registered Agent Conversations.',
      currentDirection: 'Implement the Freshness Gate.',
      nextAction: 'Run the handover integration contract.',
    },
  });
  return identity;
}

function invoke(root, runtime, input) {
  const executable = input.hook_event_name === 'Stop' ? stopAdapter : adapter;
  const result = childProcess.spawnSync(process.execPath, [executable], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PAIR_HOOK_RUNTIME: runtime },
    input: `${JSON.stringify({ cwd: root, ...input })}\n`,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

function repositorySnapshot(root) {
  const entries = [];
  function visit(directory, relative = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!relative && entry.name === '.git') continue;
      const childRelative = path.join(relative, entry.name);
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        entries.push([childRelative, 'directory']);
        visit(absolute, childRelative);
      } else if (entry.isSymbolicLink()) {
        entries.push([childRelative, `symlink:${fs.readlinkSync(absolute)}`]);
      } else {
        entries.push([childRelative, fs.readFileSync(absolute).toString('base64')]);
      }
    }
  }
  visit(root);
  return entries;
}

function registry(root) {
  return handover.readAgentConversationRegistry(root);
}

function writeJsonl(file, entries) {
  fs.writeFileSync(file, `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`);
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
  assert.equal(exact.decision, 'block');
  assert.match(exact.reason, /handover-[a-f0-9-]{36}/u);

  const above = invoke(root, 'codex', {
    hook_event_name: 'UserPromptSubmit', session_id: identity.agentConversationId,
    now: 1_000 + FRESHNESS_WINDOW_MS + 1,
  });
  assert.equal(above.decision, 'block');
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
  assert.equal(response.decision, 'block');
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
  assert.deepEqual(Object.keys(codexResponse).sort(), ['decision', 'reason']);
  assert.equal(codexResponse.decision, 'block');
  assert.match(codexResponse.reason, /--fresh-from handover-[a-f0-9-]{36} --runtime codex/u);
  assert.deepEqual(Object.keys(claudeResponse).sort(), ['decision', 'reason']);
  assert.equal(claudeResponse.decision, 'block');
  assert.match(claudeResponse.reason, /--fresh-from handover-[a-f0-9-]{36} --runtime claude/u);
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
  }).decision, 'block');
  assert.equal(invoke(root, 'codex', {
    hook_event_name: 'UserPromptSubmit', session_id: identity.agentConversationId,
    now: 2_000 + FRESHNESS_WINDOW_MS + 1,
  }).decision, 'block');
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

test('tampered warm registry checkpoint and unknown keys fail closed without another secret-bearing write', t => {
  const root = fixture(t);
  const identity = registerWarmConversation(root, 'codex', 'tampered-warm-checkpoint');
  const registryFile = handover.handoverPaths(root).registry;
  const persisted = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
  const [sourceKey] = Object.keys(persisted.conversations);
  persisted.conversations[sourceKey].checkpoint = {
    prompt: 'PROMPT_CORRUPTION_CANARY',
    token: 'gho_registry_corruption_canary',
  };
  persisted.conversations[sourceKey].transcript = 'TRANSCRIPT_CORRUPTION_CANARY';
  fs.writeFileSync(registryFile, `${JSON.stringify(persisted, null, 2)}\n`);
  const before = repositorySnapshot(root);

  const response = invoke(root, 'codex', {
    hook_event_name: 'UserPromptSubmit', session_id: identity.agentConversationId,
    now: 1_000 + FRESHNESS_WINDOW_MS,
  });

  assert.equal(response.decision, 'block');
  assert.match(response.reason, /registered handover state is invalid/iu);
  assert.deepEqual(repositorySnapshot(root), before, 'the rejected prompt must not rewrite or seal corrupted private state');
  const entries = fs.readdirSync(handover.handoverPaths(root).directory);
  assert.equal(entries.some(entry => /^handover-/u.test(entry)), false);
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
  assert.match(malformedResponse.reason, /malformed/i);
  assert.match(futureResponse.reason, /future/i);
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
  assert.equal(response.decision, 'block');
  const stored = childProcess.spawnSync('rg', ['-l', compactSummary, path.join(root, '.pair')], { encoding: 'utf8' });
  assert.equal(stored.stdout, '');
});

test('PreCompact and PostCompact cannot repair or mutate invalid handover state', t => {
  const root = fixture(t);
  const identity = registerWarmConversation(root, 'claude', 'invalid-compaction-agent');
  const registryFile = handover.handoverPaths(root).registry;
  fs.writeFileSync(registryFile, '{invalid-registry\n');
  const before = repositorySnapshot(root);

  for (const hook_event_name of ['PreCompact', 'PostCompact']) {
    assert.equal(invoke(root, 'claude', {
      hook_event_name,
      session_id: identity.agentConversationId,
      compact_summary: 'INVALID_STATE_COMPACT_SUMMARY_CANARY',
    }), null);
    assert.deepEqual(repositorySnapshot(root), before);
  }

  const prompt = invoke(root, 'claude', {
    hook_event_name: 'UserPromptSubmit', session_id: identity.agentConversationId,
  });
  assert.equal(prompt.decision, 'block');
  assert.match(prompt.reason, /state is invalid/iu);
  assert.deepEqual(repositorySnapshot(root), before);
});

test('Codex and Claude install one coordinated Stop hook while UserPromptSubmit stays separate', () => {
  const hooks = fs.readFileSync(hooksFile, 'utf8');
  const manifest = JSON.parse(hooks);
  const installerSource = fs.readFileSync(installer, 'utf8');
  assert.match(hooks, /"UserPromptSubmit"/u);
  assert.match(hooks, /hooks\/handover-gate\.sh/u);
  assert.equal(manifest.hooks.Stop.length, 1);
  assert.equal(manifest.hooks.Stop[0].hooks.length, 1);
  assert.match(manifest.hooks.Stop[0].hooks[0].command, /stop-gate\.sh/u);
  assert.doesNotMatch(manifest.hooks.Stop[0].hooks[0].command, /handover-gate\.sh/u);
  assert.match(installerSource, /function installRuntimeHooks/u);
  assert.match(installerSource, /path\.join\(ROOT_DIR, 'hooks', 'hooks\.json'\)/u);
  const coordinatedStopGate = fs.readFileSync(path.resolve(__dirname, '../../../hooks/stop-gate.sh'), 'utf8');
  assert.match(coordinatedStopGate, /^exec node /mu);
});

test('hook validation rejects a second managed Stop hook', t => {
  const root = fixture(t);
  const manifest = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
  manifest.hooks.Stop[0].hooks.push({
    type: 'command',
    command: 'PAIR_HOOK_RUNTIME=claude bash ~/.local/share/my-claude-code/hooks/handover-gate.sh',
  });
  const candidate = path.join(root, 'hooks.json');
  fs.writeFileSync(candidate, `${JSON.stringify(manifest, null, 2)}\n`);

  const result = childProcess.spawnSync(process.execPath, [hookValidator], {
    encoding: 'utf8',
    env: { ...process.env, HOOKS_FILE: candidate },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /exactly one coordinated managed Stop hook/u);
});

test('a corrupt registry blocks only conversations with a private registration marker', t => {
  const root = fixture(t);
  const registered = registerWarmConversation(root, 'codex', 'registered-corrupt');
  fs.writeFileSync(handover.handoverPaths(root).registry, '{corrupt');
  const before = repositorySnapshot(root);

  assert.equal(invoke(root, 'codex', {
    hook_event_name: 'UserPromptSubmit', session_id: 'never-registered', now: 2_000,
  }), null);
  assert.equal(invoke(root, 'codex', {
    hook_event_name: 'Stop', session_id: 'never-registered', now: 2_000,
  }), null);
  for (const hook_event_name of ['PreCompact', 'PostCompact']) {
    assert.equal(invoke(root, 'codex', {
      hook_event_name, session_id: registered.agentConversationId, now: 2_000,
      compact_summary: 'must-not-repair-corrupt-handover-state',
    }), null);
  }
  assert.deepEqual(repositorySnapshot(root), before);
  const blocked = invoke(root, 'codex', {
    hook_event_name: 'UserPromptSubmit', session_id: registered.agentConversationId, now: 2_000,
  });
  assert.equal(blocked.decision, 'block');
  assert.match(blocked.reason, /state is invalid/i);
});

test('a corrupt pre-marker registry stays inert for an unrelated Agent Conversation', t => {
  const root = fixture(t);
  registerWarmConversation(root, 'codex', 'legacy-registered-before-corruption');
  const paths = handover.handoverPaths(root);
  fs.rmSync(paths.registrations, { recursive: true, force: true });
  fs.writeFileSync(paths.registry, '{corrupt legacy registry');
  const before = repositorySnapshot(root);

  assert.equal(invoke(root, 'codex', {
    hook_event_name: 'UserPromptSubmit', session_id: 'unrelated-to-legacy-corruption', now: 2_000,
  }), null);
  assert.equal(invoke(root, 'codex', {
    hook_event_name: 'Stop', session_id: 'unrelated-to-legacy-corruption', now: 2_000,
  }), null);
  assert.deepEqual(repositorySnapshot(root), before);
});

test('a corrupt registration index stays inert when the exact marker is absent', t => {
  const root = fixture(t);
  registerWarmConversation(root, 'codex', 'indexed-conversation');
  const paths = handover.handoverPaths(root);
  fs.writeFileSync(paths.registrationIndex, '{corrupt index');
  const before = repositorySnapshot(root);

  assert.equal(invoke(root, 'codex', {
    hook_event_name: 'UserPromptSubmit', session_id: 'absent-from-corrupt-index', now: 2_000,
  }), null);
  assert.equal(invoke(root, 'codex', {
    hook_event_name: 'Stop', session_id: 'absent-from-corrupt-index', now: 2_000,
  }), null);
  assert.deepEqual(repositorySnapshot(root), before);
});

test('clean unregistered UserPromptSubmit and Stop are byte-for-byte inert', t => {
  const root = fixture(t);
  const before = repositorySnapshot(root);
  for (const hook_event_name of ['UserPromptSubmit', 'Stop']) {
    assert.equal(invoke(root, 'codex', {
      hook_event_name, session_id: 'never-registered-clean', now: 2_000,
    }), null);
  }
  assert.deepEqual(repositorySnapshot(root), before);
});

test('enabled general Agent Conversation automatically checkpoints at Stop and seals at exactly sixty minutes', t => {
  const root = fixture(t);
  const sessionId = 'automatic-general-codex';
  const transcriptPath = path.join(root, 'automatic-general.jsonl');
  fs.writeFileSync(path.join(root, 'evidence.txt'), 'verified evidence\n');
  writeJsonl(transcriptPath, [
    {
      timestamp: '2026-07-26T20:00:00.000Z',
      type: 'session_meta',
      payload: { id: sessionId, cwd: root },
    },
    {
      timestamp: '2026-07-26T20:00:01.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'Implement automatic handover for general Agent Conversations.' },
    },
    {
      timestamp: '2026-07-26T20:00:02.000Z',
      type: 'response_item',
      payload: { type: 'reasoning', summary: [{ text: 'PRIVATE_GENERAL_REASONING_CANARY' }] },
    },
    {
      timestamp: '2026-07-26T20:00:03.000Z',
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'call-1', output: 'GENERAL_TOOL_RESULT_CANARY' },
    },
    {
      timestamp: '2026-07-26T20:00:04.000Z',
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'The automatic checkpoint path is ready for an integration test.' },
    },
    {
      timestamp: '2026-07-26T20:00:05.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'The sixty-minute Freshness Gate must remain mandatory.' },
    },
  ]);
  handover.setGeneralHandoverPolicy(root, true);

  assert.equal(invoke(root, 'codex', {
    hook_event_name: 'Stop', session_id: sessionId, transcript_path: transcriptPath, now: 2_000,
  }), null);

  const afterStop = registry(root);
  const [conversation] = Object.values(afterStop.conversations);
  assert.equal(conversation.kind, 'general');
  assert.equal(conversation.status, 'warm');
  assert.equal(conversation.last_active_at, new Date(2_000).toISOString());
  assert.match(conversation.checkpoint.core_anchor, /automatic handover for general Agent Conversations/u);
  assert.match(conversation.checkpoint.core_anchor, /sixty-minute Freshness Gate must remain mandatory/u);
  assert.match(conversation.checkpoint_source_digest, /^[a-f0-9]{64}$/u);

  const blocked = invoke(root, 'codex', {
    hook_event_name: 'UserPromptSubmit', session_id: sessionId,
    now: 2_000 + FRESHNESS_WINDOW_MS,
  });
  assert.equal(blocked.decision, 'block');
  const handoverId = blocked.reason.match(/handover-[a-f0-9-]{36}/u)?.[0];
  const bundle = handover.readAgentConversationHandover(root, handoverId);
  const serialized = JSON.stringify(bundle);
  assert.equal(bundle.manifest.kind, 'general');
  assert.equal(bundle.manifest.pair_work, null);
  assert.equal(bundle.manifest.checkpoint_origin, 'recovered');
  assert.equal(bundle.manifest.checkpoint_source_digest, conversation.checkpoint_source_digest);
  assert.match(bundle.checkpoint.core_anchor, /automatic handover for general Agent Conversations/u);
  assert.doesNotMatch(serialized, /PRIVATE_GENERAL_REASONING_CANARY|GENERAL_TOOL_RESULT_CANARY/u);

  const adopted = handover.adoptAgentConversationHandover(root, {
    handoverId,
    runtime: 'codex',
    agentConversationId: 'automatic-general-codex-fresh',
    now: 2_000 + FRESHNESS_WINDOW_MS + 1,
  });
  assert.equal(adopted.status, 'adopted');
  assert.match(adopted.checkpoint.core_anchor, /sixty-minute Freshness Gate must remain mandatory/u);
});

test('enabled general handover fails visibly when Stop has no exact provider transcript', t => {
  const root = fixture(t);
  handover.setGeneralHandoverPolicy(root, true);

  const stopped = invoke(root, 'codex', {
    hook_event_name: 'Stop', session_id: 'general-without-transcript', now: 2_000,
  });

  assert.equal(stopped.continue, false);
  assert.match(stopped.stopReason, /no exact provider transcript/u);
  assert.match(stopped.stopReason, /--conversation-checkpoint/u);
  assert.deepEqual(Object.values(registry(root).conversations), []);
});

test('a partial manual general checkpoint cannot advance Stop activity when transcript recovery is unavailable', t => {
  const root = fixture(t);
  const identity = { runtime: 'codex', agentConversationId: 'partial-manual-general', kind: 'general' };
  const registered = handover.registerAgentConversation(root, { ...identity, now: 1_000 });
  handover.updateAgentConversationCheckpoint(root, {
    ...identity,
    now: 1_100,
    origin: 'manual',
    checkpoint: { coreAnchor: 'This checkpoint is intentionally incomplete.' },
  });

  const stopped = invoke(root, 'codex', {
    hook_event_name: 'Stop', session_id: identity.agentConversationId, now: 2_000,
  });

  assert.equal(stopped.continue, false);
  assert.equal(
    registry(root).conversations[registered.sourceKey].last_active_at,
    new Date(1_000).toISOString(),
  );
});

test('a complete manual general checkpoint is the safe fallback for one Stop without a provider transcript', t => {
  const root = fixture(t);
  const identity = { runtime: 'codex', agentConversationId: 'complete-manual-general', kind: 'general' };
  const registered = handover.registerAgentConversation(root, { ...identity, now: 1_000 });
  handover.updateAgentConversationCheckpoint(root, {
    ...identity,
    now: 1_100,
    origin: 'manual',
    checkpoint: {
      coreAnchor: 'Preserve the manually reviewed product intent.',
      currentDirection: 'Continue from verified repository evidence.',
      nextAction: 'Adopt this checkpoint if the conversation becomes cold.',
    },
  });

  assert.equal(invoke(root, 'codex', {
    hook_event_name: 'Stop', session_id: identity.agentConversationId, now: 2_000,
  }), null);
  assert.equal(
    registry(root).conversations[registered.sourceKey].last_active_at,
    new Date(2_000).toISOString(),
  );
  const staleManualStop = invoke(root, 'codex', {
    hook_event_name: 'Stop', session_id: identity.agentConversationId, now: 3_000,
  });
  assert.equal(staleManualStop.continue, false);
  assert.equal(
    registry(root).conversations[registered.sourceKey].last_active_at,
    new Date(2_000).toISOString(),
  );
});

test('automatic Stop recovery enriches a manually reviewed general checkpoint without replacing its anchor or choices', t => {
  const root = fixture(t);
  const sessionId = 'hybrid-general-codex';
  const identity = { runtime: 'codex', agentConversationId: sessionId, kind: 'general' };
  const transcriptPath = path.join(root, 'hybrid-general.jsonl');
  handover.registerAgentConversation(root, { ...identity, now: 1_000 });
  handover.updateAgentConversationCheckpoint(root, {
    ...identity,
    now: 1_100,
    origin: 'manual',
    checkpoint: {
      coreAnchor: 'Human-reviewed anchor: preserve the approved handover contract.',
      confirmedChoices: ['The Freshness Gate remains exactly sixty minutes.'],
      currentDirection: 'Implement the hybrid path.',
      nextAction: 'Recover subsequent progress automatically.',
    },
  });
  writeJsonl(transcriptPath, [
    { type: 'session_meta', payload: { id: sessionId, cwd: root } },
    {
      timestamp: '2026-07-26T20:00:00.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'Initial transcript wording must not replace the reviewed anchor.' },
    },
    {
      timestamp: '2026-07-26T20:00:01.000Z',
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'Automatic recovery found a subsequent implementation result.' },
    },
    {
      timestamp: '2026-07-26T20:00:02.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'Next, verify adoption from this enriched checkpoint.' },
    },
  ]);

  assert.equal(invoke(root, 'codex', {
    hook_event_name: 'Stop', session_id: sessionId, transcript_path: transcriptPath, now: 2_000,
  }), null);

  const conversation = registry(root).conversations[handover.conversationIdentity(identity).sourceKey];
  assert.equal(conversation.checkpoint_origin, 'manual-recovered');
  assert.equal(conversation.checkpoint.core_anchor, 'Human-reviewed anchor: preserve the approved handover contract.');
  assert.deepEqual(conversation.checkpoint.confirmed_choices, ['The Freshness Gate remains exactly sixty minutes.']);
  assert.match(JSON.stringify(conversation.checkpoint.findings), /subsequent implementation result/u);
  assert.match(conversation.checkpoint.next_action, /verify adoption from this enriched checkpoint/u);
});

test('brainstorming Stop fills a missing Core Anchor from the exact provider transcript', t => {
  const root = fixture(t);
  const sessionId = 'brainstorm-anchor-recovery';
  const transcriptPath = path.join(root, 'brainstorm-anchor.jsonl');
  handover.ensureBrainstormingRegistration(root, {
    runtime: 'claude', agentConversationId: sessionId, now: 1_000,
  });
  writeJsonl(transcriptPath, [
    {
      type: 'user', sessionId, timestamp: '2026-07-26T20:00:00.000Z',
      message: { role: 'user', content: 'Design handover that preserves the approved product direction.' },
    },
    {
      type: 'assistant', sessionId, timestamp: '2026-07-26T20:00:01.000Z',
      message: {
        id: 'brainstorm-answer', role: 'assistant',
        content: [{ type: 'text', text: 'The Core Anchor must survive adoption without another interview.' }],
      },
    },
  ]);

  assert.equal(invoke(root, 'claude', {
    hook_event_name: 'Stop', session_id: sessionId, transcript_path: transcriptPath, now: 2_000,
  }), null);

  const [conversation] = Object.values(registry(root).conversations);
  assert.equal(conversation.kind, 'brainstorming');
  assert.equal(conversation.checkpoint_origin, 'recovered');
  assert.match(conversation.checkpoint.core_anchor, /approved product direction/u);
  assert.match(JSON.stringify(conversation.checkpoint.findings), /Core Anchor must survive adoption/u);
});

test('brainstorming Stop refreshes volatile fields after transcript progress while preserving stable decisions', t => {
  const root = fixture(t);
  const sessionId = 'brainstorm-volatile-refresh';
  const identity = { runtime: 'codex', agentConversationId: sessionId, kind: 'brainstorming' };
  const transcriptPath = path.join(root, 'brainstorm-volatile-refresh.jsonl');
  handover.registerAgentConversation(root, { ...identity, now: 1_000 });
  handover.updateAgentConversationCheckpoint(root, {
    ...identity,
    now: 1_100,
    origin: 'manual',
    checkpoint: {
      coreAnchor: 'Deliver the approved gate and every confirmed remediation.',
      confirmedChoices: ['Use two coordinated repository Works.'],
      rejectedAlternatives: ['Do not ship a detection-only gate.'],
      currentDirection: 'Wait until ParagonAgent becomes writable.',
      unresolvedDecisions: ['ParagonAgent is not writable.'],
      nextAction: 'Make ParagonAgent writable.',
    },
  });
  writeJsonl(transcriptPath, [
    { type: 'session_meta', payload: { id: sessionId, cwd: root } },
    {
      timestamp: '2026-07-26T22:42:32.317Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'try again' },
    },
    {
      timestamp: '2026-07-26T22:43:17.015Z',
      type: 'event_msg',
      payload: {
        type: 'agent_message',
        message: 'The retry succeeded. ParagonAgent is writable, so I am now grounding the two coordinated plans.',
      },
    },
  ]);

  assert.equal(invoke(root, 'codex', {
    hook_event_name: 'Stop', session_id: sessionId, transcript_path: transcriptPath, now: 2_000,
  }), null);

  const conversation = registry(root).conversations[handover.conversationIdentity(identity).sourceKey];
  assert.equal(conversation.checkpoint_origin, 'manual-recovered');
  assert.equal(conversation.checkpoint.core_anchor, 'Deliver the approved gate and every confirmed remediation.');
  assert.deepEqual(conversation.checkpoint.confirmed_choices, ['Use two coordinated repository Works.']);
  assert.deepEqual(conversation.checkpoint.rejected_alternatives, ['Do not ship a detection-only gate.']);
  assert.match(conversation.checkpoint.current_direction, /ParagonAgent is writable/u);
  assert.match(conversation.checkpoint.next_action, /grounding the two coordinated plans/u);
  assert.deepEqual(conversation.checkpoint.unresolved_decisions, []);
});

test('exact override permits one prompt and blocks Stop until that turn refreshes its checkpoint', t => {
  const root = fixture(t);
  const identity = {
    runtime: 'codex', agentConversationId: 'override-agent', kind: 'brainstorming', now: 1_000,
  };
  handover.registerAgentConversation(root, identity);
  handover.updateAgentConversationCheckpoint(root, {
    ...identity,
    checkpoint: {
      coreAnchor: 'Preserve brainstorming state.',
      currentDirection: 'Exercise the one-shot override.',
      nextAction: 'Refresh before Stop.',
    },
  });
  const sealed = handover.sealAgentConversationHandover(root, { ...identity, now: 2_000 });
  handover.authorizeColdResume(root, {
    ...identity, now: 3_000, handoverId: sealed.handoverId, confirmCostRisk: true,
  });

  assert.equal(invoke(root, 'codex', {
    hook_event_name: 'UserPromptSubmit', session_id: identity.agentConversationId, now: 3_001,
  }), null);
  const repeated = invoke(root, 'codex', {
    hook_event_name: 'UserPromptSubmit', session_id: identity.agentConversationId, now: 3_002,
  });
  assert.equal(repeated.decision, 'block');
  assert.match(repeated.reason, /already consumed/i);

  const staleStop = invoke(root, 'codex', {
    hook_event_name: 'Stop', session_id: identity.agentConversationId, now: 3_500,
  });
  assert.equal(staleStop.continue, false);
  assert.match(staleStop.stopReason, /refresh.*Agent Conversation Checkpoint/i);
  const laterPrompt = invoke(root, 'codex', {
    hook_event_name: 'UserPromptSubmit', session_id: identity.agentConversationId, now: 4_000,
  });
  assert.equal(laterPrompt.decision, 'block');
  assert.equal(registry(root).conversations[sealed.sourceKey].status, 'sealed');
  assert.equal(registry(root).conversations[sealed.sourceKey].override.status, 'failed-no-refresh');
  const recovered = handover.adoptAgentConversationHandover(root, {
    handoverId: sealed.handoverId, runtime: 'claude', agentConversationId: 'fresh-after-failed-override', now: 4_500,
  });
  assert.equal(recovered.status, 'adopted');
});

test('SessionStart orientation eagerly seals an abandoned cold Agent Conversation before showing the projection', t => {
  const root = fixture(t);
  const identity = { runtime: 'claude', agentConversationId: 'abandoned-orient-session', kind: 'brainstorming', now: 1_000 };
  const registered = handover.registerAgentConversation(root, identity);
  handover.updateAgentConversationCheckpoint(root, {
    ...identity,
    checkpoint: {
      coreAnchor: 'Abandoned brainstorming conversation.',
      currentDirection: 'Preserve the approved brainstorming direction.',
      nextAction: 'Resume brainstorming.',
    },
  });

  const orientation = childProcess.spawnSync(process.execPath, [orient], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PAIR_NOW_MS: String(1_000 + FRESHNESS_WINDOW_MS) },
    input: `${JSON.stringify({ cwd: root, hook_event_name: 'SessionStart', session_id: 'unrelated-fresh-session' })}\n`,
  });

  assert.equal(orientation.status, 0, orientation.stderr);
  assert.match(orientation.stdout, /handover-[a-f0-9-]{36}/u);
  const sealedConversation = registry(root).conversations[registered.sourceKey];
  assert.equal(sealedConversation.status, 'sealed', 'orientation must seal the abandoned conversation eagerly, not wait for its own next prompt');
  assert.match(sealedConversation.sealed_handover_id, /^handover-[a-f0-9-]{36}$/u);
});

test('orientation scopes the banner to the current Agent Conversation and compacts unrelated ones', t => {
  const root = fixture(t);
  const current = { runtime: 'claude', agentConversationId: 'current-orient-session', kind: 'brainstorming', now: 1_000 };
  const other = { runtime: 'claude', agentConversationId: 'other-orient-session', kind: 'brainstorming', now: 1_000 };
  handover.registerAgentConversation(root, current);
  handover.updateAgentConversationCheckpoint(root, { ...current, checkpoint: { coreAnchor: 'Current conversation.', nextAction: 'Continue.' } });
  handover.registerAgentConversation(root, other);
  handover.updateAgentConversationCheckpoint(root, { ...other, checkpoint: { coreAnchor: 'Other conversation.', nextAction: 'Continue.' } });

  const orientation = childProcess.spawnSync(process.execPath, [orient], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PAIR_HOOK_RUNTIME: 'claude', PAIR_NOW_MS: '1500' },
    input: `${JSON.stringify({ cwd: root, hook_event_name: 'SessionStart', session_id: current.agentConversationId })}\n`,
  });

  assert.equal(orientation.status, 0, orientation.stderr);
  assert.match(orientation.stdout, /Freshness Gate \(this Agent Conversation\) claude\/brainstorming/u);
  assert.match(orientation.stdout, /Freshness Gate \(other\) claude\/brainstorming/u);
  const thisIndex = orientation.stdout.indexOf('Freshness Gate (this Agent Conversation)');
  const otherIndex = orientation.stdout.indexOf('Freshness Gate (other)');
  assert.ok(thisIndex < otherIndex, 'this Agent Conversation renders before the other entries');
  const otherLine = orientation.stdout.split('\n').find(line => line.includes('Freshness Gate (other)'));
  assert.match(otherLine, / \| /u, 'unrelated conversations render as one compact line');
  assert.doesNotMatch(otherLine, /next safe action:.*\n/u);
});

test('orientation reports an unregistered Agent Conversation is not gated and still compacts registered ones', t => {
  const root = fixture(t);
  const identity = registerWarmConversation(root, 'claude', 'registered-not-current');
  const orientation = childProcess.spawnSync(process.execPath, [orient], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PAIR_HOOK_RUNTIME: 'claude', PAIR_NOW_MS: '2000' },
    input: `${JSON.stringify({ cwd: root, hook_event_name: 'SessionStart', session_id: 'unregistered-current-session' })}\n`,
  });

  assert.equal(orientation.status, 0, orientation.stderr);
  assert.match(orientation.stdout, /not registered/iu);
  assert.match(orientation.stdout, /does not gate/iu);
  assert.match(orientation.stdout, /Freshness Gate \(other\) claude\/pair/u);
  assert.equal(identity.agentConversationId, 'registered-not-current');
});

test('freshness status orientation and hooks agree on the sealed Agent Conversation Handover', t => {
  const root = fixture(t);
  const identity = registerWarmConversation(root);
  const hook = invoke(root, 'codex', {
    hook_event_name: 'UserPromptSubmit', session_id: identity.agentConversationId,
    now: 1_000 + FRESHNESS_WINDOW_MS,
  });
  const handoverId = hook.reason.match(/handover-[a-f0-9-]{36}/u)[0];
  const status = childProcess.spawnSync(process.execPath, [pairTask, '--freshness-status'], { cwd: root, encoding: 'utf8' });
  const orientation = childProcess.spawnSync(process.execPath, [orient], {
    cwd: root, encoding: 'utf8', input: `${JSON.stringify({ cwd: root })}\n`,
  });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(orientation.status, 0, orientation.stderr);
  for (const output of [hook.reason, status.stdout, orientation.stdout]) {
    assert.match(output, new RegExp(handoverId));
    assert.match(output, /--fresh-from/iu);
    assert.match(output, /--adopt-handover/iu);
  }
});

test('freshness status exposes warm age deadline checkpoint digest and next safe action', t => {
  const root = fixture(t);
  registerWarmConversation(root, 'codex', 'visible-warm-agent', 1_000);
  const status = childProcess.spawnSync(process.execPath, [pairTask, '--freshness-status'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, PAIR_NOW_MS: String(1_000 + 30 * 60 * 1000) },
  });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /codex\/pair.*warm/iu);
  assert.match(status.stdout, /age/iu);
  assert.match(status.stdout, /deadline/iu);
  assert.match(status.stdout, /checkpoint.*r1/iu);
  assert.match(status.stdout, /sha256/iu);
  assert.match(status.stdout, /next safe action/iu);
});
