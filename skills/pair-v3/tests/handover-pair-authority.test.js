const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { openWork } = require('../scripts/lib/pair-engine');
const { readState, workPaths, writeState } = require('../scripts/lib/pair-store');
const {
  conversationIdentity,
  derivePairCheckpoint,
  handoverPaths,
  prepareAgentConversationStop,
  readAgentConversationRegistry,
  recordAgentConversationStop,
  registerAgentConversation,
  sealAgentConversationHandover,
  setGeneralHandoverPolicy,
  updateAgentConversationCheckpoint,
} = require('../scripts/lib/handover-state');

// A repository whose only Pair Work lives in the Evidence-at-Commit store the engine actually
// writes: <git-common-dir>/pair/works/<id>/state.json, located by .git/pair-current.json. The
// retired attempt-ledger store (.pair/runs/<id>/, located by .pair/current-run.json) is absent,
// which is the shape of every real Pair repository since the vNext engine landed.
function engineWorkFixture(t, { workId = 'work-authority' } = {}) {
  const scratch = process.env.CLAUDE_SCRATCH_DIR || path.join(os.homedir(), '.claude-scratch');
  const parent = path.join(scratch, 'my-claude-code', 'pair-handover-authority-tests');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'authority-'));
  childProcess.execFileSync('git', ['init', '-q'], { cwd: root });
  childProcess.execFileSync('git', ['config', 'user.email', 'pair@test'], { cwd: root });
  childProcess.execFileSync('git', ['config', 'user.name', 'Pair Test'], { cwd: root });
  fs.writeFileSync(path.join(root, 'value.js'), 'module.exports = 1;\n');
  childProcess.execFileSync('git', ['add', '.'], { cwd: root });
  childProcess.execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
  const spec = path.join(parent, `${path.basename(root)}-spec.md`);
  const manifest = path.join(parent, `${path.basename(root)}-slices.json`);
  fs.writeFileSync(spec, '# Spec\n\n## Acceptance Criteria\n\n- [ ] AC-1: value becomes two\n');
  fs.writeFileSync(manifest, JSON.stringify({
    schema: 1,
    work_id: workId,
    slices: [{ id: 'S1', acceptance_criteria: ['AC-1'], outcome: 'Existing value returns two.', depends_on: [], verify: 'node verify.js' }],
  }));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(spec, { force: true });
    fs.rmSync(manifest, { force: true });
  });
  openWork(root, { workId, specPath: spec, manifestPath: manifest });
  // Mirrors a real Pair repository: the Stop hook auto-registers conversations, which is how the
  // ParagonAgent conversations reached the registry as `general` in the first place.
  setGeneralHandoverPolicy(root, true);
  return { root, workId };
}

function claudeTranscript(root, sessionId, options = {}) {
  const {
    direction = 'Keep the retry budget per defect, not per attempt.',
    conclusion = 'Root cause: the payload validator counts one edge per node instead of N-1.',
  } = options;
  const file = path.join(root, `${sessionId}.jsonl`);
  fs.writeFileSync(file, `${[
    { type: 'user', sessionId, timestamp: '2026-08-04T10:00:00.000Z', message: { role: 'user', content: direction } },
    { type: 'assistant', sessionId, timestamp: '2026-08-04T10:05:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: conclusion }] } },
  ].map(entry => JSON.stringify(entry)).join('\n')}\n`);
  return file;
}

test('Pair checkpoint derivation reports the engine next action for a Work in the Evidence-at-Commit store', t => {
  const { root, workId } = engineWorkFixture(t);

  const checkpoint = derivePairCheckpoint(root);

  assert.equal(checkpoint.next_action, readState(root).next_action);
  assert.match(checkpoint.next_action, /run Review Slice S1/u);
  assert.match(checkpoint.core_anchor, new RegExp(workId, 'u'));
  assert.match(checkpoint.core_anchor, /ready/u, 'the Core Anchor names the lifecycle the engine recorded');
  assert.match(checkpoint.current_direction, /S1/u);
  assert.deepEqual(
    checkpoint.artifacts.map(artifact => artifact.path),
    [path.relative(root, workPaths(root, workId).state).split(path.sep).join('/')],
  );
});

test('Pair checkpoint derivation reports the engine lifecycle after the Work advances', t => {
  const { root, workId } = engineWorkFixture(t);
  const state = readState(root);
  writeState(root, workId, {
    ...state,
    lifecycle: 'awaiting-human',
    next_action: 'human review corrected checkpoint deadbeef',
    slices: state.slices.map(slice => ({ ...slice, status: 'awaiting-human-review' })),
  });

  const checkpoint = derivePairCheckpoint(root);

  assert.equal(checkpoint.next_action, 'human review corrected checkpoint deadbeef');
  assert.match(checkpoint.core_anchor, /awaiting-human/u);
});

test('Pair registration recognizes a conversation whose repository owns a Work in the engine store', t => {
  const { root } = engineWorkFixture(t);
  const identity = { runtime: 'claude', agentConversationId: 'authority-auto-session' };

  const prepared = prepareAgentConversationStop(root, {
    ...identity,
    transcriptPath: claudeTranscript(root, 'authority-auto-session'),
    now: 2_000,
  });

  assert.equal(prepared.status, 'registered');
  const stored = readAgentConversationRegistry(root).conversations[conversationIdentity(identity).sourceKey];
  assert.equal(stored.kind, 'pair', 'a repository with a live Pair Work makes this a Pair conversation, not a general one');
});

test('Pair authority replaces recovered transcript prose when a general conversation owns a live Work', t => {
  const { root } = engineWorkFixture(t);
  const identity = { runtime: 'claude', agentConversationId: 'authority-general-session' };
  registerAgentConversation(root, { ...identity, kind: 'general', now: 1_000 });
  updateAgentConversationCheckpoint(root, {
    ...identity,
    checkpoint: {
      coreAnchor: 'Review Slice S1 sits at correction-ready with its single bounded correction UNSPENT.',
      findings: [],
      confirmedChoices: [],
      rejectedAlternatives: [],
      currentDirection: 'Explain how to review a Pair checkpoint.',
      unresolvedDecisions: [],
      nextAction: 'Continue from the latest recorded assistant state: **1. Two diffs, never one** ...',
      artifacts: [],
    },
    origin: 'manual',
    now: 1_500,
  });

  const prepared = prepareAgentConversationStop(root, {
    ...identity,
    transcriptPath: claudeTranscript(root, 'authority-general-session'),
    now: 2_000,
  });

  assert.equal(prepared.status, 'checkpointed');
  const stored = readAgentConversationRegistry(root).conversations[conversationIdentity(identity).sourceKey];
  assert.equal(stored.checkpoint.next_action, readState(root).next_action, 'repository authority owns the next action');
  assert.doesNotMatch(stored.checkpoint.next_action, /Two diffs/u);
  assert.doesNotMatch(stored.checkpoint.core_anchor, /UNSPENT/u, 'a stale hand-written anchor cannot outlive the lifecycle it describes');
  assert.match(stored.checkpoint.core_anchor, /work-authority/u);
  assert.match(
    JSON.stringify(stored.checkpoint.findings),
    /counts one edge per node/u,
    'the recovered conversation layer still survives',
  );
});

test('sealing a Pair conversation binds the engine Work projection into the handover manifest', t => {
  const { root, workId } = engineWorkFixture(t);
  const identity = { runtime: 'claude', agentConversationId: 'authority-seal-session' };
  prepareAgentConversationStop(root, {
    ...identity,
    transcriptPath: claudeTranscript(root, 'authority-seal-session'),
    now: 2_000,
  });
  recordAgentConversationStop(root, { ...identity, now: 3_000 });

  const sealed = sealAgentConversationHandover(root, { ...identity, now: 4_000 });

  const directory = path.join(handoverPaths(root).directory, sealed.handoverId);
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.kind, 'pair');
  assert.equal(manifest.pair_work?.work_id, workId, 'the sealed handover points at the Work it belongs to');
  const checkpoint = JSON.parse(fs.readFileSync(path.join(directory, 'checkpoint.md'), 'utf8'));
  assert.equal(checkpoint.next_action, readState(root).next_action);
  assert.match(
    JSON.stringify(checkpoint.findings),
    /counts one edge per node/u,
    'sealing refreshes the lifecycle layer without discarding the conversation layer it cannot re-derive',
  );
});
