const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { createBrainstormServer } = require('../scripts/server.cjs');
const { SessionStore } = require('../scripts/session-store.cjs');
const { createScratchDirectory } = require('./test-support');

const mcpServer = path.resolve(__dirname, '../scripts/visual-mcp-server.mjs');
const PRIVATE_VALUE = 'mcp-private-value-that-must-not-appear';

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function assertResponseStatus(response, expected) {
  if (response.status === expected) return;
  const body = await response.text();
  assert.equal(response.status, expected, body);
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch {
      // The evidence endpoint can be between two durable writes. Reconcile until bounded timeout.
    }
    await delay(20);
  }
  throw new Error('timed out waiting for MCP delivery evidence');
}

async function mcpSdk() {
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/stdio.js'),
  ]);
  return { Client, StdioClientTransport };
}

async function connectMcp(t, sessionDir) {
  const { Client, StdioClientTransport } = await mcpSdk();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpServer, '--session-dir', sessionDir],
    cwd: path.resolve(__dirname, '../../..'),
    env: {
      ...process.env,
      CLAUDE_SCRATCH_DIR: process.env.CLAUDE_SCRATCH_DIR || path.dirname(sessionDir),
    },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += chunk.toString('utf8'); });
  const client = new Client(
    { name: 'visual-companion-transport-test', version: '1.0.0' },
    { capabilities: {} },
  );
  t.after(async () => {
    await client.close().catch(() => {});
    assert.doesNotMatch(stderr, new RegExp(PRIVATE_VALUE, 'u'));
    assert.doesNotMatch(stderr, new RegExp(sessionDir.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  });
  await client.connect(transport, { timeout: 2_000 });
  const listed = await client.listTools({}, { timeout: 2_000 });
  const waitTool = listed.tools.find(tool => tool.name === 'wait_for_feedback');
  assert.ok(waitTool, 'the MCP server must register wait_for_feedback');
  assert.equal(waitTool.inputSchema.type, 'object');
  assert.ok(waitTool.inputSchema.properties?.timeoutMs, 'the review-window timeout must be configurable');
  assert.ok(waitTool.outputSchema, 'wait_for_feedback must publish an output schema for structuredContent');
  assert.equal(waitTool.annotations?.readOnlyHint, false, 'Wait writes delivery evidence and must not claim read-only operation');
  assert.equal(waitTool.annotations?.destructiveHint, false, 'Wait never acknowledges or consumes a Feedback Batch');
  return { client, waitTool };
}

async function startLiveSession(t, purpose) {
  const sessionDir = createScratchDirectory(t, purpose);
  const token = `${purpose}-capability`;
  const app = createBrainstormServer({
    sessionDir,
    host: '127.0.0.1',
    port: 0,
    token,
    sessionId: `${purpose}-session`,
    idleTimeoutMs: 60_000,
  });
  const address = await app.listen();
  t.after(() => app.close());
  const root = await fetch(address.connection_url);
  assert.equal(root.status, 200, await root.text());
  const cookie = root.headers.get('set-cookie').split(';')[0];
  return { address, app, cookie, sessionDir, store: new SessionStore(app.stateDir), token };
}

async function submitFeedback(harness, clientTurnId, message) {
  return fetch(`${harness.address.url}${harness.address.base_path}api/feedback`, {
    method: 'POST',
    headers: { Cookie: harness.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientTurnId,
      message,
      screen: { id: 'screen', file: 'screen.json' },
    }),
  });
}

async function callWait(client, timeoutMs, requestOptions = {}) {
  return client.callTool(
    { name: 'wait_for_feedback', arguments: { timeoutMs } },
    undefined,
    { timeout: Math.max(timeoutMs + 1_000, 2_000), ...requestOptions },
  );
}

function deliveredResult(result) {
  assert.notEqual(result.isError, true);
  assert.ok(result.structuredContent, 'wait_for_feedback must expose schema-validated structuredContent');
  assert.ok(
    result.content?.some(item => item.type === 'text' && item.text.trim()),
    'wait_for_feedback must also expose model-readable text content',
  );
  return result.structuredContent;
}

async function deliveryEvidence(harness) {
  const response = await fetch(`${harness.address.url}${harness.address.base_path}api/state`, {
    headers: { Cookie: harness.cookie },
  });
  await assertResponseStatus(response, 200);
  const state = await response.json();
  const serialized = JSON.stringify(state);
  assert.doesNotMatch(serialized, new RegExp(harness.token, 'u'));
  assert.doesNotMatch(serialized, new RegExp(harness.sessionDir.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  return state.deliveryEvidence;
}

test('active MCP wait returns the oldest durable Feedback Batch and exposes observed delivery evidence', async t => {
  const harness = await startLiveSession(t, 'mcp-active-wait');
  const { client } = await connectMcp(t, harness.sessionDir);

  const waiting = callWait(client, 2_000);
  await waitFor(async () => (await deliveryEvidence(harness))?.listening === true);

  const submitted = await submitFeedback(
    harness,
    'mcp-active-feedback-1',
    'Return this Feedback Batch to the active turn.',
  );
  assert.equal(submitted.status, 201, await submitted.text());

  const delivered = deliveredResult(await waiting);
  assert.equal(delivered.state, 'delivered');
  assert.equal(delivered.feedbackBatch.clientTurnId, 'mcp-active-feedback-1');
  assert.equal(delivered.feedbackBatch.message, 'Return this Feedback Batch to the active turn.');
  assert.equal(delivered.pending, 1);
  assert.equal(harness.store.nextUnacknowledgedTurn().clientTurnId, 'mcp-active-feedback-1');

  const evidence = await waitFor(async () => {
    const value = await deliveryEvidence(harness);
    return value?.deliveredThrough === delivered.feedbackBatch.seq ? value : null;
  });
  assert.equal(evidence.connection, 'open');
  assert.equal(evidence.durableSeq, delivered.feedbackBatch.seq);
  assert.equal(evidence.acknowledgedThrough, 0);
  assert.equal(evidence.listening, false);
  assert.doesNotMatch(JSON.stringify(delivered), new RegExp(PRIVATE_VALUE, 'u'));
  assert.doesNotMatch(JSON.stringify(delivered), new RegExp(harness.sessionDir.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
});

test('MCP cancellation and protocol timeout never consume a later Feedback Batch', async t => {
  const harness = await startLiveSession(t, 'mcp-cancel-timeout');
  const { client } = await connectMcp(t, harness.sessionDir);

  const controller = new AbortController();
  const cancelled = callWait(client, 5_000, { signal: controller.signal });
  await waitFor(async () => (await deliveryEvidence(harness))?.listening === true);
  controller.abort('review was cancelled');
  await assert.rejects(cancelled, /abort|cancel|review was cancelled/i);
  await waitFor(async () => (await deliveryEvidence(harness))?.listening === false);

  const afterCancel = await submitFeedback(harness, 'after-cancel-1', 'Still pending after cancellation.');
  assert.equal(afterCancel.status, 201, await afterCancel.text());
  assert.equal(harness.store.snapshot().pendingTurns, 1);
  const recoveredAfterCancel = deliveredResult(await callWait(client, 1_000));
  assert.equal(recoveredAfterCancel.feedbackBatch.clientTurnId, 'after-cancel-1');
  harness.store.publishAgentReply({
    replyTo: recoveredAfterCancel.feedbackBatch.seq,
    message: 'Cancellation recovery confirmed.',
  });

  const timedOut = callWait(client, 5_000, { timeout: 1_000 });
  await waitFor(async () => (await deliveryEvidence(harness))?.listening === true);
  await assert.rejects(timedOut, /timed out|timeout/i);
  await waitFor(async () => (await deliveryEvidence(harness))?.listening === false);
  const afterTimeout = await submitFeedback(harness, 'after-timeout-1', 'Still pending after request timeout.');
  assert.equal(afterTimeout.status, 201, await afterTimeout.text());
  assert.equal(harness.store.snapshot().pendingTurns, 1);
  const recoveredAfterTimeout = deliveredResult(await callWait(client, 1_000));
  assert.equal(recoveredAfterTimeout.feedbackBatch.clientTurnId, 'after-timeout-1');
  assert.equal(recoveredAfterTimeout.pending, 1);
});

test('active MCP wait reports server death as closed instead of waiting for its timeout', async t => {
  const harness = await startLiveSession(t, 'mcp-server-death');
  const { client } = await connectMcp(t, harness.sessionDir);
  const waiting = callWait(client, 5_000);
  await waitFor(async () => (await deliveryEvidence(harness))?.listening === true);

  const closedAt = Date.now();
  await harness.app.close('transport integration server death');
  const result = deliveredResult(await waiting);
  assert.equal(result.state, 'closed');
  assert.equal(result.feedbackBatch, null);
  assert.equal(result.pending, 0);
  assert.match(result.reason, /server|closed|death/i);
  assert.ok(Date.now() - closedAt < 2_000, 'server death must preempt the configured review timeout');
});

test('multiple queued Feedback Batches preserve durable order and remain pending until Reply acknowledgement', async t => {
  const harness = await startLiveSession(t, 'mcp-queued-order');
  const { client } = await connectMcp(t, harness.sessionDir);
  const firstResponse = await submitFeedback(harness, 'queued-first', 'First durable Feedback Batch.');
  const secondResponse = await submitFeedback(harness, 'queued-second', 'Second durable Feedback Batch.');
  assert.equal(firstResponse.status, 201, await firstResponse.text());
  assert.equal(secondResponse.status, 201, await secondResponse.text());

  const first = deliveredResult(await callWait(client, 1_000));
  assert.equal(first.feedbackBatch.clientTurnId, 'queued-first');
  assert.equal(first.pending, 2);
  assert.equal(harness.store.nextUnacknowledgedTurn().clientTurnId, 'queued-first');
  harness.store.publishAgentReply({ replyTo: first.feedbackBatch.seq, message: 'First acknowledged.' });

  const second = deliveredResult(await callWait(client, 1_000));
  assert.equal(second.feedbackBatch.clientTurnId, 'queued-second');
  assert.equal(second.pending, 1);
  assert.equal(harness.store.nextUnacknowledgedTurn().clientTurnId, 'queued-second');
  harness.store.publishAgentReply({ replyTo: second.feedbackBatch.seq, message: 'Second acknowledged.' });
  assert.equal(harness.store.snapshot().pendingTurns, 0);

  const evidence = await waitFor(async () => {
    const value = await deliveryEvidence(harness);
    return value?.acknowledgedThrough === second.feedbackBatch.seq ? value : null;
  });
  assert.equal(evidence.deliveredThrough, second.feedbackBatch.seq);
  assert.equal(evidence.durableSeq, second.feedbackBatch.seq);
});
