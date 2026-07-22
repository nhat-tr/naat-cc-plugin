const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
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
      prompt: 'RAW_BRAINSTORM_PROMPT_MUST_NOT_PERSIST',
      transcript: 'RAW_BRAINSTORM_TRANSCRIPT_MUST_NOT_PERSIST',
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
  const persisted = fs.readFileSync(handover.handoverPaths(root).registry, 'utf8');
  assert.doesNotMatch(persisted, /RAW_BRAINSTORM_(?:PROMPT|TRANSCRIPT)_MUST_NOT_PERSIST/u);
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
