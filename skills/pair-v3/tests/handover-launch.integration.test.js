const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const task = require('../scripts/pair-task');
const handover = require('../scripts/lib/handover-state');
const { appendPairEvent } = require('../scripts/lib/pair-state');

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
    checkpoint: { purpose: 'Protect the bounded handover.', currentDirection: 'Launch fresh.', nextAction: 'Adopt.' },
  });
  return { source, sealed: handover.sealAgentConversationHandover(root, { ...source, now: 2_000 }) };
}

test('plain provider-affine fresh launch uses no resume or fork argv', t => {
  const root = fixture(t);
  const { sealed } = sealedHandover(root, 'codex');
  const spawned = [];
  const result = task.launchFreshAgentConversation(root, {
    handoverId: sealed.handoverId, runtime: 'auto', available: ['codex', 'claude'],
  }, {
    spawn(command, args, options) { spawned.push({ command, args, options }); return { pid: 42, unref() {} }; },
    nested: false,
  });
  assert.equal(result.runtime, 'codex');
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].command, 'codex');
  assert.ok(spawned[0].args.every(arg => !/--(?:resume|continue|fork(?:-session)?)(?:=|\b)/iu.test(arg)));
  assert.match(spawned[0].args.join(' '), new RegExp(sealed.handoverId));
});

test('explicit cross-provider launch requires an explicit runtime choice', t => {
  const root = fixture(t);
  const { sealed } = sealedHandover(root, 'codex');
  const spawned = [];
  const result = task.launchFreshAgentConversation(root, {
    handoverId: sealed.handoverId, runtime: 'claude', available: ['codex', 'claude'],
  }, {
    spawn(command, args) { spawned.push({ command, args }); return { pid: 43, unref() {} }; },
    nested: false,
  });
  assert.equal(result.runtime, 'claude');
  assert.equal(spawned[0].command, 'claude');
});

test('manual adoption fallback atomically transfers ownership and cannot cross-adopt', t => {
  const root = fixture(t);
  const { sealed } = sealedHandover(root, 'claude');
  const adopted = task.adoptFreshAgentConversation(root, {
    handoverId: sealed.handoverId, runtime: 'claude', agentConversationId: 'fresh-claude', now: 3_000,
  });
  assert.equal(adopted.status, 'adopted');
  assert.equal(handover.readAgentConversationRegistry(root).conversations[adopted.sourceKey].status, 'retired');
  assert.throws(() => task.adoptFreshAgentConversation(root, {
    handoverId: sealed.handoverId, runtime: 'codex', agentConversationId: 'cross-runtime-fresh', now: 4_000,
  }), /adopted|invalid handover/i);
});

test('rejects resume and fork argv and rejects nested runtime launch', t => {
  assert.throws(() => task.assertPlainFreshRuntimeCommand('codex', ['--resume', 'bad']), /resume|fork/i);
  assert.throws(() => task.assertPlainFreshRuntimeCommand('claude', ['--fork-session', 'bad']), /resume|fork/i);
  const root = fixture(t);
  const { sealed } = sealedHandover(root);
  assert.throws(() => task.launchFreshAgentConversation(root, {
    handoverId: sealed.handoverId, runtime: 'auto', available: ['codex'],
  }, { nested: true }), /nested/i);
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

test('exact one-shot cost-risk override refreshes checkpoint and returns source to retired', t => {
  const root = fixture(t);
  const { source, sealed } = sealedHandover(root);
  assert.throws(() => task.authorizeOneShotColdResume(root, {
    handoverId: sealed.handoverId, ...source, now: 3_000,
  }), /--once.*--confirm-cost-risk/i);
  const allowed = task.authorizeOneShotColdResume(root, {
    handoverId: sealed.handoverId, ...source, now: 3_000, once: true, confirmCostRisk: true,
  });
  assert.equal(allowed.status, 'allowed-once');
  assert.equal(handover.assessAgentConversationFreshness(root, { ...source, now: 3_001 }).status, 'warm');
  const completed = handover.recordAgentConversationStop(root, { ...source, now: 4_000 });
  assert.equal(completed.status, 'retired');
  assert.match(completed.refreshedHandoverId, /^handover-/u);
  assert.equal(handover.readAgentConversationRegistry(root).conversations[sealed.sourceKey].status, 'retired');
  assert.throws(() => task.authorizeOneShotColdResume(root, {
    handoverId: sealed.handoverId, ...source, now: 5_000, once: true, confirmCostRisk: true,
  }), /already used|invalid handover/i);
});
