const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const repositoryRoot = path.resolve(__dirname, '../../..');
const pairTask = path.join(repositoryRoot, 'skills/pair-v3/scripts/pair-task');
const handover = require('../../pair-v3/scripts/lib/handover-state');

function fixture(t) {
  const scratchRoot = process.env.CLAUDE_SCRATCH_DIR || path.join(os.homedir(), '.claude-scratch');
  const root = fs.mkdtempSync(path.join(scratchRoot, 'my-claude-code-brainstorm-handover-'));
  childProcess.spawnSync('git', ['init', '-q'], { cwd: root });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function waitForDeadTmuxPane(socket, paneId, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  let status = null;
  while (Date.now() < deadline) {
    status = childProcess.spawnSync('tmux', [
      '-S', socket, 'display-message', '-p', '-t', paneId, '#{pane_dead}\t#{pane_dead_status}',
    ], { encoding: 'utf8' });
    if (status.status === 0 && status.stdout.startsWith('1\t')) return status.stdout.trim().split('\t');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  return status?.stdout?.trim().split('\t') || [];
}

function runCheckpointInTmux(t, root, checkpointFlag) {
  const socket = path.join(path.dirname(root), `checkpoint-tty-${crypto.randomUUID().slice(0, 8)}.sock`);
  const session = 'checkpoint-input';
  t.after(() => {
    childProcess.spawnSync('tmux', ['-S', socket, 'kill-server']);
    fs.rmSync(socket, { force: true });
  });
  const created = childProcess.spawnSync('tmux', ['-S', socket, 'new-session', '-d', '-s', session, '-c', root], { encoding: 'utf8' });
  assert.equal(created.status, 0, created.stderr);
  const listed = childProcess.spawnSync('tmux', ['-S', socket, 'list-panes', '-t', `=${session}`, '-F', '#{pane_id}'], { encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.stderr);
  const paneId = listed.stdout.trim();
  assert.match(paneId, /^%\d+$/u);
  const retained = childProcess.spawnSync('tmux', ['-S', socket, 'set-option', '-w', '-t', paneId, 'remain-on-exit', 'on'], { encoding: 'utf8' });
  assert.equal(retained.status, 0, retained.stderr);
  const launched = childProcess.spawnSync('tmux', [
    '-S', socket, 'respawn-pane', '-k', '-t', paneId,
    '-c', root,
    '-e', 'CODEX_THREAD_ID=',
    '-e', `CLAUDE_CODE_SESSION_ID=claude-${session}`,
    process.execPath, pairTask, checkpointFlag, '--runtime', 'claude',
  ], { encoding: 'utf8' });
  assert.equal(launched.status, 0, launched.stderr);
  const [dead, exitStatus] = waitForDeadTmuxPane(socket, paneId);
  const captured = childProcess.spawnSync('tmux', ['-S', socket, 'capture-pane', '-p', '-S', '-', '-E', '-', '-t', paneId], { encoding: 'utf8' });
  return { dead, exitStatus, output: captured.stdout };
}

function checkpoint(root, nextAction) {
  const env = { ...process.env, CLAUDE_CODE_SESSION_ID: 'claude-brainstorm-session' };
  delete env.CODEX_THREAD_ID;
  delete env.CLAUDE_SESSION_ID;
  delete env.CLAUDE_SESSION_ID_OVERRIDE;
  return childProcess.spawnSync(process.execPath, [pairTask, '--brainstorm-checkpoint', '--runtime', 'claude'], {
    cwd: root,
    encoding: 'utf8',
    env,
    input: `${JSON.stringify({
      coreAnchor: 'Design deterministic cold-session handover.',
      findings: [{
        finding: 'The installed Claude runtime exposes the same native identity used by hooks.',
        reference: 'official Claude hook session identity',
      }],
      confirmedChoices: ['Use a sixty-minute pre-prompt hard gate.'],
      rejectedAlternatives: ['Trust provider cache telemetry.'],
      currentDirection: 'Keep the checkpoint semantic and bounded.',
      unresolvedDecisions: ['None.'],
      nextAction,
    })}\n`,
  });
}

test('brainstorming registers the documented Claude identity and refreshes a bounded semantic checkpoint', t => {
  const root = fixture(t);
  const first = checkpoint(root, 'Ask the next approved design question.');
  const second = checkpoint(root, 'Write the approved specification.');

  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  const registry = handover.readAgentConversationRegistry(root);
  const conversations = Object.values(registry.conversations);
  assert.equal(conversations.length, 1);
  assert.equal(conversations[0].runtime, 'claude');
  assert.equal(conversations[0].kind, 'brainstorming');
  assert.equal(conversations[0].checkpoint_revision, 2);
  assert.equal(conversations[0].checkpoint.core_anchor, 'Design deterministic cold-session handover.');
  assert.equal(conversations[0].checkpoint.findings[0].finding, 'The installed Claude runtime exposes the same native identity used by hooks.');
  assert.equal(conversations[0].checkpoint.next_action, 'Write the approved specification.');
});

test('brainstorm checkpoint rejects unknown top-level and nested fields before registration', t => {
  const cases = [
    {
      name: 'top-level artifactDigests',
      checkpoint: {
        coreAnchor: 'Preserve the approved direction.',
        currentDirection: 'Validate strict checkpoint input.',
        nextAction: 'Reject the unsupported field.',
        artifactDigests: ['docs/spec.md sha256:deadbeef'],
      },
      expected: /unsupported.*artifactDigests/iu,
    },
    {
      name: 'live top-level artifact_digests',
      checkpoint: {
        coreAnchor: 'Preserve the approved direction.',
        currentDirection: 'Validate strict checkpoint input.',
        nextAction: 'Reject the unsupported field.',
        artifact_digests: ['docs/spec.md sha256:deadbeef'],
      },
      expected: /unsupported.*artifact_digests/iu,
    },
    {
      name: 'nested finding evidence',
      checkpoint: {
        coreAnchor: 'Preserve the approved direction.',
        findings: [{ finding: 'Observed behavior.', evidence: ['src/file.js:10'] }],
        currentDirection: 'Validate strict checkpoint input.',
        nextAction: 'Reject the unsupported field.',
      },
      expected: /unsupported.*evidence/iu,
    },
  ];

  for (const candidate of cases) {
    const root = fixture(t);
    const env = { ...process.env, CLAUDE_CODE_SESSION_ID: `strict-${candidate.name.replaceAll(' ', '-')}` };
    delete env.CODEX_THREAD_ID;
    const result = childProcess.spawnSync(process.execPath, [pairTask, '--brainstorm-checkpoint', '--runtime', 'claude'], {
      cwd: root,
      encoding: 'utf8',
      env,
      input: `${JSON.stringify(candidate.checkpoint)}\n`,
    });

    assert.notEqual(result.status, 0, candidate.name);
    assert.match(result.stderr, candidate.expected);
    assert.equal(fs.existsSync(path.join(root, '.pair')), false, `${candidate.name} must not register or mutate state`);
  }
});

test('brainstorm checkpoint rejects the live object-shaped Core Anchor before registration', t => {
  const root = fixture(t);
  const env = { ...process.env, CLAUDE_CODE_SESSION_ID: 'strict-live-core-anchor' };
  delete env.CODEX_THREAD_ID;
  const result = childProcess.spawnSync(process.execPath, [pairTask, '--brainstorm-checkpoint', '--runtime', 'claude'], {
    cwd: root,
    encoding: 'utf8',
    env,
    input: `${JSON.stringify({
      core_anchor: { goal: 'Preserve this goal.', success: 'A fresh agent can continue.' },
      currentDirection: 'Validate the captured live payload.',
      nextAction: 'Reject it before registration.',
    })}\n`,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /core_anchor must be a string/u);
  assert.equal(fs.existsSync(path.join(root, '.pair')), false);
});

test('checkpoint commands fail fast on a real interactive PTY instead of waiting for JSON', { timeout: 10_000 }, t => {
  if (childProcess.spawnSync('tmux', ['-V']).status !== 0) return t.skip('tmux unavailable');
  for (const checkpointFlag of ['--brainstorm-checkpoint', '--conversation-checkpoint']) {
    const root = fixture(t);
    const result = runCheckpointInTmux(t, root, checkpointFlag);

    assert.equal(result.dead, '1', `${checkpointFlag} remained blocked on PTY stdin`);
    assert.equal(result.exitStatus, '1', result.output);
    assert.match(result.output, /does not accept interactive TTY stdin.*checkpoint\.json/isu);
    assert.equal(fs.existsSync(path.join(root, '.pair')), false, `${checkpointFlag} must not mutate state`);
  }
});

test('brainstorm checkpoint accepts and preserves the documented artifact shape', t => {
  const root = fixture(t);
  const artifactPath = 'docs/approved-design.md';
  const absoluteArtifact = path.join(root, artifactPath);
  fs.mkdirSync(path.dirname(absoluteArtifact), { recursive: true });
  fs.writeFileSync(absoluteArtifact, 'approved design\n');
  const digest = crypto.createHash('sha256').update(fs.readFileSync(absoluteArtifact)).digest('hex');
  const env = { ...process.env, CLAUDE_CODE_SESSION_ID: 'strict-artifact-shape' };
  delete env.CODEX_THREAD_ID;

  const result = childProcess.spawnSync(process.execPath, [pairTask, '--brainstorm-checkpoint', '--runtime', 'claude'], {
    cwd: root,
    encoding: 'utf8',
    env,
    input: `${JSON.stringify({
      coreAnchor: 'Preserve the approved direction.',
      findings: [{ finding: 'The design is approved.', reference: `${artifactPath}:1`, digest }],
      currentDirection: 'Prepare the bounded handover.',
      nextAction: 'Adopt from the approved design.',
      artifacts: [{ path: artifactPath, sha256: digest }],
    })}\n`,
  });

  assert.equal(result.status, 0, result.stderr);
  const [conversation] = Object.values(handover.readAgentConversationRegistry(root).conversations);
  assert.deepEqual(conversation.checkpoint.artifacts, [{ path: artifactPath, sha256: digest }]);
  assert.equal(conversation.checkpoint.findings[0].reference, `${artifactPath}:1`);
});

test('an identical brainstorming checkpoint is an auditable refresh during the one-shot override', t => {
  const root = fixture(t);
  const first = checkpoint(root, 'Keep the approved direction.');
  assert.equal(first.status, 0, first.stderr);
  const identity = {
    runtime: 'claude', agentConversationId: 'claude-brainstorm-session', kind: 'brainstorming',
  };
  const now = Date.now();
  const sealed = handover.sealAgentConversationHandover(root, { ...identity, now });
  handover.authorizeColdResume(root, {
    ...identity, now: now + 1, handoverId: sealed.handoverId, confirmCostRisk: true,
  });
  assert.equal(handover.assessAgentConversationFreshness(root, { ...identity, now: now + 2 }).status, 'override-allowed');

  const refreshed = checkpoint(root, 'Keep the approved direction.');
  assert.equal(refreshed.status, 0, refreshed.stderr);
  const completed = handover.recordAgentConversationStop(root, { ...identity, now: now + 3 });

  assert.equal(completed.status, 'retired');
  const source = handover.readAgentConversationRegistry(root).conversations[sealed.sourceKey];
  assert.match(source.override.refreshed_at, /^\d{4}-\d{2}-\d{2}T/u);
});

test('brainstorming skill requires the executable checkpoint command at material research and decision boundaries', () => {
  const content = fs.readFileSync(path.resolve(__dirname, '../SKILL.md'), 'utf8');
  assert.match(content, /pair-loop --brainstorm-checkpoint/u);
  assert.match(content, /material research or decision boundary/u);
  assert.match(content, /confirmed Core Anchor/u);
  assert.match(content, /bounded finding statements.*evidence references and digests/iu);
  assert.match(content, /unknown top-level or nested fields fail/iu);
  assert.match(content, /artifacts.*path.*sha256/iu);
  assert.match(content, /interactive TTY stdin.*here-document.*redirect/isu);
  assert.match(content, /refreshes the volatile current direction, unresolved decisions, and next action/iu);
  assert.match(content, /never persist.*prompt.*transcript.*private reasoning/isu);
});

test('brainstorming registers CODEX_THREAD_ID and rejects a runtime that lies about the native conversation', t => {
  const root = fixture(t);
  const env = { ...process.env, CODEX_THREAD_ID: 'codex-brainstorm-session' };
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CLAUDE_SESSION_ID;
  delete env.CLAUDE_SESSION_ID_OVERRIDE;
  const payload = `${JSON.stringify({
    coreAnchor: 'Preserve the Codex brainstorming checkpoint.',
    currentDirection: 'Verify native identity routing.',
    nextAction: 'Continue the design interview.',
  })}\n`;
  const recorded = childProcess.spawnSync(process.execPath, [pairTask, '--brainstorm-checkpoint', '--runtime', 'auto'], {
    cwd: root, encoding: 'utf8', env, input: payload,
  });
  assert.equal(recorded.status, 0, recorded.stderr);
  const conversation = Object.values(handover.readAgentConversationRegistry(root).conversations)[0];
  assert.equal(conversation.runtime, 'codex');
  assert.equal(conversation.kind, 'brainstorming');

  const mismatchRoot = fixture(t);
  const mismatch = childProcess.spawnSync(process.execPath, [pairTask, '--brainstorm-checkpoint', '--runtime', 'claude'], {
    cwd: mismatchRoot, encoding: 'utf8', env, input: payload,
  });
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /does not match the active codex Agent Conversation/iu);
  assert.equal(fs.existsSync(path.join(mismatchRoot, '.pair')), false);
});

test('brainstorm checkpoint rejects ambiguous native identity and mixed control modes', t => {
  const ambiguousRoot = fixture(t);
  const ambiguous = childProcess.spawnSync(process.execPath, [pairTask, '--brainstorm-checkpoint', '--runtime', 'auto'], {
    cwd: ambiguousRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      CODEX_THREAD_ID: 'codex-ambiguous',
      CLAUDE_CODE_SESSION_ID: 'claude-ambiguous',
    },
    input: '{}\n',
  });
  assert.notEqual(ambiguous.status, 0);
  assert.match(ambiguous.stderr, /ambiguous.*native Agent Conversation identity/iu);
  assert.equal(fs.existsSync(path.join(ambiguousRoot, '.pair')), false);

  const mixedRoot = fixture(t);
  const mixedEnv = { ...process.env, CLAUDE_CODE_SESSION_ID: 'claude-mixed-mode' };
  delete mixedEnv.CODEX_THREAD_ID;
  const mixed = childProcess.spawnSync(process.execPath, [pairTask, '--brainstorm-checkpoint', '--status'], {
    cwd: mixedRoot, encoding: 'utf8', env: mixedEnv, input: '{}\n',
  });
  assert.notEqual(mixed.status, 0);
  assert.match(mixed.stderr, /brainstorm-checkpoint.*control|control.*brainstorm-checkpoint/iu);
  assert.equal(fs.existsSync(path.join(mixedRoot, '.pair')), false);
});

test('brainstorm checkpoint rejects legacy-only Claude identity as non-native', t => {
  const root = fixture(t);
  const env = { ...process.env, CLAUDE_SESSION_ID: 'legacy-only-brainstorm-session' };
  delete env.CODEX_THREAD_ID;
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CLAUDE_SESSION_ID_OVERRIDE;
  const recorded = childProcess.spawnSync(process.execPath, [pairTask, '--brainstorm-checkpoint', '--runtime', 'claude'], {
    cwd: root,
    encoding: 'utf8',
    env,
    input: '{}\n',
  });
  assert.notEqual(recorded.status, 0);
  assert.match(recorded.stderr, /requires a native Agent Conversation identity/iu);
  assert.equal(fs.existsSync(path.join(root, '.pair')), false);
});

test('brainstorming registers the Agent Conversation at activation as the mandatory first action', () => {
  const content = fs.readFileSync(path.resolve(__dirname, '../SKILL.md'), 'utf8');
  assert.match(content, /pair-loop --register-brainstorming/u);
  assert.match(content, /register the Agent Conversation/u);
  assert.match(content, /mandatory first action/u);
  assert.match(content, /before opening the Visual Companion/u);
});
