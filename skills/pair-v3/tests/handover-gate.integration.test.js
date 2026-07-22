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
const pairApi = require('../scripts/pair-task');
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

test('Pair registers the native coordinator identity independently of worker runtime routing', t => {
  for (const [nativeRuntime, workerRuntime] of [['claude', 'codex'], ['codex', 'claude']]) {
    const root = fixture(t);
    fs.writeFileSync(path.join(root, 'base.txt'), 'base\n');
    childProcess.spawnSync('git', ['add', 'base.txt'], { cwd: root });
    childProcess.spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'base'], { cwd: root });
    fs.writeFileSync(path.join(root, '.claude-loop.md'), [
      '# Goal: native identity',
      '## Acceptance Criteria',
      '- [ ] native hook identity remains registered',
      '## Tasks',
      '- [ ] record native coordinator identity - files: `identity.txt`',
    ].join('\n'));
    const bin = path.join(root, 'fake-runtime-bin');
    fs.mkdirSync(bin);
    for (const runtime of ['codex', 'claude']) {
      fs.writeFileSync(path.join(bin, runtime), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    }
    const env = {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
      CODEX_THREAD_ID: '',
      CODEX_SANDBOX: '',
      CLAUDECODE: '',
      CLAUDE_CODE_SESSION_ID: '',
      CLAUDE_SESSION_ID: '',
      CLAUDE_SESSION_ID_OVERRIDE: '',
      PAIR_REVIEW_TRANSPORT: 'direct',
    };
    const sessionId = `${nativeRuntime}-coordinator-with-${workerRuntime}-worker`;
    if (nativeRuntime === 'codex') env.CODEX_THREAD_ID = sessionId;
    else env.CLAUDE_CODE_SESSION_ID = sessionId;
    const started = childProcess.spawnSync(process.execPath, [pairTask, '--runtime', workerRuntime, '--once', '--inline'], {
      cwd: root, encoding: 'utf8', env,
    });
    assert.equal(started.status, 0, started.stdout + started.stderr);

    const before = registry(root);
    const conversations = Object.values(before.conversations);
    assert.equal(conversations.length, 1);
    assert.equal(conversations[0].runtime, nativeRuntime);
    assert.equal(conversations[0].kind, 'pair');
    const sourceKey = Object.keys(before.conversations)[0];
    const stoppedAt = Date.now() + 10_000;
    invoke(root, nativeRuntime, {
      hook_event_name: 'Stop', session_id: sessionId, now: stoppedAt,
    });
    const after = registry(root);
    assert.deepEqual(Object.keys(after.conversations), [sourceKey]);
    assert.equal(after.conversations[sourceKey].last_active_at, new Date(stoppedAt).toISOString());
    assert.equal(invoke(root, nativeRuntime, {
      hook_event_name: 'UserPromptSubmit', session_id: sessionId, now: stoppedAt + 1,
    }), null);
    const stale = invoke(root, nativeRuntime, {
      hook_event_name: 'UserPromptSubmit', session_id: sessionId,
      now: stoppedAt + FRESHNESS_WINDOW_MS,
    });
    assert.equal(stale.decision, 'block');
    const handoverId = stale.reason.match(/handover-[a-f0-9-]{36}/u)?.[0];
    const bundle = handover.readAgentConversationHandover(root, handoverId);
    assert.equal(bundle.manifest.pair_work.work_id, null);
    assert.equal(bundle.manifest.pair_work.projection_path, '.pair/state.json');
    const adopted = handover.adoptAgentConversationHandover(root, {
      handoverId,
      runtime: nativeRuntime,
      agentConversationId: `${sessionId}-fresh`,
      now: stoppedAt + FRESHNESS_WINDOW_MS + 1,
    });
    assert.equal(adopted.status, 'adopted');
  }
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
  assert.match(installerSource, /hooks\/handover-gate\.sh/u);
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

test('exact override permits one prompt and blocks Stop until that turn refreshes its checkpoint', t => {
  const root = fixture(t);
  const identity = {
    runtime: 'codex', agentConversationId: 'override-agent', kind: 'brainstorming', now: 1_000,
  };
  handover.registerAgentConversation(root, identity);
  handover.updateAgentConversationCheckpoint(root, {
    ...identity,
    checkpoint: {
      purpose: 'Preserve brainstorming state.',
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

test('status orientation doctor and hooks agree on the sealed Agent Conversation Handover', t => {
  const root = fixture(t);
  const identity = registerWarmConversation(root);
  const hook = invoke(root, 'codex', {
    hook_event_name: 'UserPromptSubmit', session_id: identity.agentConversationId,
    now: 1_000 + FRESHNESS_WINDOW_MS,
  });
  const handoverId = hook.reason.match(/handover-[a-f0-9-]{36}/u)[0];
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
  for (const output of [hook.reason, JSON.stringify(JSON.parse(status.stdout)), orientation.stdout]) {
    assert.match(output, new RegExp(handoverId));
    assert.match(output, /plain terminal outside any agent conversation/iu);
    assert.match(output, /--fresh-from/iu);
    assert.match(output, /--adopt-handover/iu);
  }
  assert.match(doctor.stdout, new RegExp(handoverId));
});

test('doctor treats unavailable Freshness Gate state as failure and healthy cold state as warning', t => {
  const root = fixture(t);
  registerWarmConversation(root, 'codex', 'doctor-severity-agent');
  const healthyCold = handover.freshnessProjection(root, 1_000 + FRESHNESS_WINDOW_MS);
  assert.equal(healthyCold.unavailable, undefined);
  assert.equal(pairApi.freshnessDoctorLevel(healthyCold), 'warn');

  const registryFile = handover.handoverPaths(root).registry;
  fs.writeFileSync(registryFile, '{not-json\n');
  const unavailable = handover.freshnessProjection(root, 1_000 + FRESHNESS_WINDOW_MS);
  assert.equal(unavailable.unavailable, true);
  assert.equal(pairApi.freshnessDoctorLevel(unavailable), 'fail');
});

test('human and compact status expose warm age deadline checkpoint digest and next safe action', t => {
  const root = fixture(t);
  registerWarmConversation(root, 'codex', 'visible-warm-agent', 1_000);
  const human = childProcess.spawnSync(process.execPath, [pairTask, '--status'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, PAIR_NOW_MS: String(1_000 + 30 * 60 * 1000) },
  });
  const compact = childProcess.spawnSync(process.execPath, [pairTask, '--freshness-status'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, PAIR_NOW_MS: String(1_000 + 30 * 60 * 1000) },
  });
  assert.equal(human.status, 0, human.stderr);
  assert.equal(compact.status, 0, compact.stderr);
  for (const output of [human.stdout, compact.stdout]) {
    assert.match(output, /codex\/pair.*warm/iu);
    assert.match(output, /age/iu);
    assert.match(output, /deadline/iu);
    assert.match(output, /checkpoint.*r1/iu);
    assert.match(output, /sha256/iu);
    assert.match(output, /next safe action/iu);
  }
});

test('doctor hook inspection rejects missing and broken installs and accepts one coordinated contract', t => {
  const root = fixture(t);
  const config = path.join(root, 'runtime-config');
  const codexHome = path.join(config, 'codex');
  const claudeHome = path.join(config, 'claude');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(claudeHome, { recursive: true });
  const env = { ...process.env, CODEX_HOME: codexHome, CLAUDE_HOME: claudeHome };

  for (const runtime of ['codex', 'claude']) {
    const missing = pairApi.inspectInstalledHookContract(runtime, { root, env });
    assert.equal(missing.ok, false);
    assert.match(missing.detail, /missing/iu);
  }

  const repositoryRoot = path.resolve(__dirname, '../../..');
  const canonicalClaude = fs.readFileSync(hooksFile, 'utf8')
    .replaceAll('~/.local/share/my-claude-code', repositoryRoot);
  const canonicalCodex = canonicalClaude.replaceAll('PAIR_HOOK_RUNTIME=claude', 'PAIR_HOOK_RUNTIME=codex');
  const codexHooks = path.join(codexHome, 'hooks.json');
  const claudeSettings = path.join(claudeHome, 'settings.json');
  fs.writeFileSync(codexHooks, canonicalCodex);
  fs.writeFileSync(claudeSettings, canonicalClaude);
  for (const runtime of ['codex', 'claude']) {
    const installed = pairApi.inspectInstalledHookContract(runtime, { root, env });
    assert.equal(installed.ok, true, installed.detail);
    assert.match(installed.detail, /coordinated/iu);
  }

  const noisyHookDirectory = path.join(root, 'my-claude-code', 'hooks');
  fs.mkdirSync(noisyHookDirectory, { recursive: true });
  const noisyStop = path.join(noisyHookDirectory, 'stop-gate.sh');
  fs.writeFileSync(noisyStop, '#!/bin/sh\nprintf \'{"continue":false,"stopReason":"probe failure"}\\n\'\n', { mode: 0o755 });
  const noisy = JSON.parse(canonicalCodex);
  noisy.hooks.Stop[0].hooks[0].command = `PAIR_HOOK_RUNTIME=codex bash ${JSON.stringify(noisyStop)}`;
  fs.writeFileSync(codexHooks, JSON.stringify(noisy));
  const noisyProbe = pairApi.inspectInstalledHookContract('codex', { root, env });
  assert.equal(noisyProbe.ok, false);
  assert.match(noisyProbe.detail, /probe.*output|broken/iu);

  fs.writeFileSync(codexHooks, canonicalClaude);
  const wrongRuntime = pairApi.inspectInstalledHookContract('codex', { root, env });
  assert.equal(wrongRuntime.ok, false);
  assert.match(wrongRuntime.detail, /runtime.*codex|codex.*runtime/iu);

  const broken = JSON.parse(canonicalCodex);
  broken.hooks.Stop[0].hooks[0].command = 'PAIR_HOOK_RUNTIME=codex bash /missing/my-claude-code/hooks/stop-gate.sh';
  fs.writeFileSync(codexHooks, JSON.stringify(broken));
  const rejected = pairApi.inspectInstalledHookContract('codex', { root, env });
  assert.equal(rejected.ok, false);
  assert.match(rejected.detail, /broken/iu);
});
