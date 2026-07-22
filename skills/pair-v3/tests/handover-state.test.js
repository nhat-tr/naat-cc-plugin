const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const HANDOVER_MODULE = path.resolve(__dirname, '../scripts/lib/handover-state.js');
const { appendPairEvent, loadPairState } = require('../scripts/lib/pair-state');

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
    artifacts: [{ path: '.pair/plan.md', sha256: 'a'.repeat(64) }],
    ...overrides,
  };
}

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

test('private permissions and symlink resistance exclude forbidden fields and secret-like values', t => {
  const root = fixture(t);
  const { handoverPaths, registerAgentConversation, updateAgentConversationCheckpoint, sealAgentConversationHandover } = handoverApi();
  registerAgentConversation(root, conversation());
  updateAgentConversationCheckpoint(root, {
    ...conversation(),
    checkpoint: checkpoint({
      nextAction: 'Use API_TOKEN=super-secret-canary only in memory.',
      currentDirection: 'Use gho_abcdefghijklmno, ghr_abcdefghijklmno, eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature, and capability_token=private-capability-canary only in memory.',
      artifacts: [
        { path: '.pair/plan.md', sha256: 'a'.repeat(64) },
        { path: 'evidence/gho_abcdefghijklmno.json', sha256: 'b'.repeat(64) },
      ],
      transcript: 'never persist this transcript',
      compactSummary: 'never persist this compact summary',
      environment: { API_TOKEN: 'super-secret-canary' },
    }),
  });
  const sealed = sealAgentConversationHandover(root, conversation({ now: 2_000 }));
  const directory = path.join(handoverPaths(root).directory, sealed.handoverId);
  const persisted = [
    fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'),
    fs.readFileSync(path.join(directory, 'checkpoint.md'), 'utf8'),
    fs.readFileSync(path.join(directory, 'events.jsonl'), 'utf8'),
  ].join('\n');
  assert.doesNotMatch(persisted, /super-secret-canary|gho_abcdefghijklmno|ghr_abcdefghijklmno|eyJhbGciOiJIUzI1NiJ9|private-capability-canary|never persist this|compact summary|transcript/i);
  const storedCheckpoint = JSON.parse(fs.readFileSync(path.join(directory, 'checkpoint.md'), 'utf8'));
  assert.deepEqual(storedCheckpoint.artifacts, [{ path: '.pair/plan.md', sha256: 'a'.repeat(64) }]);
  for (const file of ['manifest.json', 'checkpoint.md', 'events.jsonl']) {
    assert.equal(fs.statSync(path.join(directory, file)).mode & 0o077, 0, `${file} must be private`);
  }
  const outside = path.join(root, 'outside.json');
  fs.writeFileSync(outside, '{}');
  fs.rmSync(path.join(directory, 'checkpoint.md'));
  fs.symlinkSync(outside, path.join(directory, 'checkpoint.md'));
  assert.throws(() => require(HANDOVER_MODULE).readAgentConversationHandover(root, sealed.handoverId), /invalid handover/i);
});

test('sealed checkpoint bytes stay within the 32 KiB persistence limit', t => {
  const root = fixture(t);
  const { handoverPaths, registerAgentConversation, updateAgentConversationCheckpoint, sealAgentConversationHandover, readAgentConversationHandover } = handoverApi();
  registerAgentConversation(root, conversation());
  updateAgentConversationCheckpoint(root, {
    ...conversation(),
    checkpoint: checkpoint({
      findings: Array.from({ length: 64 }, (_value, index) => ({ reference: `evidence-${index}-${'x'.repeat(900)}`, digest: 'b'.repeat(64) })),
      confirmedChoices: Array.from({ length: 32 }, (_value, index) => `choice-${index}-${'x'.repeat(500)}`),
      rejectedAlternatives: Array.from({ length: 32 }, (_value, index) => `rejected-${index}-${'x'.repeat(500)}`),
    }),
  });
  const sealed = sealAgentConversationHandover(root, conversation({ now: 2_000 }));
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

test('exact one-shot override is mutually exclusive with adoption and refreshes the retired source handover', t => {
  const root = fixture(t);
  const { adoptAgentConversationHandover, authorizeColdResume, completeColdResume, readAgentConversationRegistry, registerAgentConversation, sealAgentConversationHandover, updateAgentConversationCheckpoint } = handoverApi();
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
  const completed = completeColdResume(root, {
    handoverId: sealed.handoverId,
    ...conversation({ now: 5_000 }),
    checkpoint: checkpoint({ nextAction: 'Continue from the one permitted cold turn.' }),
  });
  assert.match(completed.refreshedHandoverId, /^handover-/u);
  assert.notEqual(completed.refreshedHandoverId, sealed.handoverId);
  assert.equal(readAgentConversationRegistry(root).conversations[sealed.sourceKey].status, 'retired');
  assert.throws(() => authorizeColdResume(root, { handoverId: sealed.handoverId, ...conversation({ now: 6_000 }), confirmCostRisk: true }), /already used/i);
});
