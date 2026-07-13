const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { SessionStore } = require('../scripts/session-store.cjs');
const { createScratchDirectory } = require('./test-support');

const agentDeliveryPath = path.resolve(__dirname, '../scripts/agent-conversation-delivery.cjs');
const codexAdapterPath = path.resolve(__dirname, '../scripts/codex-app-server-adapter.cjs');
const claudeChannelPath = path.resolve(__dirname, '../scripts/claude-channel-server.mjs');

function optionalRequire(file) {
  try {
    return require(file);
  } catch (error) {
    if (error?.code === 'MODULE_NOT_FOUND'
      && String(error.message).startsWith(`Cannot find module '${file}'`)) return {};
    throw error;
  }
}

async function optionalImport(file) {
  try {
    return await import(file);
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND'
      && String(error.message).includes(`Cannot find module '${file}'`)) return {};
    throw error;
  }
}

function feedbackBatch(overrides = {}) {
  return {
    version: 1,
    id: 'feedback-event-7',
    seq: 7,
    timestamp: 1_725_000_000_000,
    type: 'user.turn',
    role: 'user',
    clientTurnId: 'browser-turn-7',
    message: 'Apply the selected architecture boundary.',
    annotations: [],
    choices: [],
    screen: { id: 'architecture', file: 'workspace.json', revision: 'a1b2c3d4' },
    ...overrides,
  };
}

function deliveryRequest(overrides = {}) {
  return {
    runtime: 'codex',
    sessionId: 'visual-session-123',
    conversationId: 'thread-123',
    conversationState: 'idle',
    feedbackBatch: feedbackBatch(),
    ...overrides,
  };
}

function createSessionStore(t, purpose, eventPrefix) {
  let next = 0;
  return new SessionStore(createScratchDirectory(t, purpose), {
    randomUUID: () => `${eventPrefix}-${++next}`,
  });
}

test('delivery identity is stable, event-specific, and contains no conversation content or secrets', () => {
  const { createDeliveryIdentity } = optionalRequire(agentDeliveryPath);
  assert.equal(typeof createDeliveryIdentity, 'function');
  const privateMessage = 'private prompt capability-token /private-fixture/session';
  const request = deliveryRequest({ feedbackBatch: feedbackBatch({ message: privateMessage }) });

  const first = createDeliveryIdentity(request);
  const retry = createDeliveryIdentity(structuredClone(request));
  const otherEvent = createDeliveryIdentity({
    ...request,
    feedbackBatch: feedbackBatch({ id: 'feedback-event-8', seq: 8, message: privateMessage }),
  });
  const otherSession = createDeliveryIdentity({ ...request, sessionId: 'visual-session-456' });
  const otherRuntime = createDeliveryIdentity({ ...request, runtime: 'claude' });
  const otherConversation = createDeliveryIdentity({ ...request, conversationId: 'thread-456' });

  assert.equal(typeof first, 'string');
  assert.ok(first.length >= 16, 'delivery identity is an opaque durable identifier');
  assert.equal(retry, first);
  assert.notEqual(otherEvent, first);
  assert.notEqual(otherSession, first);
  assert.notEqual(otherRuntime, first);
  assert.notEqual(otherConversation, first);
  assert.doesNotMatch(first, /private prompt|capability-token|\/Users\/private/u);
});

test('Codex adapter trusts the observed thread/resume status and never spawns a CLI resume', async () => {
  const { CodexAppServerAdapter } = optionalRequire(codexAdapterPath);
  assert.equal(typeof CodexAppServerAdapter, 'function');
  const calls = [];
  const spawnCalls = [];
  const adapter = new CodexAppServerAdapter({
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === 'thread/resume') {
        return { thread: { id: params.threadId, status: { type: 'idle' } } };
      }
      if (method === 'turn/start') return { turn: { id: 'turn-1', status: 'inProgress' } };
      throw new Error(`unexpected app-server method ${method}`);
    },
    spawn: (...args) => {
      spawnCalls.push(args);
      throw new Error('the App Server adapter must not spawn or impersonate a CLI session');
    },
  });
  const request = {
    deliveryId: 'delivery-stable-7',
    threadId: 'thread-123',
    threadState: 'idle',
    feedbackBatch: feedbackBatch(),
  };

  const result = await adapter.deliver(request);

  assert.equal(result.state, 'delivered');
  assert.deepEqual(calls.map(call => call.method), ['thread/resume', 'turn/start']);
  assert.deepEqual(calls[0].params, { threadId: 'thread-123' });
  assert.equal(calls[1].params.threadId, 'thread-123');
  assert.equal(calls[1].params.clientUserMessageId, 'delivery-stable-7');
  assert.deepEqual(calls[1].params.input.map(item => item.type), ['text']);
  assert.match(calls[1].params.input[0].text, /delivery-stable-7/u);
  assert.match(calls[1].params.input[0].text, /browser-turn-7/u);
  assert.match(calls[1].params.input[0].text, /Apply the selected architecture boundary/u);
  assert.deepEqual(spawnCalls, []);

  for (const status of [
    { type: 'active', activeFlags: [] },
    { type: 'notLoaded' },
    { type: 'systemError' },
  ]) {
    const statusCalls = [];
    const statusSpawnCalls = [];
    const gatedAdapter = new CodexAppServerAdapter({
      request: async (method, params) => {
        statusCalls.push({ method, params });
        if (method === 'thread/resume') {
          return { thread: { id: params.threadId, status } };
        }
        throw new Error(`turn/start must not run for observed ${status.type} status`);
      },
      spawn: (...args) => {
        statusSpawnCalls.push(args);
        throw new Error('the App Server adapter must not spawn or impersonate a CLI session');
      },
    });

    const queued = await gatedAdapter.deliver({
      ...request,
      threadState: 'idle',
    });
    assert.equal(queued.state, 'queued');
    assert.match(queued.reason, new RegExp(status.type, 'i'));
    assert.deepEqual(statusCalls.map(call => call.method), ['thread/resume']);
    assert.deepEqual(statusSpawnCalls, []);
  }
});

test('Claude Channel declares and emits only the observed preview capability and notification contracts', async () => {
  const {
    ACK_FEEDBACK_TOOL,
    CLAUDE_CHANNEL_CAPABILITIES,
    CLAUDE_CHANNEL_NOTIFICATION_METHOD,
    buildClaudeChannelNotification,
  } = await optionalImport(claudeChannelPath);
  assert.deepEqual(CLAUDE_CHANNEL_CAPABILITIES, {
    experimental: { 'claude/channel': {} },
    tools: {},
  });
  assert.equal(CLAUDE_CHANNEL_NOTIFICATION_METHOD, 'notifications/claude/channel');
  assert.equal(typeof buildClaudeChannelNotification, 'function');
  assert.equal(ACK_FEEDBACK_TOOL?.name, 'ack_feedback');
  assert.deepEqual(new Set(ACK_FEEDBACK_TOOL.inputSchema.required), new Set(['deliveryId', 'message']));
  assert.equal(ACK_FEEDBACK_TOOL.inputSchema.additionalProperties, false);

  const notification = buildClaudeChannelNotification({
    deliveryId: 'delivery-stable-7',
    feedbackBatch: feedbackBatch(),
  });
  assert.equal(notification.method, 'notifications/claude/channel');
  assert.equal(typeof notification.params.content, 'string');
  assert.match(notification.params.content, /delivery-stable-7/u);
  assert.match(notification.params.content, /browser-turn-7/u);
  assert.equal(notification.params.meta.delivery_id, 'delivery-stable-7');
  assert.equal(notification.params.meta.feedback_event_id, 'feedback-event-7');
  assert.equal(notification.params.meta.feedback_seq, '7');
  assert.ok(Object.entries(notification.params.meta).every(([key, value]) => (
    /^[a-zA-Z0-9_]+$/.test(key) && typeof value === 'string'
  )));
});

test('explicit ack_feedback is the only path that publishes a Session Store Reply', async t => {
  const { AgentConversationDelivery } = optionalRequire(agentDeliveryPath);
  assert.equal(typeof AgentConversationDelivery, 'function');
  const store = createSessionStore(t, 'adapter-ack', 'adapter-event');
  const turn = store.appendBrowserTurn({
    clientTurnId: 'ack-turn-1',
    message: 'Wait for explicit processing acknowledgement.',
  });
  const adapter = {
    capability: () => ({ supported: true }),
    deliver: async () => ({ state: 'delivered' }),
  };
  const delivery = new AgentConversationDelivery({
    adapters: { claude: adapter },
    sessionStore: store,
  });

  const delivered = await delivery.deliver(deliveryRequest({
    runtime: 'claude',
    conversationId: 'open-claude-conversation',
    feedbackBatch: turn,
  }));
  assert.equal(delivered.state, 'delivered');
  assert.equal(store.readCursor(), 0);
  assert.equal(store.snapshot().pendingTurns, 1);
  assert.equal(store.snapshot().events.filter(event => event.type === 'agent.message').length, 0);

  await assert.rejects(
    delivery.ackFeedback({
      deliveryId: 'unknown-delivery',
      message: 'An unknown delivery must not acknowledge a Feedback Batch.',
    }),
    /delivery|unknown|unauthori[sz]ed|not delivered/i,
  );

  const queuedStore = createSessionStore(t, 'adapter-ack-queued', 'queued-event');
  const queuedTurn = queuedStore.appendBrowserTurn({
    clientTurnId: 'queued-turn-1',
    message: 'This Feedback Batch has not been delivered.',
  });
  const queuedDelivery = new AgentConversationDelivery({
    adapters: {
      claude: {
        capability: () => ({ supported: false, reason: 'channel_unsupported' }),
        deliver: async () => {
          throw new Error('unsupported delivery must not invoke the adapter');
        },
      },
    },
    sessionStore: queuedStore,
  });
  const queued = await queuedDelivery.deliver(deliveryRequest({
    runtime: 'claude',
    sessionId: 'queued-visual-session',
    conversationId: 'queued-claude-conversation',
    feedbackBatch: queuedTurn,
  }));
  assert.equal(queued.state, 'queued');
  await assert.rejects(
    queuedDelivery.ackFeedback({
      deliveryId: queued.deliveryId,
      message: 'A queued delivery must not acknowledge a Feedback Batch.',
    }),
    /delivery|queued|not delivered|unauthori[sz]ed/i,
  );

  const failedStore = createSessionStore(t, 'adapter-ack-failed', 'failed-event');
  const failedTurn = failedStore.appendBrowserTurn({
    clientTurnId: 'failed-turn-1',
    message: 'This Feedback Batch failed before delivery.',
  });
  const failedDelivery = new AgentConversationDelivery({
    adapters: {
      claude: {
        capability: () => ({ supported: true }),
        deliver: async () => ({ state: 'failed', reason: 'transport_failure' }),
      },
    },
    sessionStore: failedStore,
  });
  const failed = await failedDelivery.deliver(deliveryRequest({
    runtime: 'claude',
    sessionId: 'failed-visual-session',
    conversationId: 'failed-claude-conversation',
    feedbackBatch: failedTurn,
  }));
  assert.match(failed.state, /queued|failed/u);
  await assert.rejects(
    failedDelivery.ackFeedback({
      deliveryId: failed.deliveryId,
      message: 'A failed delivery must not acknowledge a Feedback Batch.',
    }),
    /delivery|queued|failed|not delivered|unauthori[sz]ed/i,
  );

  const foreignStore = createSessionStore(t, 'adapter-ack-foreign', 'foreign-event');
  const foreignTurn = foreignStore.appendBrowserTurn({
    clientTurnId: 'foreign-turn-1',
    message: 'This Feedback Batch belongs to another Visual Session.',
  });
  const foreignDelivery = new AgentConversationDelivery({
    adapters: { claude: adapter },
    sessionStore: foreignStore,
  });
  const foreign = await foreignDelivery.deliver(deliveryRequest({
    runtime: 'claude',
    sessionId: 'foreign-visual-session',
    conversationId: 'foreign-claude-conversation',
    feedbackBatch: foreignTurn,
  }));
  assert.equal(foreign.state, 'delivered');
  await assert.rejects(
    delivery.ackFeedback({
      deliveryId: foreign.deliveryId,
      message: 'A delivery from another Visual Session must not cross-acknowledge.',
    }),
    /delivery|unknown|unauthori[sz]ed|not delivered/i,
  );
  assert.equal(store.readCursor(), 0);
  assert.equal(queuedStore.readCursor(), 0);
  assert.equal(failedStore.readCursor(), 0);
  assert.equal(foreignStore.readCursor(), 0);

  const reply = await delivery.ackFeedback({
    deliveryId: delivered.deliveryId,
    message: 'Feedback Batch processed in the agent conversation.',
  });
  assert.equal(reply.replyTo, turn.seq);
  assert.equal(store.readCursor(), turn.seq);
  assert.equal(store.snapshot().pendingTurns, 0);
  await delivery.ackFeedback({
    deliveryId: delivered.deliveryId,
    message: 'Duplicate acknowledgement must not duplicate Reply.',
  });
  assert.equal(store.snapshot().events.filter(event => event.type === 'agent.message').length, 1);
});

test('unsupported Claude capability queues truthfully and replays only when support is observed', async () => {
  const { AgentConversationDelivery } = optionalRequire(agentDeliveryPath);
  assert.equal(typeof AgentConversationDelivery, 'function');
  let supported = false;
  const delivered = [];
  const delivery = new AgentConversationDelivery({
    adapters: {
      claude: {
        capability: () => ({ supported, reason: supported ? null : 'channel_unsupported' }),
        deliver: async request => {
          delivered.push(request);
          return { state: 'delivered' };
        },
      },
    },
  });

  const queued = await delivery.deliver(deliveryRequest({ runtime: 'claude' }));
  assert.equal(queued.state, 'queued');
  assert.match(queued.reason, /unsupported|unavailable/i);
  assert.equal(delivered.length, 0);

  supported = true;
  const replay = await delivery.flush({ runtime: 'claude' });
  assert.equal(replay.delivered, 1);
  assert.equal(delivered.length, 1);
});

test('queued delivery preserves Feedback Batch order and suppresses duplicate retries', async () => {
  const { AgentConversationDelivery } = optionalRequire(agentDeliveryPath);
  assert.equal(typeof AgentConversationDelivery, 'function');
  let supported = false;
  const deliveredSeqs = [];
  const delivery = new AgentConversationDelivery({
    adapters: {
      codex: {
        capability: () => ({ supported }),
        deliver: async request => {
          deliveredSeqs.push(request.feedbackBatch.seq);
          return { state: 'delivered' };
        },
      },
    },
  });
  const second = deliveryRequest({ feedbackBatch: feedbackBatch({ id: 'event-2', seq: 2 }) });
  const first = deliveryRequest({ feedbackBatch: feedbackBatch({ id: 'event-1', seq: 1 }) });

  const secondQueued = await delivery.deliver(second);
  const firstQueued = await delivery.deliver(first);
  const duplicate = await delivery.deliver(structuredClone(first));
  assert.equal(secondQueued.state, 'queued');
  assert.equal(firstQueued.state, 'queued');
  assert.equal(duplicate.deliveryId, firstQueued.deliveryId);

  supported = true;
  const replay = await delivery.flush({ runtime: 'codex' });
  assert.equal(replay.delivered, 2);
  assert.deepEqual(deliveredSeqs, [1, 2]);

  await delivery.deliver(structuredClone(first));
  assert.deepEqual(deliveredSeqs, [1, 2], 'a delivered identity is never sent twice');
});

test('adapter failures queue without exposing tokens, private paths, prompts, or conversation content', async () => {
  const { AgentConversationDelivery } = optionalRequire(agentDeliveryPath);
  assert.equal(typeof AgentConversationDelivery, 'function');
  const secrets = [
    'capability-token-private',
    '/private-fixture/visual-session',
    'raw system prompt',
    'private Feedback Batch content',
  ];
  const delivery = new AgentConversationDelivery({
    adapters: {
      codex: {
        capability: () => ({ supported: true }),
        deliver: async () => {
          throw new Error(secrets.join(' :: '));
        },
      },
    },
  });

  const result = await delivery.deliver(deliveryRequest({
    feedbackBatch: feedbackBatch({ message: secrets.at(-1) }),
  }));
  assert.equal(result.state, 'queued');
  assert.match(result.reason, /adapter|delivery|unavailable/i);
  const serialized = JSON.stringify(result);
  for (const secret of secrets) assert.doesNotMatch(serialized, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
});
