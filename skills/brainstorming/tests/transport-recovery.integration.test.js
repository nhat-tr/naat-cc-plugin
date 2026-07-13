const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createBrainstormServer } = require('../scripts/server.cjs');
const reviewIndex = require('../../pair-v3/scripts/review-index.cjs');
const { createScratchDirectory } = require('./test-support');

const CAPABILITY = 'transport-current-capability';
const STALE_CAPABILITY = 'transport-stale-capability';
const PRIVATE_VALUE = 'transport-private-value-that-must-not-appear';
const PERFORMANCE_BUDGETS = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, '../fixtures/performance-budgets.json'),
  'utf8',
));
const REVIEW_FIXTURE = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, '../fixtures/feature-review-work.json'),
  'utf8',
));

class ManualIntervalScheduler {
  constructor() {
    this.nextId = 1;
    this.intervals = new Map();
  }

  setInterval = (callback, delay) => {
    const handle = { id: this.nextId++, unref() {} };
    this.intervals.set(handle, { callback, delay });
    return handle;
  };

  clearInterval = handle => {
    this.intervals.delete(handle);
  };

  tick(delay) {
    const intervals = [...this.intervals.values()].filter(interval => interval.delay === delay);
    assert.ok(intervals.length > 0, `expected an active ${delay}ms heartbeat interval`);
    for (const interval of intervals) interval.callback();
  }

  assertBounded(delay) {
    assert.ok(this.intervals.size <= 1, 'SSE heartbeat owns at most one interval');
    for (const interval of this.intervals.values()) assert.equal(interval.delay, delay);
  }
}

async function assertResponseStatus(response, expected) {
  if (response.status === expected) return;
  const body = await response.text();
  assert.equal(response.status, expected, body);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function assertSecretSafe(value, sessionDir) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  assert.doesNotMatch(text, new RegExp(CAPABILITY, 'u'));
  assert.doesNotMatch(text, new RegExp(STALE_CAPABILITY, 'u'));
  assert.doesNotMatch(text, new RegExp(PRIVATE_VALUE, 'u'));
  assert.doesNotMatch(text, new RegExp(escapeRegExp(sessionDir), 'u'));
}

function legacyScreen(title = 'Transport recovery') {
  return {
    version: 1,
    profile: 'technical',
    audience: 'Software developers',
    title,
    sections: [{
      kind: 'callout',
      id: 'transport-state',
      title: 'Observed delivery state',
      body: 'State comes from server and adapter evidence.',
      tone: 'accent',
    }],
  };
}

function workspaceRevision(value) {
  const semantic = structuredClone(value);
  delete semantic.revision;
  const json = JSON.stringify(semantic);
  let hash = 0x811c9dc5;
  for (let index = 0; index < json.length; index += 1) {
    hash ^= json.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function stressWorkspace() {
  const document = structuredClone(REVIEW_FIXTURE);
  document.title = 'Controlled transport load';
  document.read_only = false;
  const slice = document.content.review_slices[0];
  const baseFile = document.content.patch_set.files[0];
  const baseChange = slice?.actual_changes[0];
  const frame = document.frames[0];
  if (!slice || !baseFile || !baseChange || !frame) {
    throw new TypeError('feature Review fixture must include one linked file, change, and frame');
  }

  const files = Array.from({ length: PERFORMANCE_BUDGETS.stress_workload.changed_files }, (_value, index) => ({
    ...structuredClone(baseFile),
    path: `src/feature-${String(index + 1).padStart(3, '0')}.ts`,
    patch_digest: String(index + 1).padStart(64, '0'),
    acceptance_criteria: [...baseFile.acceptance_criteria],
    attribution: structuredClone(baseFile.attribution),
  }));
  const actualChanges = files.map((file, index) => ({
    ...structuredClone(baseChange),
    component_id: `transport-change-${index + 1}`,
    path: file.path,
    hunk_id: file.patch_digest,
    symbols: [`transportChange${index + 1}`],
    source_preview: {
      start_line: index + 1,
      end_line: index + 1,
      lines: [`export const transportChange${index + 1} = ${index + 1};`],
    },
  }));
  const patchSet = reviewIndex.buildPatchSet({ ...document.content.patch_set, files });
  document.content.patch_set = { ...patchSet, files };
  const indexedReview = reviewIndex.createPatchSetReview(patchSet);
  const { files: indexedFiles, ...reviewState } = indexedReview;
  document.content.patch_set_review = {
    ...reviewState,
    file_reviews: Object.entries(indexedFiles).map(([filePath, state]) => ({ path: filePath, ...state })),
  };
  slice.actual_changes = actualChanges;
  slice.expected_files = files.map(file => file.path);

  const nodes = Array.from({ length: PERFORMANCE_BUDGETS.stress_workload.architecture_nodes }, (_value, index) => ({
    id: `node-${index + 1}`,
    label: `Runtime node ${index + 1}`,
  }));
  const edges = Array.from({ length: PERFORMANCE_BUDGETS.stress_workload.architecture_edges }, (_value, index) => ({
    id: `edge-${index + 1}`,
    source: nodes[index % nodes.length].id,
    target: nodes[(index + 1) % nodes.length].id,
  }));
  const workloadComponents = [
    ...actualChanges.map(change => ({
      id: change.component_id,
      frame_id: frame.id,
      label: `${change.path} actual change`,
    })),
    ...nodes.map(node => ({ id: node.id, frame_id: frame.id, label: node.label })),
    ...edges.map(edge => ({
      id: edge.id,
      frame_id: frame.id,
      label: `${edge.source} to ${edge.target}`,
    })),
  ];
  document.components.push(...workloadComponents);
  frame.component_ids.push(...workloadComponents.map(component => component.id));
  document.revision = workspaceRevision(document);
  return document;
}

async function startServer(t, purpose, options = {}) {
  const sessionDir = createScratchDirectory(t, purpose);
  const contentDir = path.join(sessionDir, 'content');
  const stateDir = path.join(sessionDir, 'state');
  fs.mkdirSync(contentDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  if (options.workspace) {
    fs.writeFileSync(path.join(contentDir, 'workspace.json'), `${JSON.stringify(options.workspace)}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(stateDir, 'visual-format.json'), `${JSON.stringify({
      version: 1,
      active_version: 2,
      v1_document: 'content/screen.json',
      v2_document: 'content/workspace.json',
    })}\n`, { mode: 0o600 });
  } else {
    fs.writeFileSync(path.join(contentDir, 'screen.json'), `${JSON.stringify(options.screen || legacyScreen())}\n`, { mode: 0o600 });
  }
  const app = createBrainstormServer({
    sessionDir,
    host: '127.0.0.1',
    port: 0,
    token: CAPABILITY,
    sessionId: `${purpose}-session`,
    idleTimeoutMs: 60_000,
    sseHeartbeatMs: options.sseHeartbeatMs ?? 25,
    sseSetInterval: options.sseSetInterval,
    sseClearInterval: options.sseClearInterval,
  });
  const address = await app.listen();
  t.after(() => app.close());
  const root = await fetch(address.connection_url);
  assert.equal(root.status, 200, await root.text());
  const cookie = root.headers.get('set-cookie').split(';')[0];
  return { address, app, cookie, sessionDir };
}

async function readSseUntil(reader, predicate, timeoutMs = 2_000, prefix = '') {
  const decoder = new TextDecoder();
  let text = prefix;
  let timeout;
  try {
    while (!predicate(text)) {
      const next = await Promise.race([
        reader.read(),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error(`timed out reading SSE stream: ${text}`)), timeoutMs);
        }),
      ]);
      clearTimeout(timeout);
      timeout = undefined;
      if (next.done) throw new Error(`SSE stream closed before expected evidence: ${text}`);
      text += decoder.decode(next.value, { stream: true });
    }
    return text;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function connectEvents(t, harness) {
  const response = await fetch(`${harness.address.url}${harness.address.base_path}api/events`, {
    headers: { Cookie: harness.cookie },
  });
  await assertResponseStatus(response, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/u);
  const reader = response.body.getReader();
  t.after(() => reader.cancel().catch(() => {}));
  return reader;
}

async function readState(harness) {
  const response = await fetch(`${harness.address.url}${harness.address.base_path}api/state`, {
    headers: { Cookie: harness.cookie },
  });
  await assertResponseStatus(response, 200);
  const state = await response.json();
  assertSecretSafe(state, harness.sessionDir);
  return state;
}

async function submitFeedback(harness, body, headers = {}) {
  return fetch(`${harness.address.url}${harness.address.base_path}api/feedback`, {
    method: 'POST',
    headers: { Cookie: harness.cookie, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

test('SSE emits bounded heartbeats and forces a full screen and Session Store resync on open and reconnect', async t => {
  const heartbeat = new ManualIntervalScheduler();
  const harness = await startServer(t, 'transport-sse-reconnect', {
    sseHeartbeatMs: 25,
    sseSetInterval: heartbeat.setInterval,
    sseClearInterval: heartbeat.clearInterval,
  });
  const firstReader = await connectEvents(t, harness);
  const opened = await readSseUntil(firstReader, text => text.includes('event: resync'));
  assert.match(opened, /event: resync\ndata: /u);
  heartbeat.assertBounded(25);
  heartbeat.tick(25);
  const firstHeartbeat = await readSseUntil(firstReader, text => text.includes(': heartbeat'), 2_000, opened);
  heartbeat.tick(25);
  const secondHeartbeat = await readSseUntil(
    firstReader,
    text => (text.match(/: heartbeat/gu) || []).length >= 2,
    2_000,
    firstHeartbeat,
  );
  assert.equal((secondHeartbeat.match(/: heartbeat/gu) || []).length, 2);
  heartbeat.assertBounded(25);
  await firstReader.cancel();

  const revised = legacyScreen('Transport recovery after disconnect');
  fs.writeFileSync(harness.app.screenPath, `${JSON.stringify(revised)}\n`, { mode: 0o600 });
  harness.app.store.appendBrowserTurn({
    clientTurnId: 'feedback-while-disconnected',
    message: 'This Feedback Batch was durable while SSE was disconnected.',
    screen: { id: 'screen', file: 'screen.json' },
  });

  const reconnectReader = await connectEvents(t, harness);
  const reconnected = await readSseUntil(reconnectReader, text => text.includes('event: resync'));
  assert.match(reconnected, /event: resync/u);
  heartbeat.assertBounded(25);
  const state = await readState(harness);
  assert.equal(state.screen.title, 'Transport recovery after disconnect');
  assert.equal(state.session.pendingTurns, 1);
  assert.equal(state.session.events.at(-1).clientTurnId, 'feedback-while-disconnected');
  assert.deepEqual(state.deliveryEvidence, {
    connection: 'open',
    listening: false,
    durableSeq: state.session.events.at(-1).seq,
    deliveredThrough: 0,
    acknowledgedThrough: 0,
  });
  await harness.app.close('heartbeat cleanup verification');
  assert.equal(heartbeat.intervals.size, 0, 'server closure clears the heartbeat interval');
});

test('browser delivery evidence is queued after persistence and acknowledged only after a real Reply', async t => {
  const harness = await startServer(t, 'transport-evidence-state');
  const submitted = await submitFeedback(harness, {
    clientTurnId: 'evidence-feedback-1',
    message: 'Do not claim delivery from the POST response.',
    screen: { id: 'screen', file: 'screen.json' },
  });
  await assertResponseStatus(submitted, 201);
  const persisted = await submitted.json();

  const queued = await readState(harness);
  assert.equal(queued.deliveryEvidence.durableSeq, persisted.seq);
  assert.equal(queued.deliveryEvidence.deliveredThrough, 0);
  assert.equal(queued.deliveryEvidence.acknowledgedThrough, 0);
  assert.equal(queued.deliveryEvidence.listening, false);

  harness.app.store.publishAgentReply({ replyTo: persisted.seq, message: 'Reply evidence is now durable.' });
  const acknowledged = await readState(harness);
  assert.equal(acknowledged.deliveryEvidence.acknowledgedThrough, persisted.seq);
  assert.equal(acknowledged.deliveryEvidence.durableSeq, persisted.seq);
  assert.equal(acknowledged.session.cursor, persisted.seq);
  assert.equal(acknowledged.session.pendingTurns, 0);
});

test('Feedback Batch persistence stays within the recorded budget under controlled SSE and workspace load', async t => {
  const workspace = stressWorkspace();
  const harness = await startServer(t, 'transport-controlled-load', { workspace });
  const readers = await Promise.all(Array.from({ length: 8 }, () => connectEvents(t, harness)));
  const opened = await Promise.all(readers.map(reader => readSseUntil(
    reader,
    text => text.includes(': connected') || text.includes('event: resync'),
  )));
  assert.equal(opened.length, 8);

  const started = performance.now();
  const response = await submitFeedback(harness, {
    clientTurnId: 'load-feedback-1',
    message: 'Feedback remains durable while the 300-file and 200-node review fixture is live.',
    annotations: [{
      id: 'load-annotation-1',
      comment: 'Keep the transport independent of workspace size.',
      target: { componentId: 'node-200', label: 'Runtime node 200' },
    }],
    screen: { id: 'review', file: 'workspace.json', revision: workspace.revision },
  });
  const elapsedMs = performance.now() - started;
  await assertResponseStatus(response, 201);
  const record = await response.json();
  assert.equal(record.clientTurnId, 'load-feedback-1');
  assert.ok(
    elapsedMs <= PERFORMANCE_BUDGETS.host.feedback_persistence_ms,
    `Feedback Batch persisted in ${elapsedMs.toFixed(1)}ms; budget is ${PERFORMANCE_BUDGETS.host.feedback_persistence_ms}ms`,
  );
  const snapshot = harness.app.store.strictSnapshot();
  assert.equal(snapshot.pendingTurns, 1);
  assert.equal(snapshot.events.at(-1).annotations[0].target.componentId, 'node-200');
  assert.match(fs.readFileSync(path.join(harness.app.stateDir, 'session.jsonl'), 'utf8'), /load-feedback-1/u);
  await Promise.all(readers.map(reader => reader.cancel().catch(() => {})));
});

test('transport endpoints reject untrusted requests without disclosing capabilities, private paths, prompts, or secret values', async t => {
  const harness = await startServer(t, 'transport-secret-safe');
  const loggedErrors = [];
  const originalConsoleError = console.error;
  console.error = (...values) => loggedErrors.push(values.map(String).join(' '));
  t.after(() => { console.error = originalConsoleError; });

  const unauthorizedState = await fetch(`${harness.address.url}${harness.address.base_path}api/state`);
  assert.equal(unauthorizedState.status, 401);
  assertSecretSafe(await unauthorizedState.text(), harness.sessionDir);

  const staleEvents = await fetch(`${harness.address.url}${harness.address.base_path}api/events`, {
    headers: { Cookie: `brainstorm_session=${STALE_CAPABILITY}` },
  });
  assert.equal(staleEvents.status, 401);
  assertSecretSafe(await staleEvents.text(), harness.sessionDir);

  const crossOrigin = await submitFeedback(harness, {
    clientTurnId: 'cross-origin-secret',
    message: PRIVATE_VALUE,
    screen: { id: 'screen', file: 'screen.json' },
  }, { Origin: 'https://untrusted.example' });
  assert.equal(crossOrigin.status, 403);
  assertSecretSafe(await crossOrigin.text(), harness.sessionDir);

  const malformed = await fetch(`${harness.address.url}${harness.address.base_path}api/feedback`, {
    method: 'POST',
    headers: { Cookie: harness.cookie, 'Content-Type': 'application/json' },
    body: `{"message":"${PRIVATE_VALUE}",`,
  });
  assert.equal(malformed.status, 400);
  assertSecretSafe(await malformed.text(), harness.sessionDir);

  const oversized = await submitFeedback(harness, {
    clientTurnId: 'oversized-secret',
    message: PRIVATE_VALUE.repeat(2_000),
    padding: 'x'.repeat(70 * 1_024),
    screen: { id: 'screen', file: 'screen.json' },
  });
  assert.equal(oversized.status, 413);
  assertSecretSafe(await oversized.text(), harness.sessionDir);

  assert.equal(harness.app.store.snapshot().events.length, 0);
  assertSecretSafe(loggedErrors, harness.sessionDir);
  const standalone = fs.readFileSync(path.join(harness.sessionDir, 'visual.html'), 'utf8');
  assertSecretSafe(standalone, harness.sessionDir);
});
