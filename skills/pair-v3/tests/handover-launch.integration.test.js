const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const task = require('../scripts/pair-task');
const handover = require('../scripts/lib/handover-state');
const { blockReason } = require('../scripts/pair-handover-adapter');
const { appendPairEvent, loadPairState, readPairEvents } = require('../scripts/lib/pair-state');
const { takeoverWork } = require('../scripts/lib/pair-control');

function fixture(t) {
  const scratchBase = process.env.CLAUDE_SCRATCH_DIR || path.join(os.homedir(), '.claude-scratch');
  const root = fs.mkdtempSync(path.join(scratchBase, 'my-claude-code-handover-launch-'));
  childProcess.spawnSync('git', ['init', '-q'], { cwd: root });
  fs.mkdirSync(path.join(root, '.pair'), { recursive: true });
  appendPairEvent(root, { event: 'work.opened', workId: 'work-handover-launch', planDigest: 'a'.repeat(64) });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function sealedHandover(root, runtime = 'codex') {
  const source = { runtime, agentConversationId: `${runtime}-source`, kind: 'pair', now: 1_000 };
  handover.registerAgentConversation(root, source);
  handover.updateAgentConversationCheckpoint(root, {
    ...source,
    checkpoint: handover.derivePairCheckpoint(root),
  });
  return { source, sealed: handover.sealAgentConversationHandover(root, { ...source, now: 2_000 }) };
}

function fakeRuntime(root, runtime, exitCode = 0) {
  const bin = path.join(root, 'fake-bin');
  fs.mkdirSync(bin, { recursive: true });
  const executable = path.join(bin, runtime);
  fs.writeFileSync(executable, [
    '#!/bin/sh',
    `printf 'FRESH_PROVIDER_CANARY:${runtime}\\n'`,
    'printf \'FRESH_STOP_GATE:%s/%s\\n\' "${PAIR_STOP_GATE-unset}" "${CLAUDE_STOP_GATE-unset}"',
    'printf "%s\\n" "$@" > "$PAIR_TEST_ARGS"',
    `exit ${exitCode}`,
  ].join('\n'), { mode: 0o755 });
  return bin;
}

function freshRuntimeEnv(bin, extra = {}) {
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH || ''}` };
  for (const key of task.NESTED_SESSION_ENV_KEYS) delete env[key];
  Object.assign(env, extra);
  return env;
}

test('plain provider-affine fresh launch is visible, synchronous, and uses no resume or fork argv', t => {
  const root = fixture(t);
  const { sealed } = sealedHandover(root, 'codex');
  const bin = fakeRuntime(root, 'codex');
  const argsFile = path.join(root, 'fresh-args.txt');
  const launched = childProcess.spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/pair-task'), '--fresh-from', sealed.handoverId, '--runtime', 'auto'], {
    cwd: root,
    encoding: 'utf8',
    env: freshRuntimeEnv(bin, { PAIR_TEST_ARGS: argsFile }),
  });
  assert.equal(launched.status, 0, launched.stderr);
  assert.match(launched.stdout, /FRESH_PROVIDER_CANARY:codex/u);
  assert.match(launched.stdout, /FRESH_STOP_GATE:unset\/unset/u);
  const args = fs.readFileSync(argsFile, 'utf8');
  assert.doesNotMatch(args, /--(?:resume|continue|fork(?:-session)?)(?:=|\b)/iu);
  assert.match(args, new RegExp(sealed.handoverId));
  assert.match(args, /prints the recovered bounded Agent Conversation Checkpoint/iu);
  assert.match(args, /continue directly from its findings/iu);
  assert.match(args, /without requesting the old transcript/iu);
});

test('explicit cross-provider launch requires an explicit runtime choice', t => {
  const root = fixture(t);
  const { sealed } = sealedHandover(root, 'codex');
  const spawned = [];
  const result = task.launchFreshAgentConversation(root, {
    handoverId: sealed.handoverId, runtime: 'claude', available: ['codex', 'claude'],
  }, {
    spawnSync(command, args) { spawned.push({ command, args }); return { status: 0, pid: 43 }; },
    nested: false,
  });
  assert.equal(result.runtime, 'claude');
  assert.equal(spawned[0].command, 'claude');
});

test('fresh launch reports nonzero and missing provider failures without claiming success', t => {
  const root = fixture(t);
  const { sealed } = sealedHandover(root, 'codex');
  const bin = fakeRuntime(root, 'codex', 17);
  const failed = childProcess.spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/pair-task'), '--fresh-from', sealed.handoverId, '--runtime', 'codex'], {
    cwd: root,
    encoding: 'utf8',
    env: freshRuntimeEnv(bin, { PAIR_TEST_ARGS: path.join(root, 'failed-args.txt') }),
  });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /exited 17/u);
  assert.doesNotMatch(failed.stdout, /pair-loop: launched/u);

  assert.throws(() => task.launchFreshAgentConversation(root, {
    handoverId: sealed.handoverId, runtime: 'codex', available: ['codex'],
  }, {
    nested: false,
    spawnSync() {
      const error = new Error('spawn codex ENOENT');
      error.code = 'ENOENT';
      return { error, status: null };
    },
  }), /spawn error.*ENOENT/iu);
});

test('manual adoption fallback atomically transfers ownership and cannot cross-adopt', t => {
  const root = fixture(t);
  const { sealed } = sealedHandover(root, 'claude');
  const adopted = task.adoptFreshAgentConversation(root, {
    handoverId: sealed.handoverId, runtime: 'claude', agentConversationId: 'fresh-claude', now: 3_000,
  });
  assert.equal(adopted.status, 'adopted');
  assert.equal(loadPairState(root).continuation.owner_session_id, 'fresh-claude');
  assert.equal(loadPairState(root).continuation.owner_runtime, 'claude');
  assert.equal(handover.readAgentConversationRegistry(root).conversations[adopted.sourceKey].status, 'retired');
  assert.throws(() => task.adoptFreshAgentConversation(root, {
    handoverId: sealed.handoverId, runtime: 'codex', agentConversationId: 'cross-runtime-fresh', now: 4_000,
  }), /adopted|invalid handover/i);
});

test('failed Pair ownership transfer preserves a retryable sealed handover', t => {
  const root = fixture(t);
  const { sealed } = sealedHandover(root, 'codex');
  assert.throws(() => task.adoptFreshAgentConversation(root, {
    handoverId: sealed.handoverId, runtime: 'codex', agentConversationId: 'retry-adopter', now: 3_000,
  }, {
    takeoverWork() { throw new Error('simulated Pair ownership failure'); },
  }), /simulated Pair ownership failure/u);
  const failed = handover.readAgentConversationRegistry(root);
  assert.equal(failed.conversations[sealed.sourceKey].status, 'sealed');
  assert.notEqual(failed.handovers[sealed.handoverId].status, 'adopted');

  const retried = task.adoptFreshAgentConversation(root, {
    handoverId: sealed.handoverId, runtime: 'codex', agentConversationId: 'retry-adopter', now: 4_000,
  });
  assert.equal(retried.status, 'adopted');
  assert.equal(loadPairState(root).continuation.owner_session_id, 'retry-adopter');
});

test('adoption retry revalidates Pair Work until the expected ownership event exists', t => {
  const root = fixture(t);
  const { sealed } = sealedHandover(root, 'codex');
  assert.throws(() => task.adoptFreshAgentConversation(root, {
    handoverId: sealed.handoverId, runtime: 'codex', agentConversationId: 'stale-retry-adopter', now: 3_000,
  }, {
    takeoverWork() { throw new Error('simulated failure before Pair ownership append'); },
  }), /before Pair ownership append/u);
  appendPairEvent(root, {
    event: 'phase.progressed', workId: 'work-handover-launch',
    phase: 'verifying', taskId: '1.1', attemptId: '1.1-stale-retry',
  });

  assert.throws(() => task.adoptFreshAgentConversation(root, {
    handoverId: sealed.handoverId, runtime: 'codex', agentConversationId: 'stale-retry-adopter', now: 4_000,
  }), /invalid handover/i);
  assert.equal(handover.readAgentConversationRegistry(root).handovers[sealed.handoverId].status, 'adopting');
});

test('adoption cannot transfer a sealed handover across a changed current Pair Work', t => {
  const root = fixture(t);
  const { sealed } = sealedHandover(root, 'codex');
  appendPairEvent(root, { event: 'work.opened', workId: 'work-that-replaced-the-sealed-work', phase: 'ready' });

  let spawned = false;
  assert.throws(() => task.launchFreshAgentConversation(root, {
    handoverId: sealed.handoverId, runtime: 'codex', available: ['codex'],
  }, {
    nested: false,
    spawnSync() { spawned = true; return { status: 0 }; },
  }), /invalid handover/i);
  assert.equal(spawned, false);
  assert.throws(() => task.adoptFreshAgentConversation(root, {
    handoverId: sealed.handoverId, runtime: 'codex', agentConversationId: 'cross-wired-adopter', now: 3_000,
  }), /Pair Work changed|invalid handover/i);
  assert.equal(loadPairState(root).work_id, 'work-that-replaced-the-sealed-work');
  assert.equal(loadPairState(root).continuation.owner_session_id, null);
  assert.equal(handover.readAgentConversationRegistry(root).handovers[sealed.handoverId].status, 'sealed');
});

test('adoption transfer race claims only the sealed Work and never finalizes against its replacement', t => {
  const root = fixture(t);
  const { sealed } = sealedHandover(root, 'codex');

  assert.throws(() => task.adoptFreshAgentConversation(root, {
    handoverId: sealed.handoverId, runtime: 'codex', agentConversationId: 'work-race-adopter', now: 3_000,
  }, {
    takeoverWork(repository, sessionId, runtime, options) {
      takeoverWork(repository, sessionId, runtime, options);
      appendPairEvent(repository, {
        event: 'work.opened', workId: 'work-opened-during-adoption', phase: 'ready',
      });
    },
  }), /Pair Work changed before Agent Conversation Handover adoption/i);

  assert.equal(loadPairState(root, 'work-handover-launch').continuation.owner_session_id, 'work-race-adopter');
  assert.equal(loadPairState(root).work_id, 'work-opened-during-adoption');
  assert.equal(loadPairState(root).continuation.owner_session_id, null);
  const registry = handover.readAgentConversationRegistry(root);
  assert.equal(registry.handovers[sealed.handoverId].status, 'adopting');
  assert.equal(Object.values(registry.conversations).some(value => value.adopted_handover_id === sealed.handoverId), false);
});

test('adoption recovers after Pair ownership append without duplicating the claim', t => {
  const root = fixture(t);
  const { sealed } = sealedHandover(root, 'codex');
  assert.throws(() => task.adoptFreshAgentConversation(root, {
    handoverId: sealed.handoverId, runtime: 'codex', agentConversationId: 'append-then-fail', now: 3_000,
  }, {
    takeoverWork(repository, sessionId, runtime) {
      takeoverWork(repository, sessionId, runtime);
      throw new Error('simulated failure after Pair ownership append');
    },
  }), /after Pair ownership append/u);
  const prepared = handover.readAgentConversationRegistry(root);
  assert.equal(prepared.handovers[sealed.handoverId].status, 'adopting');
  assert.equal(prepared.conversations[sealed.sourceKey].status, 'sealed');
  assert.equal(loadPairState(root).continuation.owner_session_id, 'append-then-fail');
  assert.throws(() => task.adoptFreshAgentConversation(root, {
    handoverId: sealed.handoverId, runtime: 'codex', agentConversationId: 'different-adopter', now: 3_500,
  }), /already claimed|invalid handover/i);

  const bin = fakeRuntime(root, 'codex');
  const retried = childProcess.spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/pair-task'), '--adopt-handover', sealed.handoverId, '--runtime', 'codex'], {
    cwd: root,
    encoding: 'utf8',
    env: freshRuntimeEnv(bin, { CODEX_THREAD_ID: 'append-then-fail' }),
  });
  assert.equal(retried.status, 0, retried.stderr);
  const completed = handover.readAgentConversationRegistry(root);
  assert.equal(completed.handovers[sealed.handoverId].status, 'adopted');
  assert.equal(completed.conversations[sealed.sourceKey].status, 'retired');
  assert.equal(readPairEvents(root).filter(event => event.event === 'continuation.claimed' && event.session_id === 'append-then-fail').length, 1);
});

test('auto adoption retry recovers an already adopted handover for the same native conversation', t => {
  const root = fixture(t);
  const { sealed } = sealedHandover(root, 'codex');
  task.adoptFreshAgentConversation(root, {
    handoverId: sealed.handoverId, runtime: 'codex', agentConversationId: 'same-auto-adopter', now: 3_000,
  });
  const bin = fakeRuntime(root, 'codex');

  const retried = childProcess.spawnSync(process.execPath, [
    path.resolve(__dirname, '../scripts/pair-task'),
    '--adopt-handover', sealed.handoverId,
    '--runtime', 'auto',
  ], {
    cwd: root,
    encoding: 'utf8',
    env: freshRuntimeEnv(bin, { CODEX_THREAD_ID: 'same-auto-adopter' }),
  });

  assert.equal(retried.status, 0, retried.stderr);
  assert.match(retried.stdout, /adopted Agent Conversation Handover/u);
  assert.equal(handover.readAgentConversationRegistry(root).handovers[sealed.handoverId].status, 'adopted');
});

test('concurrent same-adopter retries reconcile exactly one adopted audit event', async t => {
  const root = fixture(t);
  const { sealed } = sealedHandover(root, 'codex');
  const adopter = {
    handoverId: sealed.handoverId, runtime: 'codex', agentConversationId: 'concurrent-same-adopter', now: 3_000,
  };
  task.adoptFreshAgentConversation(root, adopter);
  const eventsFile = path.join(handover.handoverPaths(root).directory, sealed.handoverId, 'events.jsonl');
  const sealedLine = fs.readFileSync(eventsFile, 'utf8').split('\n')[0];
  fs.writeFileSync(eventsFile, `${sealedLine}\n`);

  const retries = await Promise.all([1, 2].map(index => new Promise((resolve, reject) => {
    setImmediate(() => {
      try {
        resolve(task.adoptFreshAgentConversation(root, { ...adopter, now: 3_000 + index }));
      } catch (error) {
        reject(error);
      }
    });
  })));

  assert.deepEqual(retries.map(result => result.status), ['adopted', 'adopted']);
  const events = fs.readFileSync(eventsFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(event => event.event === 'handover.adopted').length, 1);
  assert.doesNotThrow(() => handover.readAgentConversationHandoverForAdoption(root, sealed.handoverId, adopter));
});

test('Claude adoption uses CLAUDE_CODE_SESSION_ID and transfers Pair ownership in the same command', t => {
  const root = fixture(t);
  const { sealed } = sealedHandover(root, 'claude');
  const bin = fakeRuntime(root, 'claude');
  const env = freshRuntimeEnv(bin, { CLAUDE_CODE_SESSION_ID: 'documented-claude-session' });
  const adopted = childProcess.spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/pair-task'), '--adopt-handover', sealed.handoverId, '--runtime', 'claude'], {
    cwd: root, encoding: 'utf8', env,
  });
  assert.equal(adopted.status, 0, adopted.stderr);
  assert.equal(loadPairState(root).continuation.owner_session_id, 'documented-claude-session');
});

test('brainstorming CLI adoption prints the recovered bounded checkpoint without secret or transcript fields', t => {
  const root = fixture(t);
  const source = {
    runtime: 'claude', agentConversationId: 'brainstorm-recovery-source', kind: 'brainstorming', now: 1_000,
  };
  handover.registerAgentConversation(root, source);
  handover.updateAgentConversationCheckpoint(root, {
    ...source,
    checkpoint: {
      coreAnchor: 'Design deterministic cold Agent Conversation recovery.',
      findings: [{
        finding: 'Claude hook evidence confirms the native session identity is provider-affine.',
        reference: 'official Claude hook runtime inspection',
        digest: 'd'.repeat(64),
        token: 'FINDING_SECRET_CANARY',
      }],
      confirmedChoices: ['Use a sixty-minute deterministic pre-prompt hard gate.'],
      currentDirection: 'Recover expensive research from a bounded semantic checkpoint.',
      unresolvedDecisions: ['Choose no cache reconstruction path.'],
      nextAction: 'Continue the approved design from the recovered evidence.',
      transcript: 'RAW_TRANSCRIPT_RECOVERY_CANARY',
      privateReasoning: 'PRIVATE_REASONING_RECOVERY_CANARY',
      environment: { API_TOKEN: 'ENVIRONMENT_SECRET_RECOVERY_CANARY' },
    },
  });
  const sealed = handover.sealAgentConversationHandover(root, { ...source, now: 2_000 });
  const ownerBefore = loadPairState(root).continuation.owner_session_id;
  const adopted = childProcess.spawnSync(process.execPath, [
    path.resolve(__dirname, '../scripts/pair-task'),
    '--adopt-handover', sealed.handoverId,
    '--runtime', 'claude',
  ], {
    cwd: root,
    encoding: 'utf8',
    env: freshRuntimeEnv('', { CLAUDE_CODE_SESSION_ID: 'fresh-brainstorm-recovery' }),
  });

  assert.equal(adopted.status, 0, adopted.stderr);
  const output = JSON.parse(adopted.stdout);
  assert.equal(output.status, 'adopted');
  assert.equal(output.handover_id, sealed.handoverId);
  assert.equal(output.checkpoint.findings[0].finding, 'Claude hook evidence confirms the native session identity is provider-affine.');
  assert.equal(output.checkpoint.findings[0].reference, 'official Claude hook runtime inspection');
  assert.deepEqual(output.checkpoint.confirmed_choices, ['Use a sixty-minute deterministic pre-prompt hard gate.']);
  assert.equal(output.checkpoint.next_action, 'Continue the approved design from the recovered evidence.');
  assert.match(output.recovery_instruction, /Continue directly.*next_action/iu);
  assert.doesNotMatch(adopted.stdout, /FINDING_SECRET_CANARY|RAW_TRANSCRIPT_RECOVERY_CANARY|PRIVATE_REASONING_RECOVERY_CANARY|ENVIRONMENT_SECRET_RECOVERY_CANARY/u);
  assert.equal(loadPairState(root).continuation.owner_session_id, ownerBefore, 'brainstorming adoption must not take Pair ownership');
});

test('legacy-only Claude identity is rejected for handover adoption', t => {
  const root = fixture(t);
  const { sealed } = sealedHandover(root, 'claude');
  const adopted = childProcess.spawnSync(process.execPath, [
    path.resolve(__dirname, '../scripts/pair-task'),
    '--adopt-handover', sealed.handoverId,
    '--runtime', 'claude',
  ], {
    cwd: root,
    encoding: 'utf8',
    env: freshRuntimeEnv('', { CLAUDE_SESSION_ID: 'legacy-only-claude-session' }),
  });
  assert.notEqual(adopted.status, 0);
  assert.match(adopted.stderr, /requires a native conversation identity/iu);
  assert.equal(handover.readAgentConversationRegistry(root).handovers[sealed.handoverId].status, 'sealed');
});

test('cross-provider adoption requires an explicit runtime matching the actual native conversation', t => {
  const root = fixture(t);
  const { sealed } = sealedHandover(root, 'codex');
  const bin = fakeRuntime(root, 'claude');
  const claudeEnv = freshRuntimeEnv(bin, { CLAUDE_CODE_SESSION_ID: 'actual-claude-adopter' });
  const implicit = childProcess.spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/pair-task'), '--adopt-handover', sealed.handoverId, '--runtime', 'auto'], {
    cwd: root, encoding: 'utf8', env: claudeEnv,
  });
  assert.notEqual(implicit.status, 0);
  assert.match(implicit.stderr, /cross-provider adoption.*explicit --runtime claude/iu);

  const explicit = childProcess.spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/pair-task'), '--adopt-handover', sealed.handoverId, '--runtime', 'claude'], {
    cwd: root, encoding: 'utf8', env: claudeEnv,
  });
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.equal(loadPairState(root).continuation.owner_runtime, 'claude');

  const otherRoot = fixture(t);
  const other = sealedHandover(otherRoot, 'codex').sealed;
  const lying = childProcess.spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/pair-task'), '--adopt-handover', other.handoverId, '--runtime', 'claude'], {
    cwd: otherRoot,
    encoding: 'utf8',
    env: freshRuntimeEnv(bin, { CODEX_THREAD_ID: 'actual-codex-adopter' }),
  });
  assert.notEqual(lying.status, 0);
  assert.match(lying.stderr, /does not match the active codex Agent Conversation/iu);
});

test('rejects resume and fork argv and rejects nested runtime launch', t => {
  assert.throws(() => task.assertPlainFreshRuntimeCommand('codex', ['--resume', 'bad']), /resume|fork/i);
  assert.throws(() => task.assertPlainFreshRuntimeCommand('claude', ['--fork-session', 'bad']), /resume|fork/i);
  const root = fixture(t);
  const { sealed } = sealedHandover(root);
  assert.throws(() => task.launchFreshAgentConversation(root, {
    handoverId: sealed.handoverId, runtime: 'auto', available: ['codex'],
  }, { nested: true }), /nested/i);
  assert.throws(() => task.launchFreshAgentConversation(root, {
    handoverId: sealed.handoverId, runtime: 'auto', available: ['codex'],
  }, { env: { CLAUDE_CODE_CHILD_SESSION: '1' } }), /nested/i);
  assert.throws(() => task.launchFreshAgentConversation(root, {
    handoverId: sealed.handoverId, runtime: 'auto', available: [],
  }, {
    nested: false,
    spawn() { throw new Error('launch should not occur'); },
    spawnSync() { throw new Error('launch should not occur'); },
  }), /codex is not on PATH/i);
});

test('fresh launch refuses an active in-flight Pair request', t => {
  const root = fixture(t);
  appendPairEvent(root, {
    event: 'request.started', workId: 'work-handover-launch', request_id: 'request-live',
    request_pid: process.pid, request_kind: 'worker', phase: 'implementing',
  });
  const { sealed } = sealedHandover(root);
  assert.throws(() => task.launchFreshAgentConversation(root, {
    handoverId: sealed.handoverId, runtime: 'codex', available: ['codex'],
  }, {
    nested: false,
    spawnSync() { throw new Error('launch should not occur'); },
  }), /in-flight Pair request|Pair request .* in flight/i);
});

test('manual Pair adoption refuses an active in-flight request without claiming handover or ownership', t => {
  const root = fixture(t);
  appendPairEvent(root, {
    event: 'request.started', workId: 'work-handover-launch', request_id: 'manual-adoption-request-live',
    request_pid: process.pid, request_kind: 'reviewer', phase: 'reviewing',
  });
  const { source, sealed } = sealedHandover(root);
  const ownerBefore = loadPairState(root).continuation.owner_session_id;
  let transferCalled = false;

  assert.throws(() => task.adoptFreshAgentConversation(root, {
    handoverId: sealed.handoverId,
    runtime: 'codex',
    agentConversationId: 'manual-adopter-during-live-request',
    now: 3_000,
  }, {
    takeoverWork() { transferCalled = true; },
  }), /cannot adopt.*Pair request .* in flight/iu);

  const registry = handover.readAgentConversationRegistry(root);
  assert.equal(transferCalled, false);
  assert.equal(registry.handovers[sealed.handoverId].status, 'sealed');
  assert.equal(registry.conversations[sealed.sourceKey].status, 'sealed');
  assert.equal(registry.conversations[sealed.sourceKey].source_key, sealed.sourceKey);
  assert.equal(loadPairState(root).continuation.owner_session_id, ownerBefore);
  assert.equal(Object.values(registry.conversations).some(value => value.source_key !== sealed.sourceKey && value.adopted_handover_id === sealed.handoverId), false);
  assert.equal(source.agentConversationId, 'codex-source');
});

test('fresh brainstorming launch ignores unrelated in-flight Pair Work without mutating Pair authority', t => {
  const root = fixture(t);
  appendPairEvent(root, {
    event: 'request.started', workId: 'work-handover-launch', request_id: 'unrelated-pair-request',
    request_pid: process.pid, request_kind: 'worker', phase: 'implementing',
  });
  const identity = {
    runtime: 'claude', agentConversationId: 'brainstorm-launch-source', kind: 'brainstorming', now: 1_000,
  };
  handover.registerAgentConversation(root, identity);
  handover.updateAgentConversationCheckpoint(root, {
    ...identity,
    checkpoint: {
      coreAnchor: 'Keep brainstorming independent from unrelated Pair Work.',
      currentDirection: 'Launch a fresh brainstorming Agent Conversation.',
      nextAction: 'Adopt only the brainstorming handover.',
    },
  });
  const sealed = handover.sealAgentConversationHandover(root, { ...identity, now: 2_000 });
  const eventsBefore = readPairEvents(root);

  const launched = task.launchFreshAgentConversation(root, {
    handoverId: sealed.handoverId, runtime: 'claude', available: ['claude'],
  }, {
    nested: false,
    spawnSync() { return { status: 0 }; },
  });

  assert.equal(launched.runtime, 'claude');
  assert.deepEqual(readPairEvents(root), eventsBefore);
});

test('single atomic adopter and concurrent adoption have one winner', async t => {
  const root = fixture(t);
  const { sealed } = sealedHandover(root);
  const attempts = await Promise.all(['one', 'two'].map(agentConversationId => new Promise(resolve => {
    setImmediate(() => {
      try {
        resolve(task.adoptFreshAgentConversation(root, {
          handoverId: sealed.handoverId, runtime: 'codex', agentConversationId, now: 3_000,
        }).status);
      } catch (error) {
        resolve(error.message);
      }
    });
  })));
  assert.equal(attempts.filter(value => value === 'adopted').length, 1);
});

test('exact one-shot cost-risk override allows one prompt and requires a semantic checkpoint refresh', t => {
  const root = fixture(t);
  const { source, sealed } = sealedHandover(root);
  assert.throws(() => task.authorizeOneShotColdResume(root, {
    handoverId: sealed.handoverId, ...source, now: 3_000,
  }), /--once.*--confirm-cost-risk/i);
  const allowed = task.authorizeOneShotColdResume(root, {
    handoverId: sealed.handoverId, ...source, now: 3_000, once: true, confirmCostRisk: true,
  });
  assert.equal(allowed.status, 'allowed-once');
  assert.equal(handover.assessAgentConversationFreshness(root, { ...source, now: 3_001 }).status, 'override-allowed');
  assert.equal(handover.assessAgentConversationFreshness(root, { ...source, now: 3_002 }).status, 'override-consumed');
  handover.updateAgentConversationCheckpoint(root, {
    ...source,
    now: 3_750,
    checkpoint: {
      purpose: 'Protect the bounded handover.',
      currentDirection: 'Record the one permitted cold turn.',
      nextAction: 'Continue only from the refreshed handover.',
    },
  });
  const completed = handover.recordAgentConversationStop(root, { ...source, now: 4_000 });
  assert.equal(completed.status, 'retired');
  assert.match(completed.refreshedHandoverId, /^handover-/u);
  assert.equal(handover.readAgentConversationRegistry(root).conversations[sealed.sourceKey].status, 'retired');
  assert.throws(() => task.authorizeOneShotColdResume(root, {
    handoverId: sealed.handoverId, ...source, now: 5_000, once: true, confirmCostRisk: true,
  }), /already used|invalid handover/i);
});

test('fresh launch rejects a superseded handover and launches only its current refreshed handover', t => {
  const root = fixture(t);
  const { source, sealed } = sealedHandover(root);
  task.authorizeOneShotColdResume(root, {
    handoverId: sealed.handoverId, ...source, now: 3_000, once: true, confirmCostRisk: true,
  });
  assert.equal(handover.assessAgentConversationFreshness(root, { ...source, now: 3_001 }).status, 'override-allowed');
  handover.updateAgentConversationCheckpoint(root, {
    ...source,
    now: 3_500,
    checkpoint: {
      coreAnchor: 'Continue from the refreshed handover only.',
      currentDirection: 'Retire the original cold handover.',
      nextAction: 'Launch the refreshed handover.',
    },
  });
  const completed = handover.recordAgentConversationStop(root, { ...source, now: 4_000 });
  const retirement = handover.assessAgentConversationFreshness(root, { ...source, now: 4_001 });
  const reason = blockReason(retirement, 'codex');
  assert.match(reason, new RegExp(completed.refreshedHandoverId));
  assert.match(reason, /--fresh-from/u);
  assert.doesNotMatch(reason, /already adopted/iu);
  let spawns = 0;
  const dependencies = {
    nested: false,
    spawnSync() { spawns += 1; return { status: 0 }; },
  };

  assert.throws(() => task.launchFreshAgentConversation(root, {
    handoverId: sealed.handoverId, runtime: 'codex', available: ['codex'],
  }, dependencies), new RegExp(completed.refreshedHandoverId));
  assert.equal(spawns, 0, 'a superseded handover must fail before provider spawn');

  const launched = task.launchFreshAgentConversation(root, {
    handoverId: completed.refreshedHandoverId, runtime: 'codex', available: ['codex'],
  }, dependencies);
  assert.equal(launched.handoverId, completed.refreshedHandoverId);
  assert.equal(spawns, 1);
});

test('fresh launch rejects an already adopted brainstorming handover before provider spawn', t => {
  const root = fixture(t);
  const source = { runtime: 'claude', agentConversationId: 'brainstorm-adopted-source', kind: 'brainstorming', now: 1_000 };
  handover.registerAgentConversation(root, source);
  handover.updateAgentConversationCheckpoint(root, {
    ...source,
    checkpoint: {
      coreAnchor: 'Preserve brainstorming decisions.',
      currentDirection: 'Adopt once in a fresh conversation.',
      nextAction: 'Continue brainstorming.',
    },
  });
  const sealed = handover.sealAgentConversationHandover(root, { ...source, now: 2_000 });
  handover.adoptAgentConversationHandover(root, {
    handoverId: sealed.handoverId, runtime: 'claude', agentConversationId: 'brainstorm-adopter', now: 3_000,
  });
  let spawned = false;

  assert.throws(() => task.launchFreshAgentConversation(root, {
    handoverId: sealed.handoverId, runtime: 'claude', available: ['claude'],
  }, {
    nested: false,
    spawnSync() { spawned = true; return { status: 0 }; },
  }), /already adopted|invalid handover/i);
  assert.equal(spawned, false);
});

const manifestTamperCases = [
  ['runtime only', ({ manifest }) => { manifest.runtime = 'invalid-runtime'; }],
  ['source key only', ({ manifest }) => { manifest.source_key = 'f'.repeat(64); }],
  ['Pair kind and ownership reference', ({ manifest }) => {
    manifest.kind = 'brainstorming';
    manifest.pair_work = null;
  }],
  ['checkpoint revision', ({ manifest }) => { manifest.checkpoint_revision += 1; }],
  ['checkpoint digest', ({ manifest }) => { manifest.checkpoint_sha256 = 'd'.repeat(64); }],
  ['another valid Pair Work projection', ({ root, directory, manifest }) => {
    const otherWorkId = 'work-valid-but-unclaimed';
    const otherState = path.join(root, '.pair', 'runs', otherWorkId, 'state.json');
    fs.mkdirSync(path.dirname(otherState), { recursive: true });
    fs.writeFileSync(otherState, '{"schema":4,"work_id":"work-valid-but-unclaimed"}\n');
    const projectionSha256 = crypto.createHash('sha256').update(fs.readFileSync(otherState)).digest('hex');
    const projectionPath = `.pair/runs/${otherWorkId}/state.json`;
    const checkpointFile = path.join(directory, 'checkpoint.md');
    const checkpoint = JSON.parse(fs.readFileSync(checkpointFile, 'utf8'));
    checkpoint.artifacts = [{ path: projectionPath, sha256: projectionSha256 }];
    const checkpointBytes = JSON.stringify(checkpoint);
    fs.writeFileSync(checkpointFile, checkpointBytes);
    manifest.pair_work = {
      work_id: otherWorkId,
      projection_path: projectionPath,
      projection_sha256: projectionSha256,
    };
    manifest.checkpoint_sha256 = crypto.createHash('sha256').update(checkpointBytes).digest('hex');
    manifest.checkpoint_bytes = Buffer.byteLength(checkpointBytes, 'utf8');
  }],
];

for (const [name, tamper] of manifestTamperCases) {
  test(`tampered handover ${name} cannot launch or transfer Pair ownership`, t => {
    const root = fixture(t);
    const { sealed } = sealedHandover(root);
    const directory = path.join(handover.handoverPaths(root).directory, sealed.handoverId);
    const manifestFile = path.join(directory, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    tamper({ root, directory, manifest });
    fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    const before = loadPairState(root).continuation;
    let spawned = false;

    assert.throws(() => task.launchFreshAgentConversation(root, {
      handoverId: sealed.handoverId, runtime: 'codex', available: ['codex'],
    }, {
      nested: false,
      spawnSync() { spawned = true; return { status: 0 }; },
    }), /invalid handover/i);
    assert.throws(() => task.adoptFreshAgentConversation(root, {
      handoverId: sealed.handoverId, runtime: 'codex', agentConversationId: `manifest-${name}-adopter`, now: 3_000,
    }), /invalid handover/i);
    assert.equal(spawned, false);
    assert.deepEqual(loadPairState(root).continuation, before);
  });
}

for (const corruption of ['checkpoint revision', 'checkpoint content']) {
  test(`sealed source ${corruption} corruption cannot launch or transfer ownership`, t => {
    const root = fixture(t);
    const { sealed } = sealedHandover(root);
    const paths = handover.handoverPaths(root);
    const registry = JSON.parse(fs.readFileSync(paths.registry, 'utf8'));
    const source = registry.conversations[sealed.sourceKey];
    if (corruption === 'checkpoint revision') source.checkpoint_revision += 1;
    else source.checkpoint.next_action = 'A shape-valid but unsealed registry mutation.';
    fs.writeFileSync(paths.registry, `${JSON.stringify(registry, null, 2)}\n`);
    const before = loadPairState(root).continuation;
    let spawned = false;

    assert.throws(() => task.launchFreshAgentConversation(root, {
      handoverId: sealed.handoverId, runtime: 'codex', available: ['codex'],
    }, {
      nested: false,
      spawnSync() { spawned = true; return { status: 0 }; },
    }), /invalid handover/i);
    assert.throws(() => task.adoptFreshAgentConversation(root, {
      handoverId: sealed.handoverId, runtime: 'codex', agentConversationId: `registry-${corruption}-adopter`, now: 3_000,
    }), /invalid handover/i);
    assert.equal(spawned, false);
    assert.deepEqual(loadPairState(root).continuation, before);
  });
}

for (const corruption of ['missing', 'malformed']) {
  test(`${corruption} handover events prevent launch and adoption without ownership mutation`, t => {
    const root = fixture(t);
    const { sealed } = sealedHandover(root);
    const eventsFile = path.join(handover.handoverPaths(root).directory, sealed.handoverId, 'events.jsonl');
    if (corruption === 'missing') fs.rmSync(eventsFile);
    else fs.writeFileSync(eventsFile, '{malformed event\n');
    const before = loadPairState(root).continuation;
    let spawned = false;

    assert.throws(() => task.launchFreshAgentConversation(root, {
      handoverId: sealed.handoverId, runtime: 'codex', available: ['codex'],
    }, {
      nested: false,
      spawnSync() { spawned = true; return { status: 0 }; },
    }), /invalid handover/i);
    assert.throws(() => task.adoptFreshAgentConversation(root, {
      handoverId: sealed.handoverId, runtime: 'codex', agentConversationId: `events-${corruption}-adopter`, now: 3_000,
    }), /invalid handover/i);
    assert.equal(spawned, false);
    assert.deepEqual(loadPairState(root).continuation, before);
  });
}

for (const corruption of ['unknown event', 'known event with an extra secret field']) {
  test(`${corruption} makes the handover fail closed before launch or adoption`, t => {
    const root = fixture(t);
    const { sealed } = sealedHandover(root);
    const eventsFile = path.join(handover.handoverPaths(root).directory, sealed.handoverId, 'events.jsonl');
    if (corruption === 'unknown event') {
      fs.appendFileSync(eventsFile, `${JSON.stringify({
        event: 'note',
        at: new Date(2_500).toISOString(),
        prompt: 'secret-event-canary',
      })}\n`);
    } else {
      const sealedEvent = JSON.parse(fs.readFileSync(eventsFile, 'utf8').trim());
      sealedEvent.prompt = 'secret-event-canary';
      fs.writeFileSync(eventsFile, `${JSON.stringify(sealedEvent)}\n`);
    }
    const before = loadPairState(root).continuation;
    let spawned = false;

    assert.throws(() => task.launchFreshAgentConversation(root, {
      handoverId: sealed.handoverId, runtime: 'codex', available: ['codex'],
    }, {
      nested: false,
      spawnSync() { spawned = true; return { status: 0 }; },
    }), /invalid handover/i);
    assert.throws(() => task.adoptFreshAgentConversation(root, {
      handoverId: sealed.handoverId, runtime: 'codex', agentConversationId: `event-schema-${corruption}`, now: 3_000,
    }), /invalid handover/i);
    assert.equal(spawned, false);
    assert.deepEqual(loadPairState(root).continuation, before);
  });
}

test('legacy Claude session identities are nested and stripped from fresh runtime environments', t => {
  const root = fixture(t);
  const { sealed } = sealedHandover(root);
  for (const key of ['CLAUDE_SESSION_ID', 'CLAUDE_SESSION_ID_OVERRIDE']) {
    assert.throws(() => task.launchFreshAgentConversation(root, {
      handoverId: sealed.handoverId, runtime: 'codex', available: ['codex'],
    }, {
      env: { [key]: 'legacy-parent-session' },
      spawnSync() { throw new Error('launch should not occur'); },
    }), /nested/i);
    const env = task.runtimeEnv({
      sourceEnv: { PATH: process.env.PATH || '', [key]: 'legacy-parent-session' },
      disableStopGate: false,
    });
    assert.equal(env[key], undefined);
  }
});
