const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { SessionStore } = require('../scripts/session-store.cjs');
const { createScratchDirectory } = require('./test-support');
const { FakeClaudeChannelPeer } = require('./support/fake-claude-channel.cjs');

const repositoryRoot = path.resolve(__dirname, '../../..');
const agentDeliveryPath = path.resolve(__dirname, '../scripts/agent-conversation-delivery.cjs');
const codexAdapterPath = path.resolve(__dirname, '../scripts/codex-app-server-adapter.cjs');
const claudeChannelPath = path.resolve(__dirname, '../scripts/claude-channel-server.mjs');
const fakeCodexPath = path.resolve(__dirname, 'support/fake-codex-app-server.cjs');
const DELIVERY_LEDGER_FILE = 'agent-delivery-ledger.json';
const DELIVERY_STATE_FILE = 'delivery-state.json';
const PRIVATE_VALUE = 'adapter-integration-private-capability-value';

function optionalRequire(file) {
  try {
    return require(file);
  } catch (error) {
    if (error?.code === 'MODULE_NOT_FOUND'
      && String(error.message).startsWith(`Cannot find module '${file}'`)) return {};
    throw error;
  }
}

function feedbackBatch(sequence, overrides = {}) {
  return {
    version: 1,
    id: `feedback-event-${sequence}`,
    seq: sequence,
    timestamp: 1_725_000_000_000 + sequence,
    type: 'user.turn',
    role: 'user',
    clientTurnId: `browser-turn-${sequence}`,
    message: `Process Feedback Batch ${sequence}.`,
    annotations: [],
    choices: [],
    screen: { id: 'architecture', file: 'workspace.json', revision: 'a1b2c3d4' },
    ...overrides,
  };
}

function deliveryRequest(batch, overrides = {}) {
  return {
    runtime: 'codex',
    sessionId: 'visual-session-integration',
    conversationId: 'thread-integration',
    conversationState: 'idle',
    feedbackBatch: batch,
    ...overrides,
  };
}

function writeControl(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function readJsonLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readDeliveryLedger(stateDir) {
  return readJson(path.join(stateDir, DELIVERY_LEDGER_FILE));
}

function readDeliveryEvidence(stateDir, store) {
  const state = readJson(path.join(stateDir, DELIVERY_STATE_FILE));
  const snapshot = store.snapshot();
  const durableSeq = snapshot.events.filter(event => event.type === 'user.turn').at(-1)?.seq ?? null;
  return {
    durableSeq,
    deliveredThrough: state.deliveredThrough,
    acknowledgedThrough: Math.min(snapshot.cursor, durableSeq ?? 0),
  };
}

function assertPersistedDeliveryStateSecretSafe(stateDir) {
  assertSecretSafe(readDeliveryLedger(stateDir), stateDir);
  assertSecretSafe(readJson(path.join(stateDir, DELIVERY_STATE_FILE)), stateDir);
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate, label, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await delay(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function deterministicStore(t, purpose) {
  const stateDir = createScratchDirectory(t, purpose);
  let nextId = 0;
  return {
    stateDir,
    store: new SessionStore(stateDir, { randomUUID: () => `${purpose}-event-${++nextId}` }),
  };
}

function assertSecretSafe(value, scratchPath) {
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, new RegExp(PRIVATE_VALUE, 'u'));
  assert.doesNotMatch(
    serialized,
    new RegExp(scratchPath.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'),
  );
}

async function assertRejectedToolCall(call) {
  try {
    const result = await call;
    assert.equal(result?.isError, true, 'invalid acknowledgement must return an MCP tool error');
  } catch (error) {
    assert.match(String(error.message), /ack|delivery|unknown|invalid|queued|failed|session/i);
  }
}

function createClaudePeer(t, stateDir, options = {}) {
  const peer = new FakeClaudeChannelPeer({
    command: process.execPath,
    args: [
      claudeChannelPath,
      '--session-dir', stateDir,
      '--session-id', options.sessionId ?? 'visual-session-claude',
      '--conversation-id', options.conversationId ?? 'claude-conversation-open',
    ],
    cwd: repositoryRoot,
    env: {
      CLAUDE_SCRATCH_DIR: process.env.CLAUDE_SCRATCH_DIR || path.dirname(stateDir),
      BRAINSTORM_CAPABILITY_TOKEN: PRIVATE_VALUE,
    },
    allowlisted: options.allowlisted,
    orderingGuaranteed: options.orderingGuaranteed,
    supported: options.supported,
    timeoutMs: 2_000,
  });
  t.after(async () => {
    await peer.close();
    assert.doesNotMatch(peer.stderr, new RegExp(PRIVATE_VALUE, 'u'));
    assert.doesNotMatch(
      peer.stderr,
      new RegExp(stateDir.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'),
    );
  });
  return peer;
}

test('Codex App Server process handshakes, gates on resumed status, replays queues, and deduplicates after restart', async t => {
  const { AgentConversationDelivery } = optionalRequire(agentDeliveryPath);
  const { CodexAppServerAdapter } = optionalRequire(codexAdapterPath);
  assert.equal(typeof AgentConversationDelivery, 'function');
  assert.equal(typeof CodexAppServerAdapter, 'function');

  const scratch = createScratchDirectory(t, 'codex-app-server-integration');
  const logFile = path.join(scratch, 'app-server.jsonl');
  const controlFile = path.join(scratch, 'control.json');
  const stateDir = path.join(scratch, 'session-store');
  const sessionStore = new SessionStore(stateDir, {
    randomUUID: (() => {
      let nextId = 0;
      return () => `codex-worker-event-${++nextId}`;
    })(),
  });
  writeControl(controlFile, { available: true, threadState: 'idle' });

  function createAdapter() {
    const adapter = new CodexAppServerAdapter({
      command: process.execPath,
      args: [fakeCodexPath],
      cwd: repositoryRoot,
      env: {
        FAKE_CODEX_CONTROL_FILE: controlFile,
        FAKE_CODEX_LOG_FILE: logFile,
        PRIVATE_VALUE,
      },
      requestTimeoutMs: 1_000,
    });
    assert.equal(typeof adapter.close, 'function', 'process-backed adapter must expose bounded cleanup');
    t.after(() => adapter.close());
    return adapter;
  }

  const firstAdapter = createAdapter();
  const delivery = new AgentConversationDelivery({
    adapters: { codex: firstAdapter },
    sessionStore,
    stateDir,
  });
  assert.equal(typeof delivery.startWorker, 'function', 'idle delivery must expose a bounded Session Store worker');
  const worker = await delivery.startWorker({
    runtime: 'codex',
    sessionId: 'visual-session-integration',
    conversationId: 'thread-integration',
    conversationState: () => 'idle',
  });
  assert.equal(typeof worker?.close, 'function', 'Session Store worker must expose bounded cleanup');
  t.after(() => worker.close());
  const firstTurn = sessionStore.appendBrowserTurn({
    clientTurnId: 'codex-worker-persisted-1',
    message: 'Wake the idle Codex thread from this persisted Feedback Batch.',
  });
  await waitFor(
    () => {
      if (!fs.existsSync(path.join(stateDir, DELIVERY_LEDGER_FILE))
        || !fs.existsSync(path.join(stateDir, DELIVERY_STATE_FILE))) return false;
      const record = readDeliveryLedger(stateDir).deliveries.find(value => value.feedbackSeq === firstTurn.seq);
      const evidence = readDeliveryEvidence(stateDir, sessionStore);
      return record?.state === 'delivered' && evidence.deliveredThrough === firstTurn.seq;
    },
    'durably committed automatic Codex delivery from Session Store',
  );
  await worker.close();

  const firstRequest = deliveryRequest(firstTurn);
  const first = await delivery.deliver(firstRequest);
  assert.equal(first.state, 'delivered');

  const secondTurn = sessionStore.appendBrowserTurn({ clientTurnId: 'codex-queued-2', message: 'Second.' });
  const thirdTurn = sessionStore.appendBrowserTurn({ clientTurnId: 'codex-queued-3', message: 'Third.' });
  writeControl(controlFile, { available: true, threadState: 'active' });
  const thirdQueued = await delivery.deliver(deliveryRequest(thirdTurn));
  const secondQueued = await delivery.deliver(deliveryRequest(secondTurn));
  const duplicateSecond = await delivery.deliver(deliveryRequest(structuredClone(secondTurn)));
  assert.equal(thirdQueued.state, 'queued');
  assert.equal(secondQueued.state, 'queued');
  assert.equal(duplicateSecond.deliveryId, secondQueued.deliveryId);
  assert.match(`${thirdQueued.reason} ${secondQueued.reason}`, /active/i);
  assert.equal(readDeliveryEvidence(stateDir, sessionStore).deliveredThrough, firstTurn.seq);

  writeControl(controlFile, { available: true, threadState: 'idle' });
  const replayed = await delivery.flush({ runtime: 'codex' });
  assert.equal(replayed.delivered, 2);
  assert.equal(readDeliveryEvidence(stateDir, sessionStore).deliveredThrough, thirdTurn.seq);

  const fourthTurn = sessionStore.appendBrowserTurn({ clientTurnId: 'codex-unavailable-4', message: 'Fourth.' });
  writeControl(controlFile, { available: false, threadState: 'idle' });
  const unavailable = await delivery.deliver(deliveryRequest(fourthTurn));
  assert.equal(unavailable.state, 'queued');
  assert.match(unavailable.reason, /adapter|app.server|delivery|unavailable/i);
  assertSecretSafe(unavailable, scratch);
  writeControl(controlFile, { available: true, threadState: 'idle' });
  assert.equal((await delivery.flush({ runtime: 'codex' })).delivered, 1);
  assert.equal(readDeliveryEvidence(stateDir, sessionStore).deliveredThrough, fourthTurn.seq);
  assertPersistedDeliveryStateSecretSafe(stateDir);

  await firstAdapter.close();
  const restartedCallsBefore = readJsonLines(logFile).filter(entry => (
    entry.direction === 'client-to-server' && entry.message.method === 'turn/start'
  )).length;
  const restarted = new AgentConversationDelivery({
    adapters: { codex: createAdapter() },
    stateDir,
  });
  const duplicateAfterRestart = await restarted.deliver(structuredClone(firstRequest));
  assert.equal(duplicateAfterRestart.deliveryId, first.deliveryId);
  assert.equal(duplicateAfterRestart.state, 'delivered');
  assert.equal(
    readJsonLines(logFile).filter(entry => (
      entry.direction === 'client-to-server' && entry.message.method === 'turn/start'
    )).length,
    restartedCallsBefore,
    'durable ledger, not clientUserMessageId alone, suppresses a process-restart retry',
  );

  const messages = readJsonLines(logFile)
    .filter(entry => entry.direction === 'client-to-server')
    .map(entry => entry.message);
  assert.deepEqual(messages.slice(0, 4).map(message => message.method), [
    'initialize',
    'initialized',
    'thread/resume',
    'turn/start',
  ]);
  assert.equal(typeof messages[0].params.clientInfo.name, 'string');
  assert.ok(messages[0].params.clientInfo.name);
  const turns = messages.filter(message => message.method === 'turn/start');
  assert.deepEqual(turns.map(message => message.params.clientUserMessageId), [
    first.deliveryId,
    secondQueued.deliveryId,
    thirdQueued.deliveryId,
    unavailable.deliveryId,
  ]);
  assert.deepEqual(turns.map(message => message.params.input[0].type), ['text', 'text', 'text', 'text']);
});

test('Claude Channel unsupported and failed deliveries remain durably queued and reject premature or cross-session acknowledgement', async t => {
  const { AgentConversationDelivery } = optionalRequire(agentDeliveryPath);
  assert.equal(typeof AgentConversationDelivery, 'function');
  const firstSession = deterministicStore(t, 'claude-durable-queue-a');
  const blockedPeer = createClaudePeer(t, firstSession.stateDir, { allowlisted: false });
  const initialized = await blockedPeer.connect();
  assert.deepEqual(initialized.capabilities?.experimental?.['claude/channel'], {});
  assert.deepEqual(blockedPeer.capability(), {
    supported: false,
    reason: 'channel_not_allowlisted',
  });
  await blockedPeer.close();
  const firstTurn = firstSession.store.appendBrowserTurn({ clientTurnId: 'queued-1', message: 'First.' });
  const secondTurn = firstSession.store.appendBrowserTurn({ clientTurnId: 'queued-2', message: 'Second.' });
  const thirdTurn = firstSession.store.appendBrowserTurn({
    clientTurnId: 'queued-3',
    message: `${PRIVATE_VALUE} /private/path prompt`,
  });
  const blocked = new AgentConversationDelivery({
    adapters: {
      claude: {
        capability: () => blockedPeer.capability(),
        deliver: async () => { throw new Error('blocked peer must not be invoked'); },
      },
    },
    sessionStore: firstSession.store,
    stateDir: firstSession.stateDir,
  });

  const secondQueued = await blocked.deliver(deliveryRequest(secondTurn, { runtime: 'claude' }));
  const firstQueued = await blocked.deliver(deliveryRequest(firstTurn, { runtime: 'claude' }));
  const duplicate = await blocked.deliver(deliveryRequest(structuredClone(firstTurn), { runtime: 'claude' }));
  assert.equal(secondQueued.state, 'queued');
  assert.equal(firstQueued.state, 'queued');
  assert.equal(duplicate.deliveryId, firstQueued.deliveryId);
  assert.match(`${firstQueued.reason} ${secondQueued.reason}`, /allowlist|unsupported|unavailable/i);
  await assert.rejects(
    blocked.ackFeedback({ deliveryId: firstQueued.deliveryId, message: 'Must not acknowledge queued work.' }),
    /ack|delivery|queued|not delivered/i,
  );

  const failed = new AgentConversationDelivery({
    adapters: {
      claude: {
        capability: () => ({ supported: true, reason: null }),
        deliver: async () => { throw new Error(`${PRIVATE_VALUE} /private/path prompt`); },
      },
    },
    sessionStore: firstSession.store,
    stateDir: firstSession.stateDir,
  });
  const failedAttempt = await failed.deliver(deliveryRequest(thirdTurn, { runtime: 'claude' }));
  assert.equal(failedAttempt.state, 'queued');
  assertSecretSafe(failedAttempt, firstSession.stateDir);
  await assert.rejects(
    failed.ackFeedback({ deliveryId: failedAttempt.deliveryId, message: 'Must not acknowledge a failed attempt.' }),
    /ack|delivery|queued|failed|not delivered/i,
  );
  assertPersistedDeliveryStateSecretSafe(firstSession.stateDir);

  const deliveredSequences = [];
  const ready = new AgentConversationDelivery({
    adapters: {
      claude: {
        capability: () => ({ supported: true, reason: null }),
        deliver: async request => {
          deliveredSequences.push(request.feedbackBatch.seq);
          return { state: 'delivered' };
        },
      },
    },
    sessionStore: firstSession.store,
    stateDir: firstSession.stateDir,
  });
  const replay = await ready.flush({ runtime: 'claude' });
  assert.equal(replay.delivered, 3);
  assert.deepEqual(deliveredSequences, [firstTurn.seq, secondTurn.seq, thirdTurn.seq]);
  assert.equal(readDeliveryEvidence(firstSession.stateDir, firstSession.store).deliveredThrough, thirdTurn.seq);
  assertPersistedDeliveryStateSecretSafe(firstSession.stateDir);

  const secondSession = deterministicStore(t, 'claude-durable-queue-b');
  const otherDelivery = new AgentConversationDelivery({
    adapters: {},
    sessionStore: secondSession.store,
    stateDir: secondSession.stateDir,
  });
  await assert.rejects(
    otherDelivery.ackFeedback({ deliveryId: firstQueued.deliveryId, message: 'Cross-session acknowledgement.' }),
    /ack|delivery|unknown|session/i,
  );
  await assert.rejects(
    ready.ackFeedback({ deliveryId: 'unknown-delivery-id', message: 'Unknown acknowledgement.' }),
    /ack|delivery|unknown/i,
  );

  const afterRestart = new AgentConversationDelivery({
    adapters: {
      claude: {
        capability: () => ({ supported: true, reason: null }),
        deliver: async request => { deliveredSequences.push(request.feedbackBatch.seq); },
      },
    },
    sessionStore: firstSession.store,
    stateDir: firstSession.stateDir,
  });
  const durableDuplicate = await afterRestart.deliver(deliveryRequest(firstTurn, { runtime: 'claude' }));
  assert.equal(durableDuplicate.deliveryId, firstQueued.deliveryId);
  assert.equal(durableDuplicate.state, 'delivered');
  assert.deepEqual(deliveredSequences, [firstTurn.seq, secondTurn.seq, thirdTurn.seq]);
});

test('Claude Channel stdio notification requires explicit ack_feedback before publishing Reply', async t => {
  assert.equal(fs.existsSync(claudeChannelPath), true, 'Claude Channel production entrypoint must exist');
  const session = deterministicStore(t, 'claude-channel-ack');
  const peer = createClaudePeer(t, session.stateDir);
  const initialized = await peer.connect();
  assert.deepEqual(initialized.capabilities, {
    experimental: { 'claude/channel': {} },
    tools: {},
  });
  const listed = await peer.listTools();
  const ackTool = listed.tools.find(tool => tool.name === 'ack_feedback');
  assert.ok(ackTool, 'Claude Channel must expose ack_feedback');
  assert.deepEqual(new Set(ackTool.inputSchema.required), new Set(['deliveryId', 'message']));

  const turn = session.store.appendBrowserTurn({
    clientTurnId: 'claude-explicit-ack-1',
    message: 'Do not publish a Reply until tool acknowledgement.',
  });
  const notification = await peer.waitForNotification('notifications/claude/channel');
  assert.equal(typeof notification.params.content, 'string');
  assert.match(notification.params.content, /claude-explicit-ack-1/u);
  assert.deepEqual(notification.params.meta.feedback_seq, String(turn.seq));
  const deliveryId = notification.params.meta.delivery_id;
  assert.equal(typeof deliveryId, 'string');
  assert.ok(deliveryId);
  await waitFor(() => (
    fs.existsSync(path.join(session.stateDir, DELIVERY_STATE_FILE))
      && readDeliveryEvidence(session.stateDir, session.store).deliveredThrough === turn.seq
  ), 'Claude Channel delivered evidence');

  assert.equal(session.store.readCursor(), 0, 'notification transport success is not processing acknowledgement');
  assert.equal(session.store.snapshot().events.filter(event => event.type === 'agent.message').length, 0);
  const acknowledged = await peer.callTool('ack_feedback', {
    deliveryId,
    message: 'Feedback Batch processed by the Claude conversation.',
  });
  assert.notEqual(acknowledged.isError, true);
  await waitFor(() => session.store.readCursor() === turn.seq, 'Claude Channel Reply acknowledgement');
  assert.equal(readDeliveryEvidence(session.stateDir, session.store).acknowledgedThrough, turn.seq);
  assert.equal(session.store.snapshot().events.filter(event => event.type === 'agent.message').length, 1);

  const duplicateAck = await peer.callTool('ack_feedback', {
    deliveryId,
    message: 'Duplicate acknowledgement must stay idempotent.',
  });
  assert.notEqual(duplicateAck.isError, true);
  assert.equal(session.store.snapshot().events.filter(event => event.type === 'agent.message').length, 1);
  await assertRejectedToolCall(peer.callTool('ack_feedback', {
    deliveryId: 'unknown-or-cross-session-delivery',
    message: 'Reject this acknowledgement.',
  }));
});

test('Claude Channel replays a silently unacknowledged notification after peer death and preserves Feedback Batch order', async t => {
  assert.equal(fs.existsSync(claudeChannelPath), true, 'Claude Channel production entrypoint must exist');
  const session = deterministicStore(t, 'claude-channel-recovery');
  const first = session.store.appendBrowserTurn({ clientTurnId: 'recovery-first', message: 'First.' });
  const second = session.store.appendBrowserTurn({ clientTurnId: 'recovery-second', message: 'Second.' });
  const third = session.store.appendBrowserTurn({ clientTurnId: 'recovery-third', message: 'Third.' });

  const firstPeer = createClaudePeer(t, session.stateDir);
  await firstPeer.connect();
  const silent = await firstPeer.waitForNotification('notifications/claude/channel');
  assert.equal(silent.params.meta.feedback_seq, String(first.seq));
  const firstDeliveryId = silent.params.meta.delivery_id;
  await waitFor(() => (
    fs.existsSync(path.join(session.stateDir, DELIVERY_STATE_FILE))
      && readDeliveryEvidence(session.stateDir, session.store).deliveredThrough === first.seq
  ), 'silent Claude Channel delivered evidence');
  await assert.rejects(
    firstPeer.waitForNotification(
      'notifications/claude/channel',
      params => params.meta?.delivery_id === firstDeliveryId,
      150,
    ),
    /timed out/i,
    'one live peer must not receive a retry loop before its acknowledgement outcome is known',
  );
  await firstPeer.crash();
  assert.equal(session.store.readCursor(), 0);

  const recoveredPeer = createClaudePeer(t, session.stateDir);
  await recoveredPeer.connect();
  const replayed = await recoveredPeer.waitForNotification('notifications/claude/channel');
  assert.equal(replayed.params.meta.delivery_id, firstDeliveryId);
  assert.equal(replayed.params.meta.feedback_seq, String(first.seq));
  await recoveredPeer.callTool('ack_feedback', { deliveryId: firstDeliveryId, message: 'First recovered.' });

  const secondNotification = await recoveredPeer.waitForNotification('notifications/claude/channel');
  assert.equal(secondNotification.params.meta.feedback_seq, String(second.seq));
  await recoveredPeer.callTool('ack_feedback', {
    deliveryId: secondNotification.params.meta.delivery_id,
    message: 'Second processed.',
  });
  const thirdNotification = await recoveredPeer.waitForNotification('notifications/claude/channel');
  assert.equal(thirdNotification.params.meta.feedback_seq, String(third.seq));
  await recoveredPeer.callTool('ack_feedback', {
    deliveryId: thirdNotification.params.meta.delivery_id,
    message: 'Third processed.',
  });

  await waitFor(() => session.store.readCursor() === third.seq, 'ordered Claude Channel acknowledgements');
  assert.equal(readDeliveryEvidence(session.stateDir, session.store).acknowledgedThrough, third.seq);
  assert.deepEqual(
    session.store.snapshot().events.filter(event => event.type === 'agent.message').map(event => event.replyTo),
    [first.seq, second.seq, third.seq],
  );
});
