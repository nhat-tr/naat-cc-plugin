const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const HANDOVER_MODULE = path.resolve(__dirname, '../scripts/lib/handover-state.js');
const { appendPairEvent, loadPairState } = require('../scripts/lib/pair-state');
const { takeoverWork } = require('../scripts/lib/pair-control');

// Fixture Visual Companion state for the deriveBrainstormingCheckpoint integration tests below:
// a temp CLAUDE_SCRATCH_DIR pointer (mirroring visual-session.cjs's active-session.json) plus a
// live session directory with a workspace.json (one chosen decision, one unresolved) and the
// session.jsonl user.turn event recording that choice. Shapes mirror workspace-document.cjs's
// normalizeDecisions/normalizeWorkspaceDocument and session-store.cjs's normalizeChoices (see
// skills/pair-v3/tests/brainstorm-checkpoint.test.js for exact line citations); both files are
// untouched by the concurrent Workspace Tabs addition, and content/workspace.json itself is
// still "the currently active document" under that feature (tabs are additive, filed separately
// under tab-<id>.json).
function brainstormSessionFixture(t, root, options = {}) {
  const realScratchBase = process.env.CLAUDE_SCRATCH_DIR || path.join(os.homedir(), '.claude-scratch');
  const fakeScratchDir = fs.mkdtempSync(path.join(realScratchBase, 'my-claude-code-handover-state-brainstorm-scratch-'));
  const previousScratchDir = process.env.CLAUDE_SCRATCH_DIR;
  process.env.CLAUDE_SCRATCH_DIR = fakeScratchDir;
  t.after(() => {
    if (previousScratchDir === undefined) delete process.env.CLAUDE_SCRATCH_DIR;
    else process.env.CLAUDE_SCRATCH_DIR = previousScratchDir;
    fs.rmSync(fakeScratchDir, { recursive: true, force: true });
  });

  const {
    sessionId = 'session-handover-fixture',
    pointer: writePointer = true,
    decisions = [
      { id: 'decision-a', title: 'Choose the auth strategy', multiselect: false, option_component_ids: ['opt-a1'] },
      { id: 'decision-b', title: 'Choose the storage engine', multiselect: false, option_component_ids: ['opt-b1'] },
    ],
    choices = [{ groupId: 'decision-a', componentId: 'opt-a1', value: 'oauth', label: 'OAuth 2.0' }],
    title = 'Checkout revamp',
    revision = 'abcd1234',
  } = options;

  const digest = crypto.createHash('sha256').update(root).digest('hex').slice(0, 8);
  const pointerDir = path.join(fakeScratchDir, `${path.basename(root)}-${digest}`, 'brainstorm');
  // Production layout: visual-session.cjs creates scratch session directories beside the
  // active-session.json pointer file. pointer:false models a stopped companion, which removes
  // the pointer on stop but leaves the session directory behind.
  const sessionDir = path.join(pointerDir, sessionId);
  const contentDir = path.join(sessionDir, 'content');
  const stateDir = path.join(sessionDir, 'state');
  fs.mkdirSync(pointerDir, { recursive: true });
  fs.mkdirSync(contentDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  if (writePointer) {
    fs.writeFileSync(path.join(pointerDir, 'active-session.json'), JSON.stringify({
      version: 1, pid: process.pid, session_id: sessionId, session_dir: sessionDir, content_dir: contentDir, state_dir: stateDir,
    }));
  }
  fs.writeFileSync(path.join(contentDir, 'workspace.json'), JSON.stringify({
    version: 2, work_id: 'work-handover', workspace_kind: 'ui-screens', title, revision, decisions,
  }));
  fs.writeFileSync(path.join(stateDir, 'session.jsonl'), `${JSON.stringify({
    version: 1,
    id: 'evt-1',
    seq: 1,
    timestamp: new Date(1_000).toISOString(),
    type: 'user.turn',
    role: 'user',
    clientTurnId: 'turn-1',
    message: 'reviewer note',
    annotations: [],
    choices,
    screen: null,
  })}\n`);

  return { sessionId, sessionDir, contentDir, stateDir };
}

function fixture(t) {
  const scratchRoot = process.env.CLAUDE_SCRATCH_DIR || path.join(os.homedir(), '.claude-scratch');
  const root = fs.mkdtempSync(path.join(scratchRoot, 'my-claude-code-handover-state-'));
  fs.mkdirSync(path.join(root, '.pair'), { recursive: true });
  appendPairEvent(root, { event: 'work.opened', workId: 'work-handover', planDigest: 'a'.repeat(64) });
  appendPairEvent(root, { event: 'attempt.started', workId: 'work-handover', attemptId: '1.1-handover', taskId: '1.1', phase: 'implementing' });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function handoverApi() {
  return require(HANDOVER_MODULE);
}

function conversation(overrides = {}) {
  return {
    runtime: 'codex',
    agentConversationId: 'conversation-source',
    kind: 'pair',
    now: 1_000,
    ...overrides,
  };
}

function checkpoint(overrides = {}) {
  return {
    coreAnchor: 'Complete the currently approved Pair Work.',
    findings: [{ reference: 'skills/pair-v3/tests/pair-state.integration.test.js', digest: 'b'.repeat(64) }],
    confirmedChoices: ['Preserve Pair Work authority in its existing reducer.'],
    rejectedAlternatives: ['Persist raw conversation material.'],
    currentDirection: 'Seal a bounded Agent Conversation Handover.',
    unresolvedDecisions: ['None.'],
    nextAction: 'Run the focused handover-state verification.',
    artifacts: [],
    ...overrides,
  };
}

test('normalizeCheckpoint treats a nullish field as empty text instead of the literal "undefined"', () => {
  const { normalizeCheckpoint } = handoverApi();
  const empty = normalizeCheckpoint({});
  assert.equal(empty.core_anchor, '');
  assert.equal(empty.current_direction, '');
  assert.equal(empty.next_action, '');

  const bootstrapped = normalizeCheckpoint(handoverApi().brainstormBootstrapCheckpoint());
  assert.equal(bootstrapped.core_anchor, '');
});

test('checkpoint input rejects malformed known fields instead of coercing or dropping them', () => {
  const { normalizeCheckpoint, validateAgentConversationCheckpointInput } = handoverApi();
  const cases = [
    [{ coreAnchor: { goal: 'Preserve the live brainstorming anchor.' } }, /coreAnchor must be a string/u],
    [{ confirmedChoices: ['Keep the gate.', { choice: 'Invalid nested value.' }] }, /confirmedChoices must contain only strings/u],
    [{ findings: [{ finding: ['Invalid finding value.'] }] }, /finding must be a string/u],
    [{ findings: [{ reference: 'runtime evidence', digest: 'deadbeef' }] }, /finding digest must be null or 64 lowercase hexadecimal characters/u],
    [{ artifacts: [{ path: 42, sha256: 'a'.repeat(64) }] }, /artifact path must be a repository-relative string/u],
    [{ artifacts: [{ path: 'docs/approved-design.md', sha256: 'deadbeef' }] }, /artifact sha256 must be 64 lowercase hexadecimal characters/u],
    [{ coreAnchor: 'Camel case.', core_anchor: 'Snake case.' }, /must not include both coreAnchor and core_anchor/u],
  ];

  for (const [input, expected] of cases) {
    assert.throws(() => validateAgentConversationCheckpointInput(input), expected);
  }

  assert.doesNotThrow(() => validateAgentConversationCheckpointInput(normalizeCheckpoint(checkpoint())));
});

test('a brainstorming conversation registered without an explicit checkpoint never persists a literal "undefined" core anchor', t => {
  const root = fixture(t);
  const { ensureBrainstormingRegistration, readAgentConversationRegistry } = handoverApi();
  const registered = ensureBrainstormingRegistration(root, {
    runtime: 'codex', agentConversationId: 'bootstrap-anchor-conversation', now: 1_000,
  });
  const stored = readAgentConversationRegistry(root).conversations[registered.sourceKey];
  assert.equal(stored.checkpoint.core_anchor, '');
});

test('a brainstorming bootstrap cannot seal until the Core Anchor is recovered or explicitly recorded', t => {
  const root = fixture(t);
  const { ensureBrainstormingRegistration, sealAgentConversationHandover } = handoverApi();
  const identity = {
    runtime: 'codex', agentConversationId: 'missing-core-anchor', kind: 'brainstorming', now: 1_000,
  };
  ensureBrainstormingRegistration(root, identity);

  assert.throws(
    () => sealAgentConversationHandover(root, { ...identity, now: 2_000 }),
    /requires a Core Anchor before sealing/u,
  );
});

test('handover references canonical Work state and persists no duplicate lifecycle authority', t => {
  const root = fixture(t);
  const { registerAgentConversation, updateAgentConversationCheckpoint, sealAgentConversationHandover, handoverPaths } = handoverApi();
  registerAgentConversation(root, conversation());
  updateAgentConversationCheckpoint(root, { ...conversation(), checkpoint: checkpoint() });
  const sealed = sealAgentConversationHandover(root, conversation({ now: 2_000 }));
  const manifest = JSON.parse(fs.readFileSync(path.join(handoverPaths(root).directory, sealed.handoverId, 'manifest.json'), 'utf8'));

  assert.equal(manifest.pair_work.work_id, 'work-handover');
  assert.equal(manifest.pair_work.projection_path, '.pair/runs/work-handover/state.json');
  assert.match(manifest.pair_work.projection_sha256, /^[a-f0-9]{64}$/u);
  assert.equal(manifest.phase, undefined);
  assert.equal(manifest.attempt_id, undefined);
  assert.equal(loadPairState(root).active.phase, 'implementing');
});

test('brainstorming handover never captures an unrelated active Pair Work reference', t => {
  const root = fixture(t);
  const { handoverPaths, registerAgentConversation, sealAgentConversationHandover, updateAgentConversationCheckpoint } = handoverApi();
  const identity = conversation({ kind: 'brainstorming', agentConversationId: 'brainstorm-source' });
  registerAgentConversation(root, identity);
  updateAgentConversationCheckpoint(root, { ...identity, checkpoint: checkpoint() });
  const sealed = sealAgentConversationHandover(root, { ...identity, now: 2_000 });
  const manifest = JSON.parse(fs.readFileSync(path.join(handoverPaths(root).directory, sealed.handoverId, 'manifest.json'), 'utf8'));
  assert.equal(manifest.pair_work, null);
  takeoverWork(root, 'existing-pair-owner', 'codex');
  const adopted = handoverApi().adoptAgentConversationHandover(root, {
    handoverId: sealed.handoverId, runtime: 'claude', agentConversationId: 'fresh-brainstorm', now: 3_000,
  });
  assert.equal(adopted.status, 'adopted');
  assert.equal(loadPairState(root).continuation.owner_session_id, 'existing-pair-owner');
});

test('only a completed Stop advances activity and Pair Stop checkpoints final repository authority', t => {
  const root = fixture(t);
  const { readAgentConversationRegistry, recordAgentConversationStop, registerAgentConversation, updateAgentConversationCheckpoint } = handoverApi();
  const identity = conversation();
  const registered = registerAgentConversation(root, identity);
  updateAgentConversationCheckpoint(root, {
    ...identity,
    now: 2_000,
    checkpoint: checkpoint({ currentDirection: 'Pre-dispatch state.' }),
  });
  let stored = readAgentConversationRegistry(root).conversations[registered.sourceKey];
  assert.equal(stored.last_active_at, new Date(1_000).toISOString());

  appendPairEvent(root, {
    event: 'phase.progressed', workId: 'work-handover', attemptId: '1.1-handover',
    taskId: '1.1', phase: 'verifying',
  });
  recordAgentConversationStop(root, { ...identity, now: 3_000 });
  stored = readAgentConversationRegistry(root).conversations[registered.sourceKey];
  assert.equal(stored.last_active_at, new Date(3_000).toISOString());
  assert.equal(stored.checkpoint_revision, 2);
  assert.match(stored.checkpoint.current_direction, /verifying/u);
});

test('re-registering a sealed Agent Conversation preserves sealing and rejects another checkpoint', t => {
  const root = fixture(t);
  const { registerAgentConversation, updateAgentConversationCheckpoint, sealAgentConversationHandover, readAgentConversationRegistry } = handoverApi();
  registerAgentConversation(root, conversation());
  updateAgentConversationCheckpoint(root, { ...conversation(), checkpoint: checkpoint() });
  const sealed = sealAgentConversationHandover(root, conversation({ now: 2_000 }));

  registerAgentConversation(root, conversation({ now: 3_000 }));

  assert.equal(readAgentConversationRegistry(root).conversations[sealed.sourceKey].status, 'sealed');
  assert.throws(
    () => updateAgentConversationCheckpoint(root, { ...conversation({ now: 4_000 }), checkpoint: checkpoint({ nextAction: 'Must not replace the sealed checkpoint.' }) }),
    /warm and registered/i,
  );
});

test('a valid pre-marker registry migrates under lock and remains gated after restart', t => {
  const root = fixture(t);
  const {
    assessAgentConversationFreshness,
    handoverPaths,
    registerAgentConversation,
    updateAgentConversationCheckpoint,
  } = handoverApi();
  const registered = registerAgentConversation(root, conversation());
  updateAgentConversationCheckpoint(root, { ...conversation(), checkpoint: checkpoint() });
  const paths = handoverPaths(root);
  fs.rmSync(paths.registrations, { recursive: true, force: true });

  const assessment = assessAgentConversationFreshness(root, conversation({
    now: 1_000 + (60 * 60 * 1000),
  }));

  assert.equal(assessment.status, 'cold');
  assert.equal(fs.existsSync(path.join(paths.registrations, `${registered.sourceKey}.json`)), true);
});

test('registration commit interruption remains fail-closed and visible to freshness status', t => {
  const root = fixture(t);
  const { freshnessProjection, handoverPaths, readAgentConversationRegistry, registerAgentConversation } = handoverApi();
  registerAgentConversation(root, conversation());
  const paths = handoverPaths(root);
  fs.rmSync(paths.registry);

  assert.throws(() => readAgentConversationRegistry(root), /invalid Agent Conversation Handover registry/i);
  const projection = freshnessProjection(root, 2_000);
  assert.match(projection.warning, /state is unavailable.*fail closed/i);
  assert.deepEqual(projection.conversations, []);
});

test('registration transaction rolls back an uncommitted marker and recovers a committed missing marker after restart', t => {
  const root = fixture(t);
  const { handoverPaths, hasAgentConversationRegistration, readAgentConversationRegistry, registerAgentConversation } = handoverApi();
  const committed = registerAgentConversation(root, conversation({ agentConversationId: 'registered-before-snapshot' }));
  const paths = handoverPaths(root);
  const olderRegistry = fs.readFileSync(paths.registry);
  const uncommittedInput = conversation({ agentConversationId: 'marker-ahead-of-registry', now: 2_000 });
  const uncommitted = registerAgentConversation(root, uncommittedInput);
  fs.writeFileSync(paths.registry, olderRegistry);

  let recovered = readAgentConversationRegistry(root);
  assert.ok(recovered.conversations[committed.sourceKey]);
  assert.equal(recovered.conversations[uncommitted.sourceKey], undefined);
  assert.equal(fs.existsSync(path.join(paths.registrations, `${uncommitted.sourceKey}.json`)), false);
  assert.equal(hasAgentConversationRegistration(root, uncommittedInput), false);

  const committedMarker = path.join(paths.registrations, `${committed.sourceKey}.json`);
  fs.rmSync(committedMarker);
  recovered = readAgentConversationRegistry(root);
  assert.ok(recovered.conversations[committed.sourceKey]);
  assert.equal(fs.existsSync(committedMarker), true);
  assert.equal(hasAgentConversationRegistration(root, conversation({ agentConversationId: 'registered-before-snapshot' })), true);
});

test('registration never repairs a malformed or symlinked private marker', t => {
  const root = fixture(t);
  const { handoverPaths, registerAgentConversation } = handoverApi();
  const registered = registerAgentConversation(root, conversation());
  const marker = path.join(handoverPaths(root).registrations, `${registered.sourceKey}.json`);
  fs.writeFileSync(marker, '{malformed');
  assert.throws(() => registerAgentConversation(root, conversation({ now: 2_000 })), /registration marker/i);
  assert.equal(fs.readFileSync(marker, 'utf8'), '{malformed');

  fs.rmSync(marker);
  const outside = path.join(root, 'outside-registration-marker.json');
  fs.writeFileSync(outside, 'preserve-marker-target');
  fs.symlinkSync(outside, marker);
  assert.throws(() => registerAgentConversation(root, conversation({ now: 3_000 })), /registration marker/i);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'preserve-marker-target');
});

test('inconsistent sealed registry records fail closed before registration or checkpoint mutation', t => {
  const root = fixture(t);
  const { handoverPaths, registerAgentConversation, updateAgentConversationCheckpoint, sealAgentConversationHandover } = handoverApi();
  registerAgentConversation(root, conversation());
  updateAgentConversationCheckpoint(root, { ...conversation(), checkpoint: checkpoint() });
  const sealed = sealAgentConversationHandover(root, conversation({ now: 2_000 }));
  const registryFile = handoverPaths(root).registry;
  const registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
  registry.conversations[sealed.sourceKey].status = 'warm';
  fs.writeFileSync(registryFile, JSON.stringify(registry));

  assert.throws(() => registerAgentConversation(root, conversation({ now: 3_000 })), /invalid Agent Conversation Handover registry/i);
  assert.throws(() => updateAgentConversationCheckpoint(root, { ...conversation({ now: 3_000 }), checkpoint: checkpoint() }), /invalid Agent Conversation Handover registry/i);
});

test('missing corrupt stale traversal and digest mismatch fail closed without changing user files', t => {
  const root = fixture(t);
  const { adoptAgentConversationHandover, handoverPaths, registerAgentConversation, updateAgentConversationCheckpoint, sealAgentConversationHandover } = handoverApi();
  const unrelated = path.join(root, 'unrelated-user-file.txt');
  fs.writeFileSync(unrelated, 'preserve me');
  assert.throws(() => adoptAgentConversationHandover(root, { handoverId: 'handover-missing', runtime: 'codex', agentConversationId: 'fresh' }), /invalid handover/i);

  registerAgentConversation(root, conversation());
  updateAgentConversationCheckpoint(root, { ...conversation(), checkpoint: checkpoint() });
  const sealed = sealAgentConversationHandover(root, conversation({ now: 2_000 }));
  const checkpointFile = path.join(handoverPaths(root).directory, sealed.handoverId, 'checkpoint.md');
  fs.appendFileSync(checkpointFile, '\ncorrupt');
  assert.throws(() => adoptAgentConversationHandover(root, { handoverId: sealed.handoverId, runtime: 'codex', agentConversationId: 'fresh' }), /invalid handover/i);
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'preserve me');
  assert.throws(() => adoptAgentConversationHandover(root, { handoverId: '../outside', runtime: 'codex', agentConversationId: 'fresh' }), /invalid handover/i);
});

test('path-unsafe or digest-mismatched Pair Work references fail closed during adoption', t => {
  const root = fixture(t);
  const { handoverPaths, registerAgentConversation, updateAgentConversationCheckpoint, sealAgentConversationHandover, adoptAgentConversationHandover } = handoverApi();
  registerAgentConversation(root, conversation());
  updateAgentConversationCheckpoint(root, { ...conversation(), checkpoint: checkpoint() });
  const sealed = sealAgentConversationHandover(root, conversation({ now: 2_000 }));
  const manifestFile = path.join(handoverPaths(root).directory, sealed.handoverId, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  manifest.pair_work.projection_path = '../unrelated-user-file.txt';
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  assert.throws(() => adoptAgentConversationHandover(root, { handoverId: sealed.handoverId, runtime: 'codex', agentConversationId: 'fresh-path' }), /invalid handover/i);

  manifest.pair_work.projection_path = '.pair/runs/work-handover/state.json';
  manifest.pair_work.projection_sha256 = 'c'.repeat(64);
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  assert.throws(() => adoptAgentConversationHandover(root, { handoverId: sealed.handoverId, runtime: 'codex', agentConversationId: 'fresh-digest' }), /invalid handover/i);
});

test('non-Pair artifact drift fails closed before sealing and before adoption', t => {
  const root = fixture(t);
  const {
    adoptAgentConversationHandover,
    readAgentConversationRegistry,
    registerAgentConversation,
    sealAgentConversationHandover,
    updateAgentConversationCheckpoint,
  } = handoverApi();
  const identity = conversation({ kind: 'brainstorming', agentConversationId: 'artifact-bound-brainstorm' });
  const artifactPath = 'docs/approved-design.md';
  const absoluteArtifact = path.join(root, artifactPath);
  fs.mkdirSync(path.dirname(absoluteArtifact), { recursive: true });
  fs.writeFileSync(absoluteArtifact, 'approved revision one\n');
  const revisionOneDigest = crypto.createHash('sha256').update(fs.readFileSync(absoluteArtifact)).digest('hex');
  registerAgentConversation(root, identity);
  updateAgentConversationCheckpoint(root, {
    ...identity,
    checkpoint: checkpoint({ artifacts: [{ path: artifactPath, sha256: revisionOneDigest }] }),
  });

  fs.writeFileSync(absoluteArtifact, 'changed before sealing\n');
  assert.throws(
    () => sealAgentConversationHandover(root, { ...identity, now: 2_000 }),
    /artifact.*changed|changed.*artifact/iu,
  );
  let source = readAgentConversationRegistry(root).conversations[
    require(HANDOVER_MODULE).conversationIdentity(identity).sourceKey
  ];
  assert.equal(source.status, 'warm');
  assert.equal(source.sealed_handover_id, null);

  const currentDigest = crypto.createHash('sha256').update(fs.readFileSync(absoluteArtifact)).digest('hex');
  updateAgentConversationCheckpoint(root, {
    ...identity,
    now: 3_000,
    checkpoint: checkpoint({ artifacts: [{ path: artifactPath, sha256: currentDigest }] }),
  });
  const sealed = sealAgentConversationHandover(root, { ...identity, now: 4_000 });
  fs.writeFileSync(absoluteArtifact, 'changed after sealing\n');

  assert.throws(
    () => adoptAgentConversationHandover(root, {
      handoverId: sealed.handoverId,
      runtime: 'codex',
      agentConversationId: 'fresh-artifact-adopter',
      now: 5_000,
    }),
    /artifact.*changed|changed.*artifact/iu,
  );
  source = readAgentConversationRegistry(root).conversations[sealed.sourceKey];
  assert.equal(source.status, 'sealed');
});

test('private permissions and symlink resistance exclude forbidden fields and secret-like values', t => {
  const root = fixture(t);
  const { handoverPaths, registerAgentConversation, updateAgentConversationCheckpoint, sealAgentConversationHandover } = handoverApi();
  const identity = conversation({ kind: 'brainstorming', agentConversationId: 'secret-redaction-brainstorm' });
  const registered = registerAgentConversation(root, identity);
  const registrationMarker = path.join(handoverPaths(root).registrations, `${registered.sourceKey}.json`);
  assert.equal(fs.statSync(registrationMarker).mode & 0o077, 0, 'registration marker must be private');
  updateAgentConversationCheckpoint(root, {
    ...identity,
    checkpoint: checkpoint({
      nextAction: 'Use API_TOKEN=super-secret-canary only in memory.',
      currentDirection: 'Use gho_abcdefghijklmno, ghr_abcdefghijklmno, eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature, and capability_token=private-capability-canary only in memory.',
      artifacts: [],
    }),
  });
  const sealed = sealAgentConversationHandover(root, { ...identity, now: 2_000 });
  const directory = path.join(handoverPaths(root).directory, sealed.handoverId);
  const persisted = [
    fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'),
    fs.readFileSync(path.join(directory, 'checkpoint.md'), 'utf8'),
    fs.readFileSync(path.join(directory, 'events.jsonl'), 'utf8'),
  ].join('\n');
  assert.doesNotMatch(persisted, /super-secret-canary|gho_abcdefghijklmno|ghr_abcdefghijklmno|eyJhbGciOiJIUzI1NiJ9|private-capability-canary/i);
  const storedCheckpoint = JSON.parse(fs.readFileSync(path.join(directory, 'checkpoint.md'), 'utf8'));
  assert.deepEqual(storedCheckpoint.artifacts, []);
  for (const file of ['manifest.json', 'checkpoint.md', 'events.jsonl']) {
    assert.equal(fs.statSync(path.join(directory, file)).mode & 0o077, 0, `${file} must be private`);
  }
  const outside = path.join(root, 'outside.json');
  fs.writeFileSync(outside, '{}');
  fs.rmSync(path.join(directory, 'checkpoint.md'));
  fs.symlinkSync(outside, path.join(directory, 'checkpoint.md'));
  assert.throws(() => require(HANDOVER_MODULE).readAgentConversationHandover(root, sealed.handoverId), /invalid handover/i);
});

test('unknown secret-bearing registry claim keys fail closed without being rewritten', t => {
  const root = fixture(t);
  const { handoverPaths, readAgentConversationHandover, registerAgentConversation, sealAgentConversationHandover, updateAgentConversationCheckpoint } = handoverApi();
  registerAgentConversation(root, conversation());
  updateAgentConversationCheckpoint(root, { ...conversation(), checkpoint: checkpoint() });
  const sealed = sealAgentConversationHandover(root, conversation({ now: 2_000 }));
  const registryFile = handoverPaths(root).registry;
  const registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
  registry.handovers[sealed.handoverId].prompt = 'CLAIM_PROMPT_SECRET_CANARY';
  registry.handovers[sealed.handoverId].environment = { API_TOKEN: 'CLAIM_ENV_SECRET_CANARY' };
  fs.writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);
  const before = fs.readFileSync(registryFile, 'utf8');

  assert.throws(() => readAgentConversationHandover(root, sealed.handoverId), /invalid Agent Conversation Handover registry/iu);
  assert.equal(fs.readFileSync(registryFile, 'utf8'), before);
});

test('sealed checkpoint bytes stay within the 32 KiB persistence limit', t => {
  const root = fixture(t);
  const { handoverPaths, registerAgentConversation, updateAgentConversationCheckpoint, sealAgentConversationHandover, readAgentConversationHandover } = handoverApi();
  const identity = conversation({ kind: 'brainstorming', agentConversationId: 'large-brainstorm-checkpoint' });
  registerAgentConversation(root, identity);
  updateAgentConversationCheckpoint(root, {
    ...identity,
    checkpoint: checkpoint({
      findings: Array.from({ length: 64 }, (_value, index) => ({ reference: `evidence-${index}-${'x'.repeat(900)}`, digest: 'b'.repeat(64) })),
      confirmedChoices: Array.from({ length: 32 }, (_value, index) => `choice-${index}-${'x'.repeat(500)}`),
      rejectedAlternatives: Array.from({ length: 32 }, (_value, index) => `rejected-${index}-${'x'.repeat(500)}`),
    }),
  });
  const sealed = sealAgentConversationHandover(root, { ...identity, now: 2_000 });
  const checkpointFile = path.join(handoverPaths(root).directory, sealed.handoverId, 'checkpoint.md');
  assert.ok(fs.statSync(checkpointFile).size <= 32 * 1024);
  assert.doesNotThrow(() => readAgentConversationHandover(root, sealed.handoverId));
});

test('symlinked handover ancestors fail closed before registry writes', t => {
  const root = fixture(t);
  const outside = fs.mkdtempSync(path.join(path.dirname(root), 'handover-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const handovers = path.join(root, '.pair', 'handovers');
  fs.symlinkSync(outside, handovers);

  assert.throws(() => handoverApi().registerAgentConversation(root, conversation()), /symlink|handover/i);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('general handover policy cannot be enabled through a symlinked private handover directory', t => {
  const root = fixture(t);
  const outside = fs.mkdtempSync(path.join(path.dirname(root), 'handover-policy-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'policy.json'), `${JSON.stringify({
    schema: 1,
    general_agent_conversations: 'auto',
  })}\n`);
  fs.symlinkSync(outside, path.join(root, '.pair', 'handovers'));

  assert.throws(
    () => handoverApi().generalHandoverEnabled(root, {}),
    /invalid Agent Conversation Handover directory/u,
  );
});

test('atomic sealing recovery promotes committed staging and discards an unclaimed staging directory', t => {
  const root = fixture(t);
  const { handoverPaths, readAgentConversationRegistry, registerAgentConversation, sealAgentConversationHandover, updateAgentConversationCheckpoint } = handoverApi();
  registerAgentConversation(root, conversation());
  updateAgentConversationCheckpoint(root, { ...conversation(), checkpoint: checkpoint() });
  const sealed = sealAgentConversationHandover(root, conversation({ now: 2_000 }));
  const paths = handoverPaths(root);
  const finalDirectory = path.join(paths.directory, sealed.handoverId);
  const stagingDirectory = path.join(paths.directory, `.staging-${sealed.handoverId}`);
  fs.renameSync(finalDirectory, stagingDirectory);
  const registry = JSON.parse(fs.readFileSync(paths.registry, 'utf8'));
  registry.handovers[sealed.handoverId].stage_directory = path.basename(stagingDirectory);
  fs.writeFileSync(paths.registry, `${JSON.stringify(registry, null, 2)}\n`);
  const orphan = path.join(paths.directory, '.staging-handover-11111111-1111-4111-8111-111111111111');
  fs.mkdirSync(orphan, { mode: 0o700 });

  const recovered = readAgentConversationRegistry(root);

  assert.equal(fs.existsSync(finalDirectory), true, 'the committed claim is promoted to its immutable handover directory');
  assert.equal(fs.existsSync(stagingDirectory), false);
  assert.equal(fs.existsSync(orphan), false, 'an unclaimed pre-commit staging directory is discarded');
  assert.equal(recovered.handovers[sealed.handoverId].stage_directory, undefined);
  assert.equal(recovered.conversations[sealed.sourceKey].sealed_handover_id, sealed.handoverId);
});

test('single atomic adopter leaves the source retired after restart and exact one-shot override cannot repeat', async t => {
  const root = fixture(t);
  const { registerAgentConversation, updateAgentConversationCheckpoint, sealAgentConversationHandover, readAgentConversationRegistry, authorizeColdResume, completeColdResume } = handoverApi();
  registerAgentConversation(root, conversation());
  updateAgentConversationCheckpoint(root, { ...conversation(), checkpoint: checkpoint() });
  const sealed = sealAgentConversationHandover(root, conversation({ now: 2_000 }));
  const script = [
    `const handover = require(${JSON.stringify(HANDOVER_MODULE)});`,
    `try { handover.adoptAgentConversationHandover(${JSON.stringify(root)}, { handoverId: ${JSON.stringify(sealed.handoverId)}, runtime: 'codex', agentConversationId: process.argv[1], now: 3000 }); process.stdout.write('adopted'); } catch (error) { process.stdout.write(error.message); }`,
  ].join('\n');
  const results = await Promise.all(['fresh-one', 'fresh-two'].map(agentConversationId => new Promise((resolve, reject) => {
    const child = childProcess.spawn(process.execPath, ['-e', script, agentConversationId], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
  })));
  assert.equal(results.filter(result => result === 'adopted').length, 1);
  const registry = readAgentConversationRegistry(root);
  assert.equal(registry.conversations[sealed.sourceKey].status, 'retired');
  assert.throws(() => authorizeColdResume(root, { handoverId: sealed.handoverId, ...conversation({ now: 4_000 }), confirmCostRisk: true }), /invalid handover/i);
});

test('failed registry commit cannot append an audit event for an uncommitted cold-resume authorization', t => {
  const root = fixture(t);
  const { authorizeColdResume, handoverPaths, registerAgentConversation, sealAgentConversationHandover, updateAgentConversationCheckpoint } = handoverApi();
  const identity = conversation({ kind: 'brainstorming', agentConversationId: 'authorization-commit-failure' });
  registerAgentConversation(root, identity);
  updateAgentConversationCheckpoint(root, { ...identity, checkpoint: checkpoint() });
  const sealed = sealAgentConversationHandover(root, { ...identity, now: 2_000 });
  const paths = handoverPaths(root);
  const directory = path.join(paths.directory, sealed.handoverId);
  const registryBefore = fs.readFileSync(paths.registry);
  const eventsBefore = fs.readFileSync(path.join(directory, 'events.jsonl'));
  const renameSync = fs.renameSync;
  fs.renameSync = (source, destination) => {
    if (destination === paths.registry) throw new Error('simulated registry commit failure');
    return renameSync(source, destination);
  };
  try {
    assert.throws(() => authorizeColdResume(root, {
      ...identity, handoverId: sealed.handoverId, now: 3_000, confirmCostRisk: true,
    }), /simulated registry commit failure/u);
  } finally {
    fs.renameSync = renameSync;
  }
  assert.deepEqual(fs.readFileSync(paths.registry), registryBefore);
  assert.deepEqual(fs.readFileSync(path.join(directory, 'events.jsonl')), eventsBefore);
});

test('committed cold-resume authorization recovers its missing post-commit audit event', t => {
  const root = fixture(t);
  const { assessAgentConversationFreshness, authorizeColdResume, handoverPaths, registerAgentConversation, sealAgentConversationHandover, updateAgentConversationCheckpoint } = handoverApi();
  const identity = conversation({ kind: 'brainstorming', agentConversationId: 'authorization-event-recovery' });
  registerAgentConversation(root, identity);
  updateAgentConversationCheckpoint(root, { ...identity, checkpoint: checkpoint() });
  const sealed = sealAgentConversationHandover(root, { ...identity, now: 2_000 });
  authorizeColdResume(root, {
    ...identity, handoverId: sealed.handoverId, now: 3_000, confirmCostRisk: true,
  });
  const eventsFile = path.join(handoverPaths(root).directory, sealed.handoverId, 'events.jsonl');
  const sealedLine = fs.readFileSync(eventsFile, 'utf8').split('\n')[0];
  fs.writeFileSync(eventsFile, `${sealedLine}\n`);

  assert.equal(assessAgentConversationFreshness(root, { ...identity, now: 3_001 }).status, 'override-allowed');
  const events = fs.readFileSync(eventsFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.map(event => event.event), ['handover.sealed', 'cold-resume.authorized']);
});

test('audit event claiming an uncommitted transition makes the handover fail closed', t => {
  const root = fixture(t);
  const { handoverPaths, readAgentConversationHandover, registerAgentConversation, sealAgentConversationHandover, updateAgentConversationCheckpoint } = handoverApi();
  const identity = conversation({ kind: 'brainstorming', agentConversationId: 'uncommitted-audit-event' });
  registerAgentConversation(root, identity);
  updateAgentConversationCheckpoint(root, { ...identity, checkpoint: checkpoint() });
  const sealed = sealAgentConversationHandover(root, { ...identity, now: 2_000 });
  const eventsFile = path.join(handoverPaths(root).directory, sealed.handoverId, 'events.jsonl');
  fs.appendFileSync(eventsFile, `${JSON.stringify({
    event: 'cold-resume.authorized',
    at: new Date(3_000).toISOString(),
    source_key: sealed.sourceKey,
  })}\n`);

  assert.throws(() => readAgentConversationHandover(root, sealed.handoverId), /invalid handover/i);
});

test('one-shot override survives restart and has one atomic prompt winner', async t => {
  const root = fixture(t);
  const { authorizeColdResume, readAgentConversationRegistry, recordAgentConversationStop, registerAgentConversation, sealAgentConversationHandover, updateAgentConversationCheckpoint } = handoverApi();
  const identity = conversation({ kind: 'brainstorming', agentConversationId: 'override-race' });
  registerAgentConversation(root, identity);
  updateAgentConversationCheckpoint(root, { ...identity, checkpoint: checkpoint() });
  const sealed = sealAgentConversationHandover(root, { ...identity, now: 2_000 });
  authorizeColdResume(root, {
    ...identity, now: 3_000, handoverId: sealed.handoverId, confirmCostRisk: true,
  });
  assert.throws(() => recordAgentConversationStop(root, { ...identity, now: 3_001 }), /not consumed/i);

  const script = [
    `const handover = require(${JSON.stringify(HANDOVER_MODULE)});`,
    `const result = handover.assessAgentConversationFreshness(${JSON.stringify(root)}, { runtime: 'codex', agentConversationId: 'override-race', kind: 'brainstorming', now: Number(process.argv[1]) });`,
    `process.stdout.write(result.status);`,
  ].join('\n');
  const results = await Promise.all([3_100, 3_101].map(now => new Promise((resolve, reject) => {
    const child = childProcess.spawn(process.execPath, ['-e', script, String(now)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
  })));
  assert.equal(results.filter(status => status === 'override-allowed').length, 1);
  assert.equal(results.filter(status => status === 'override-consumed').length, 1);
  assert.equal(readAgentConversationRegistry(root).conversations[sealed.sourceKey].override.status, 'in-flight');
});

test('exact one-shot override is mutually exclusive with adoption and refreshes the retired source handover', t => {
  const root = fixture(t);
  const { FRESHNESS_WINDOW_MS, adoptAgentConversationHandover, assessAgentConversationFreshness, authorizeColdResume, completeColdResume, readAgentConversationRegistry, registerAgentConversation, sealAgentConversationHandover, updateAgentConversationCheckpoint } = handoverApi();
  registerAgentConversation(root, conversation());
  updateAgentConversationCheckpoint(root, { ...conversation(), checkpoint: checkpoint() });
  const sealed = sealAgentConversationHandover(root, conversation({ now: 2_000 }));

  assert.throws(() => authorizeColdResume(root, { handoverId: sealed.handoverId, ...conversation({ now: 4_000 }) }), /confirm/i);
  const override = authorizeColdResume(root, { handoverId: sealed.handoverId, ...conversation({ now: 4_000 }), confirmCostRisk: true });
  assert.equal(override.status, 'allowed-once');
  assert.throws(
    () => adoptAgentConversationHandover(root, { handoverId: sealed.handoverId, runtime: 'codex', agentConversationId: 'fresh-after-override', now: 4_500 }),
    /invalid handover/i,
  );
  assert.equal(assessAgentConversationFreshness(root, conversation({ now: 4_750 })).status, 'override-allowed');
  updateAgentConversationCheckpoint(root, {
    ...conversation({ now: 4_900 }),
    checkpoint: checkpoint({ nextAction: 'Continue from the one permitted cold turn.' }),
  });
  const completed = completeColdResume(root, {
    handoverId: sealed.handoverId,
    ...conversation({ now: 5_000 }),
  });
  assert.match(completed.refreshedHandoverId, /^handover-/u);
  assert.notEqual(completed.refreshedHandoverId, sealed.handoverId);
  assert.equal(readAgentConversationRegistry(root).conversations[sealed.sourceKey].status, 'retired');
  assert.throws(() => authorizeColdResume(root, { handoverId: sealed.handoverId, ...conversation({ now: 6_000 }), confirmCostRisk: true }), /already used/i);
  adoptAgentConversationHandover(root, {
    handoverId: completed.refreshedHandoverId,
    runtime: 'codex',
    agentConversationId: 'fresh-after-refreshed-handover',
    now: 7_000,
  });
  assert.equal(assessAgentConversationFreshness(root, {
    runtime: 'codex',
    agentConversationId: 'fresh-after-refreshed-handover',
    kind: 'pair',
    now: 7_000 + FRESHNESS_WINDOW_MS,
  }).status, 'cold', 'adoption of a refreshed handover retains the later Freshness Gate');
});

test('Pair Stop records an auditable override refresh when repository semantics are unchanged', t => {
  const root = fixture(t);
  const {
    assessAgentConversationFreshness,
    authorizeColdResume,
    derivePairCheckpoint,
    readAgentConversationRegistry,
    recordAgentConversationStop,
    registerAgentConversation,
    sealAgentConversationHandover,
    updateAgentConversationCheckpoint,
  } = handoverApi();
  const registered = registerAgentConversation(root, conversation());
  updateAgentConversationCheckpoint(root, {
    ...conversation(), checkpoint: derivePairCheckpoint(root),
  });
  const sealed = sealAgentConversationHandover(root, conversation({ now: 2_000 }));
  const authorizedRevision = readAgentConversationRegistry(root)
    .conversations[registered.sourceKey].checkpoint_revision;
  authorizeColdResume(root, {
    ...conversation({ now: 3_000 }), handoverId: sealed.handoverId, confirmCostRisk: true,
  });
  assert.equal(assessAgentConversationFreshness(root, conversation({ now: 3_001 })).status, 'override-allowed');

  const completed = recordAgentConversationStop(root, conversation({ now: 4_000 }));

  assert.equal(completed.status, 'retired');
  const source = readAgentConversationRegistry(root).conversations[registered.sourceKey];
  assert.ok(source.checkpoint_revision > authorizedRevision);
  assert.match(source.override.refreshed_at, /^\d{4}-\d{2}-\d{2}T/u);
});

test('sealColdAgentConversations seals an abandoned warm conversation without waiting for its own next prompt', t => {
  const root = fixture(t);
  const {
    FRESHNESS_WINDOW_MS,
    handoverPaths,
    readAgentConversationRegistry,
    registerAgentConversation,
    sealColdAgentConversations,
    updateAgentConversationCheckpoint,
  } = handoverApi();

  const staleIdentity = conversation({ kind: 'brainstorming', agentConversationId: 'abandoned-brainstorm', now: 1_000 });
  const stale = registerAgentConversation(root, staleIdentity);
  updateAgentConversationCheckpoint(root, { ...staleIdentity, checkpoint: checkpoint() });

  const freshIdentity = conversation({
    kind: 'brainstorming', agentConversationId: 'fresh-brainstorm', now: 1_000 + FRESHNESS_WINDOW_MS - 1,
  });
  const fresh = registerAgentConversation(root, freshIdentity);
  updateAgentConversationCheckpoint(root, { ...freshIdentity, checkpoint: checkpoint() });

  const emptyIdentity = conversation({
    kind: 'brainstorming', agentConversationId: 'checkpoint-null-brainstorm', now: 1_000,
  });
  const empty = registerAgentConversation(root, emptyIdentity);

  const now = 1_000 + FRESHNESS_WINDOW_MS;
  const result = sealColdAgentConversations(root, { now });

  assert.equal(result.sealed.length, 1);
  assert.equal(result.sealed[0].sourceKey, stale.sourceKey);
  assert.match(result.sealed[0].handoverId, /^handover-[a-f0-9-]{36}$/u);

  const registry = readAgentConversationRegistry(root);
  const staleConversation = registry.conversations[stale.sourceKey];
  assert.equal(staleConversation.status, 'sealed');
  assert.equal(staleConversation.sealed_handover_id, result.sealed[0].handoverId);
  assert.ok(registry.handovers[result.sealed[0].handoverId]);
  assert.equal(registry.handovers[result.sealed[0].handoverId].status, 'sealed');

  const directory = path.join(handoverPaths(root).directory, result.sealed[0].handoverId);
  assert.equal(fs.existsSync(path.join(directory, 'manifest.json')), true);
  assert.equal(fs.existsSync(path.join(directory, 'checkpoint.md')), true);
  assert.equal(fs.existsSync(path.join(directory, 'events.jsonl')), true);
  assert.equal(fs.existsSync(path.join(handoverPaths(root).directory, `.staging-${result.sealed[0].handoverId}`)), false);

  assert.equal(registry.conversations[fresh.sourceKey].status, 'warm', 'a warm and fresh conversation must be untouched');
  assert.equal(registry.conversations[empty.sourceKey].status, 'warm', 'a conversation with a null checkpoint must be skipped, not thrown');
  assert.equal(registry.conversations[empty.sourceKey].checkpoint, null);
});

test('sealColdAgentConversations tolerates a per-conversation sealing failure and still seals the others', t => {
  const root = fixture(t);
  const {
    FRESHNESS_WINDOW_MS,
    readAgentConversationRegistry,
    registerAgentConversation,
    sealColdAgentConversations,
    updateAgentConversationCheckpoint,
  } = handoverApi();

  const firstIdentity = conversation({ kind: 'brainstorming', agentConversationId: 'first-stale-brainstorm', now: 1_000 });
  const first = registerAgentConversation(root, firstIdentity);
  updateAgentConversationCheckpoint(root, { ...firstIdentity, checkpoint: checkpoint() });

  const secondIdentity = conversation({ kind: 'brainstorming', agentConversationId: 'second-stale-brainstorm', now: 1_000 });
  const second = registerAgentConversation(root, secondIdentity);
  updateAgentConversationCheckpoint(root, { ...secondIdentity, checkpoint: checkpoint() });

  const originalMkdirSync = fs.mkdirSync;
  let armed = true;
  fs.mkdirSync = (targetPath, options) => {
    if (armed && String(targetPath).includes('.staging-')) {
      armed = false;
      throw new Error('simulated staging directory failure');
    }
    return originalMkdirSync(targetPath, options);
  };
  let result;
  try {
    result = sealColdAgentConversations(root, { now: 1_000 + FRESHNESS_WINDOW_MS });
  } finally {
    fs.mkdirSync = originalMkdirSync;
  }

  assert.equal(result.sealed.length, 1, 'the second conversation seals even though the first failed');
  assert.equal(result.sealed[0].sourceKey, second.sourceKey);
  const registry = readAgentConversationRegistry(root);
  assert.equal(registry.conversations[first.sourceKey].status, 'warm', 'a failed seal must not leave a partial mutation');
  assert.equal(registry.conversations[second.sourceKey].status, 'sealed');
});

test('Stop on a registered brainstorming conversation enriches the checkpoint from Visual Companion state and does not bump again on a repeat Stop', t => {
  const root = fixture(t);
  const {
    brainstormBootstrapCheckpoint,
    readAgentConversationRegistry,
    recordAgentConversationStop,
    registerAgentConversation,
    updateAgentConversationCheckpoint,
  } = handoverApi();
  brainstormSessionFixture(t, root);

  const identity = conversation({ kind: 'brainstorming', agentConversationId: 'brainstorm-stop-conversation' });
  const registered = registerAgentConversation(root, identity);
  updateAgentConversationCheckpoint(root, {
    ...identity,
    checkpoint: {
      ...brainstormBootstrapCheckpoint(),
      coreAnchor: 'Preserve the approved Checkout revamp direction.',
    },
  });
  const bootstrapRevision = readAgentConversationRegistry(root).conversations[registered.sourceKey].checkpoint_revision;

  recordAgentConversationStop(root, { ...identity, now: 2_000 });
  const afterFirstStop = readAgentConversationRegistry(root).conversations[registered.sourceKey];
  assert.ok(afterFirstStop.checkpoint_revision > bootstrapRevision, 'the Stop-time derive must bump the checkpoint revision');
  assert.deepEqual(afterFirstStop.checkpoint.confirmed_choices, ['Choose the auth strategy: OAuth 2.0']);
  assert.deepEqual(afterFirstStop.checkpoint.unresolved_decisions, ['Choose the storage engine']);
  assert.match(afterFirstStop.checkpoint.current_direction, /^Brainstorming 'Checkout revamp' at revision abcd1234\.$/u);

  const revisionAfterFirstStop = afterFirstStop.checkpoint_revision;
  recordAgentConversationStop(root, { ...identity, now: 3_000 });
  const afterSecondStop = readAgentConversationRegistry(root).conversations[registered.sourceKey];
  assert.equal(afterSecondStop.checkpoint_revision, revisionAfterFirstStop, 'a second identical Stop against unchanged Visual Companion state must not bump the revision again');
  assert.equal(afterSecondStop.last_active_at, new Date(3_000).toISOString(), 'activity still advances even when the derived checkpoint is unchanged');
});

test('sealColdAgentConversations on a cold brainstorming conversation seals a handover whose checkpoint.md contains the derived confirmed_choices', t => {
  const root = fixture(t);
  const {
    FRESHNESS_WINDOW_MS,
    brainstormBootstrapCheckpoint,
    handoverPaths,
    registerAgentConversation,
    sealColdAgentConversations,
    updateAgentConversationCheckpoint,
  } = handoverApi();
  brainstormSessionFixture(t, root);

  const identity = conversation({ kind: 'brainstorming', agentConversationId: 'brainstorm-cold-conversation', now: 1_000 });
  registerAgentConversation(root, identity);
  updateAgentConversationCheckpoint(root, {
    ...identity,
    checkpoint: {
      ...brainstormBootstrapCheckpoint(),
      coreAnchor: 'Preserve the approved Checkout revamp direction.',
    },
  });

  const result = sealColdAgentConversations(root, { now: 1_000 + FRESHNESS_WINDOW_MS });
  assert.equal(result.sealed.length, 1);

  const directory = path.join(handoverPaths(root).directory, result.sealed[0].handoverId);
  const checkpointMarkdown = fs.readFileSync(path.join(directory, 'checkpoint.md'), 'utf8');
  assert.match(checkpointMarkdown, /Choose the auth strategy: OAuth 2\.0/u);

  const sealedCheckpoint = JSON.parse(checkpointMarkdown);
  assert.deepEqual(sealedCheckpoint.confirmed_choices, ['Choose the auth strategy: OAuth 2.0']);
  assert.deepEqual(sealedCheckpoint.unresolved_decisions, ['Choose the storage engine']);
});

test('sealColdAgentConversations still derives the checkpoint when the active-session pointer was already removed', t => {
  const root = fixture(t);
  const {
    FRESHNESS_WINDOW_MS,
    brainstormBootstrapCheckpoint,
    handoverPaths,
    registerAgentConversation,
    sealColdAgentConversations,
    updateAgentConversationCheckpoint,
  } = handoverApi();
  const session = brainstormSessionFixture(t, root, { pointer: false });

  const identity = conversation({ kind: 'brainstorming', agentConversationId: 'brainstorm-unpointered-conversation', now: 1_000 });
  registerAgentConversation(root, identity);
  updateAgentConversationCheckpoint(root, {
    ...identity,
    checkpoint: {
      ...brainstormBootstrapCheckpoint(),
      coreAnchor: 'Preserve the approved Checkout revamp direction.',
    },
  });

  const result = sealColdAgentConversations(root, { now: 1_000 + FRESHNESS_WINDOW_MS });
  assert.equal(result.sealed.length, 1);

  const directory = path.join(handoverPaths(root).directory, result.sealed[0].handoverId);
  const sealedCheckpoint = JSON.parse(fs.readFileSync(path.join(directory, 'checkpoint.md'), 'utf8'));
  assert.deepEqual(sealedCheckpoint.confirmed_choices, ['Choose the auth strategy: OAuth 2.0']);
  assert.match(sealedCheckpoint.next_action, /resume --session-dir /u);
  assert.ok(sealedCheckpoint.next_action.includes(session.sessionDir), 'the sealed handover must carry the resume path');
});

test('freshnessProjection warns about the most recently active conversation requiring a handover, not the first registered', t => {
  const root = fixture(t);
  const { freshnessProjection, registerAgentConversation, sealAgentConversationHandover, updateAgentConversationCheckpoint } = handoverApi();
  const older = conversation({ agentConversationId: 'stale-older-conversation', now: 1_000 });
  const newer = conversation({ agentConversationId: 'stale-newer-conversation', now: 2_000 });
  registerAgentConversation(root, older);
  updateAgentConversationCheckpoint(root, { ...older, checkpoint: checkpoint() });
  registerAgentConversation(root, newer);
  updateAgentConversationCheckpoint(root, { ...newer, checkpoint: checkpoint() });
  const olderSealed = sealAgentConversationHandover(root, { ...older, now: 3_000 });
  const newerSealed = sealAgentConversationHandover(root, { ...newer, now: 3_000 });

  const projection = freshnessProjection(root, 10_000);

  assert.ok(projection.warning.includes(newerSealed.handoverId), 'the warning must recommend the most recently active stale conversation');
  assert.ok(!projection.warning.includes(olderSealed.handoverId), 'the older stale conversation must not win the one-line warning');
});

test('formatFreshnessProjection scopes the banner to a provided currentSourceKey and stays byte-identical when absent', t => {
  const root = fixture(t);
  const { formatFreshnessProjection, freshnessProjection, registerAgentConversation, updateAgentConversationCheckpoint } = handoverApi();
  const current = conversation({ kind: 'brainstorming', agentConversationId: 'format-current-conversation' });
  const other = conversation({ kind: 'brainstorming', agentConversationId: 'format-other-conversation' });
  const registeredCurrent = registerAgentConversation(root, current);
  updateAgentConversationCheckpoint(root, { ...current, checkpoint: checkpoint() });
  registerAgentConversation(root, other);
  updateAgentConversationCheckpoint(root, { ...other, checkpoint: checkpoint() });

  const projection = freshnessProjection(root, 1_000);

  const legacy = formatFreshnessProjection(projection);
  assert.doesNotMatch(legacy, /this Agent Conversation|Freshness Gate \(other\)/u);
  assert.match(legacy, /^Freshness Gate codex\/brainstorming: warm\n {2}age/u);
  assert.equal((legacy.match(/^Freshness Gate codex\/brainstorming: warm$/gmu) || []).length, 2);

  const legacyCompact = formatFreshnessProjection(projection, { compact: true });
  assert.doesNotMatch(legacyCompact, /this Agent Conversation|Freshness Gate \(other\)/u);
  assert.match(legacyCompact, /^Freshness Gate codex\/brainstorming: warm \| age/u);

  const scoped = formatFreshnessProjection(projection, { currentSourceKey: registeredCurrent.sourceKey });
  const thisIndex = scoped.indexOf('Freshness Gate (this Agent Conversation)');
  const otherIndex = scoped.indexOf('Freshness Gate (other)');
  assert.equal(thisIndex, 0, 'the current conversation renders first');
  assert.ok(thisIndex < otherIndex);
  assert.match(scoped, / \| /u, 'the other conversation renders as one compact line');
  assert.match(scoped, /\n {2}age /u, 'the current conversation still renders its full multi-line block');

  const unregistered = formatFreshnessProjection(projection, { currentSourceKey: 'not-a-real-source-key' });
  assert.match(unregistered, /^Freshness Gate \(this Agent Conversation\): .*not registered.*does not gate/iu);
  assert.equal((unregistered.match(/Freshness Gate \(other\)/gu) || []).length, 2, 'both registered conversations render compactly when the current conversation is unregistered');
});
