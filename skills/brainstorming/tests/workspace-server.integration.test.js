const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createBrainstormServer } = require('../scripts/server.cjs');
const { createScratchDirectory } = require('./test-support');

const sessionCli = path.resolve(__dirname, '../scripts/visual-session.cjs');
const CAPABILITY = 'workspace-current-capability';
const STALE_CAPABILITY = 'workspace-stale-capability';
const PRIVATE_VALUE = 'workspace-private-value-that-must-not-appear';
const productFixture = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, '../fixtures/product-concept-set.json'),
  'utf8',
));

function waitFor(predicate, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      let ready = false;
      try { ready = predicate(); } catch { ready = false; }
      if (ready) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('timed out waiting for condition'));
      setTimeout(tick, 25).unref?.();
    };
    tick();
  });
}

function documentRevision(value) {
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

function workspaceDocument(overrides = {}) {
  const document = {
    ...structuredClone(productFixture),
    title: 'Authenticated workspace review',
    revision: undefined,
    feedback_threads: [{
      id: 'thread-concept-a',
      component_id: 'concept-a',
      revision: 'a1b2c3d4',
      type: 'annotation',
      status: 'open',
      comment: 'Keep the selected concept explicit.',
      replies: [],
    }],
    read_only: false,
    ...overrides,
  };
  if (!Object.hasOwn(overrides, 'revision')) document.revision = documentRevision(document);
  return document;
}

function runSession(...args) {
  return childProcess.spawnSync(process.execPath, [sessionCli, ...args], { encoding: 'utf8' });
}

function writeCandidate(sessionDir, name, document) {
  const file = path.join(sessionDir, 'inputs', name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(document)}\n`, { mode: 0o600 });
  return file;
}

function publish(sessionDir, name, document) {
  return runSession(
    'publish',
    '--document', writeCandidate(sessionDir, name, document),
    '--session-dir', sessionDir,
  );
}

function publishTab(sessionDir, name, document, tabId, tabLabel) {
  const args = ['publish', '--document', writeCandidate(sessionDir, name, document), '--session-dir', sessionDir];
  if (tabId) args.push('--tab-id', tabId);
  if (tabLabel) args.push('--tab-label', tabLabel);
  return runSession(...args);
}

async function readUntil(reader, expression, timeoutMs = 2_000) {
  const decoder = new TextDecoder();
  let value = '';
  const timeout = new Promise((_, reject) => {
    const handle = setTimeout(() => reject(new Error(`timed out waiting for ${expression}`)), timeoutMs);
    handle.unref?.();
  });
  while (!expression.test(value)) {
    const next = await Promise.race([reader.read(), timeout]);
    if (next.done) break;
    value += decoder.decode(next.value, { stream: true });
  }
  return value;
}

async function authenticatedCookie(address) {
  const root = await fetch(address.connection_url);
  assert.equal(root.status, 200, await root.text());
  return root.headers.get('set-cookie').split(';')[0];
}

async function responseJson(response) {
  const text = await response.text();
  return { text, value: JSON.parse(text) };
}

function assertSecretSafe(value, sessionDir) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of [CAPABILITY, STALE_CAPABILITY, PRIVATE_VALUE, sessionDir]) {
    assert.equal(serialized.includes(secret), false, `response or export exposed ${secret}`);
  }
}

async function startServer(t, purpose) {
  const sessionDir = createScratchDirectory(t, purpose);
  const app = createBrainstormServer({
    sessionDir,
    token: CAPABILITY,
    sessionId: `${purpose}-session`,
    idleTimeoutMs: 60_000,
  });
  const address = await app.listen();
  t.after(() => app.close());
  return { address, app, sessionDir };
}

test('authenticated Publish round-trips one normalized v2 Visual Document and its Revision-bound feedback', async t => {
  const { address, app, sessionDir } = await startServer(t, 'workspace-publish-read');
  const document = workspaceDocument();
  const published = publish(sessionDir, 'workspace.json', document);
  assert.equal(published.status, 0, published.stderr);

  const cookie = await authenticatedCookie(address);
  const response = await fetch(`${address.url}${address.base_path}api/screen`, {
    headers: { Cookie: cookie },
  });
  assert.equal(response.status, 200, await response.clone().text());
  const received = await response.json();
  assert.deepEqual(received, document);
  assert.deepEqual(app.readScreen(), document);

  const submitted = await fetch(`${address.url}${address.base_path}api/feedback`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientTurnId: 'workspace-feedback-1',
      message: 'Preserve the Revision binding.',
      annotations: [],
      choices: [],
      screen: { id: 'architecture', file: 'screen.json', revision: document.revision },
    }),
  });
  assert.equal(submitted.status, 201, await submitted.text());
  assert.equal(app.store.nextUnacknowledgedTurn().screen.revision, document.revision);
});

test('Publish rejects malformed or content-mismatched Revisions without replacing the last good document', async t => {
  const { address, sessionDir } = await startServer(t, 'workspace-revision-publish');
  const original = workspaceDocument();
  const firstPublish = publish(sessionDir, 'original.json', original);
  assert.equal(firstPublish.status, 0, firstPublish.stderr);

  const malformed = workspaceDocument({ revision: 'latest', title: PRIVATE_VALUE });
  const mismatched = workspaceDocument();
  mismatched.title = PRIVATE_VALUE;
  assert.notEqual(mismatched.revision, documentRevision(mismatched));
  const unsafeContent = workspaceDocument({
    content: { html: `<script>${PRIVATE_VALUE}</script>` },
  });

  for (const [name, candidate, expectedError] of [
    ['malformed.json', malformed, /revision/i],
    ['mismatched.json', mismatched, /revision/i],
    ['unsafe-content.json', unsafeContent, /content|unsupported|security/i],
  ]) {
    const rejected = publish(sessionDir, name, candidate);
    assert.notEqual(rejected.status, 0, `${name} must be rejected`);
    assert.match(rejected.stderr, expectedError);
    assertSecretSafe(rejected.stderr, sessionDir);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(sessionDir, 'content/screen.json'), 'utf8')),
      original,
      'a rejected Publish must not overwrite the last good Visual Document',
    );
  }

  const cookie = await authenticatedCookie(address);
  const stillReadable = await fetch(`${address.url}${address.base_path}api/screen`, {
    headers: { Cookie: cookie },
  });
  assert.equal(stillReadable.status, 200);
  assert.deepEqual(await stillReadable.json(), original);
});

test('v2 feedback rejects malformed and mismatched Revisions before persisting a Feedback Batch', async t => {
  const { address, app, sessionDir } = await startServer(t, 'workspace-feedback-revision');
  const document = workspaceDocument();
  const published = publish(sessionDir, 'workspace.json', document);
  assert.equal(published.status, 0, published.stderr);
  const cookie = await authenticatedCookie(address);

  async function submit(revision, message, clientTurnId = `feedback-${revision}`) {
    return fetch(`${address.url}${address.base_path}api/feedback`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientTurnId,
        message,
        screen: { id: 'architecture', file: 'screen.json', revision },
      }),
    });
  }

  const malformed = await submit('latest', PRIVATE_VALUE);
  assert.equal(malformed.status, 400);
  const malformedError = await responseJson(malformed);
  assert.match(malformedError.value.error, /revision/i);
  assertSecretSafe(malformedError.text, sessionDir);

  const staleRevision = document.revision === '00000000' ? '00000001' : '00000000';
  const mismatched = await submit(staleRevision, PRIVATE_VALUE);
  assert.equal(mismatched.status, 409);
  const mismatchError = await responseJson(mismatched);
  assert.match(mismatchError.value.error, /revision|stale|current/i);
  assertSecretSafe(mismatchError.text, sessionDir);
  assert.equal(app.store.snapshot().events.length, 0);

  const accepted = await submit(document.revision, 'Current Revision feedback.', ' retry-current-revision ');
  const acceptedText = await accepted.text();
  assert.equal(accepted.status, 201, acceptedText);
  const acceptedRecord = JSON.parse(acceptedText);
  assert.equal(acceptedRecord.clientTurnId, 'retry-current-revision');
  assert.equal(app.store.snapshot().events.length, 1);

  const nextDocument = workspaceDocument({ title: 'Authenticated workspace review, revised' });
  const nextPublish = publish(sessionDir, 'workspace-next.json', nextDocument);
  assert.equal(nextPublish.status, 0, nextPublish.stderr);
  const retry = await submit(document.revision, 'Current Revision feedback.', ' retry-current-revision ');
  const retryText = await retry.text();
  assert.equal(retry.status, 201, retryText);
  assert.equal(JSON.parse(retryText).id, acceptedRecord.id);
  assert.equal(app.store.snapshot().events.length, 1, 'accepted retry must deduplicate before stale-Revision rejection');
});

test('v2 feedback cannot append while the active Visual Document is changing', async t => {
  const { address, app, sessionDir } = await startServer(t, 'workspace-feedback-state-lock');
  const document = workspaceDocument();
  const published = publish(sessionDir, 'workspace.json', document);
  assert.equal(published.status, 0, published.stderr);
  const cookie = await authenticatedCookie(address);
  const lockDir = path.join(sessionDir, 'state', '.visual-state.lock');
  fs.mkdirSync(lockDir);
  t.after(() => fs.rmSync(lockDir, { recursive: true, force: true }));

  const response = await fetch(`${address.url}${address.base_path}api/feedback`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientTurnId: 'feedback-during-state-change',
      message: 'This must not cross the Visual Document transaction.',
      screen: { id: 'architecture', file: 'screen.json', revision: document.revision },
    }),
  });

  assert.notEqual(response.status, 201, 'feedback must not append outside the Visual State lock');
  assert.match((await responseJson(response)).value.error, /state|change|progress|retry/i);
  assert.equal(app.store.snapshot().events.length, 0);
});

test('live Standalone Export preserves its last-good history when Session Store JSONL is corrupt', async t => {
  const { address, sessionDir } = await startServer(t, 'workspace-live-export-history');
  const loggedErrors = [];
  const originalConsoleError = console.error;
  console.error = (...values) => loggedErrors.push(values.map(String).join(' '));
  t.after(() => { console.error = originalConsoleError; });
  const document = workspaceDocument();
  const published = publish(sessionDir, 'workspace.json', document);
  assert.equal(published.status, 0, published.stderr);
  const cookie = await authenticatedCookie(address);
  const message = 'Feedback history must remain in the last-good export.';
  const submitted = await fetch(`${address.url}${address.base_path}api/feedback`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientTurnId: 'live-export-history-turn',
      message,
      screen: { id: 'architecture', file: 'screen.json', revision: document.revision },
    }),
  });
  assert.equal(submitted.status, 201, await submitted.text());

  const exportFile = path.join(sessionDir, 'visual.html');
  await waitFor(() => fs.readFileSync(exportFile, 'utf8').includes(message));
  const lastGood = fs.readFileSync(exportFile, 'utf8');
  fs.writeFileSync(path.join(sessionDir, 'state', 'session.jsonl'), '{"message":"truncated"');
  await new Promise(resolve => setTimeout(resolve, 150));

  assert.equal(fs.readFileSync(exportFile, 'utf8'), lastGood);
  assert.match(loggedErrors.join('\n'), /live export failed|session store|history|invalid/i);
});

test('v2 real-server boundaries reject unauthenticated, stale-capability, cross-origin, and oversized requests without disclosure', async t => {
  const { address, sessionDir } = await startServer(t, 'workspace-server-security');
  const loggedErrors = [];
  const originalConsoleError = console.error;
  console.error = (...values) => loggedErrors.push(values.map(String).join(' '));
  t.after(() => { console.error = originalConsoleError; });
  const document = workspaceDocument();
  const published = publish(sessionDir, 'workspace.json', document);
  assert.equal(published.status, 0, published.stderr);

  const unauthorized = await fetch(`${address.url}${address.base_path}api/screen`);
  assert.equal(unauthorized.status, 401);
  const unauthorizedBody = await responseJson(unauthorized);
  assertSecretSafe(unauthorizedBody.text, sessionDir);

  const stale = await fetch(`${address.url}${address.base_path}api/screen`, {
    headers: { Cookie: `brainstorm_session=${STALE_CAPABILITY}` },
  });
  assert.equal(stale.status, 401);
  const staleBody = await responseJson(stale);
  assertSecretSafe(staleBody.text, sessionDir);

  const cookie = await authenticatedCookie(address);
  const crossOrigin = await fetch(`${address.url}${address.base_path}api/feedback`, {
    method: 'POST',
    headers: {
      Cookie: cookie,
      'Content-Type': 'application/json',
      Origin: 'https://untrusted.example',
    },
    body: JSON.stringify({ message: PRIVATE_VALUE, screen: { revision: document.revision } }),
  });
  assert.equal(crossOrigin.status, 403);
  const crossOriginBody = await responseJson(crossOrigin);
  assertSecretSafe(crossOriginBody.text, sessionDir);

  const malformed = await fetch(`${address.url}${address.base_path}api/feedback`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: `{"message":"${PRIVATE_VALUE}",`,
  });
  assert.equal(malformed.status, 400);
  const malformedBody = await responseJson(malformed);
  assertSecretSafe(malformedBody.text, sessionDir);

  const oversized = await fetch(`${address.url}${address.base_path}api/feedback`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: PRIVATE_VALUE.repeat(2_000),
      padding: 'x'.repeat(70 * 1_024),
      screen: { revision: document.revision },
    }),
  });
  assert.equal(oversized.status, 413);
  const oversizedBody = await responseJson(oversized);
  assertSecretSafe(oversizedBody.text, sessionDir);

  await waitFor(() => fs.readFileSync(path.join(sessionDir, 'visual.html'), 'utf8')
    .includes(`"revision":"${document.revision}"`));
  const standalone = fs.readFileSync(path.join(sessionDir, 'visual.html'), 'utf8');
  assert.match(standalone, new RegExp(`"revision":"${document.revision}"`, 'u'));
  assertSecretSafe(standalone, sessionDir);
  assertSecretSafe(loggedErrors, sessionDir);
});

test('publishing multiple Workspace Tabs keeps every one simultaneously reachable, not just the active one', async t => {
  const { address, sessionDir } = await startServer(t, 'workspace-tabs-multi');
  const architecture = workspaceDocument({ title: 'Architecture Canvas' });
  const published = publishTab(sessionDir, 'architecture.json', architecture, 'architecture', 'Architecture Canvas');
  assert.equal(published.status, 0, published.stderr);
  const publishedTab = JSON.parse(published.stdout);
  assert.equal(publishedTab.tab_id, 'architecture');
  assert.equal(publishedTab.tab_label, 'Architecture Canvas');

  const stateMachine = workspaceDocument({ title: 'State Machine' });
  const publishedSecond = publishTab(sessionDir, 'state-machine.json', stateMachine, 'uml-state-machine', 'State Machine');
  assert.equal(publishedSecond.status, 0, publishedSecond.stderr);

  const cookie = await authenticatedCookie(address);
  const state = await fetch(`${address.url}${address.base_path}api/state`, { headers: { Cookie: cookie } });
  assert.equal(state.status, 200);
  const stateBody = await state.json();
  assert.equal(stateBody.activeTabId, 'uml-state-machine');
  assert.deepEqual(stateBody.tabs.map(tab => tab.id), ['architecture', 'uml-state-machine']);
  assert.equal(stateBody.tabs[0].label, 'Architecture Canvas');
  assert.equal(stateBody.tabs[1].label, 'State Machine');
  // The active document (screen) is the most recently published tab...
  assert.equal(stateBody.screen.title, 'State Machine');

  // ...but the FIRST tab's document is still fully reachable on demand, byte for byte.
  const firstTab = await fetch(`${address.url}${address.base_path}api/tab/architecture`, { headers: { Cookie: cookie } });
  assert.equal(firstTab.status, 200);
  const firstTabBody = await firstTab.json();
  assert.deepEqual(firstTabBody.document, architecture);
});

test('v2 feedback from a non-active Workspace Tab binds to that tab document, not the active one', async t => {
  const { address, sessionDir } = await startServer(t, 'workspace-tabs-feedback');
  const architecture = workspaceDocument({ title: 'Architecture Canvas' });
  const first = publishTab(sessionDir, 'architecture.json', architecture, 'architecture', 'Architecture Canvas');
  assert.equal(first.status, 0, first.stderr);
  const stateMachine = workspaceDocument({ title: 'State Machine' });
  const second = publishTab(sessionDir, 'state-machine.json', stateMachine, 'uml-state-machine', 'State Machine');
  assert.equal(second.status, 0, second.stderr);
  assert.notEqual(architecture.revision, stateMachine.revision);
  const cookie = await authenticatedCookie(address);

  function submit(screen, clientTurnId, annotations = []) {
    return fetch(`${address.url}${address.base_path}api/feedback`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientTurnId, message: 'Tab-scoped feedback.', annotations, screen }),
    });
  }

  // The active document is the state machine, but feedback drafted while viewing the first
  // tab must be accepted against THAT tab's revision instead of rejected as stale.
  const accepted = await submit({
    id: 'product',
    file: 'tab-architecture.json',
    revision: architecture.revision,
    tabId: 'architecture',
    tabLabel: 'Architecture Canvas',
  }, 'tab-feedback-accepted', [{
    id: 'note-1',
    comment: 'This boundary is unclear.',
    target: {
      componentId: 'concept-a',
      label: 'Concept A',
      tabId: 'architecture',
      frameId: 'frame-1',
      frameTitle: 'Concepts',
      excerpt: 'Concept A · point 1: first claim',
    },
  }]);
  assert.equal(accepted.status, 201, await accepted.clone().text());
  const record = await accepted.json();
  assert.equal(record.screen.tabId, 'architecture');
  assert.equal(record.screen.tabLabel, 'Architecture Canvas');
  assert.equal(record.annotations[0].target.tabId, 'architecture');
  assert.equal(record.annotations[0].target.frameTitle, 'Concepts');
  assert.match(record.annotations[0].target.excerpt, /point 1/);

  const staleRevision = architecture.revision === '00000000' ? '00000001' : '00000000';
  const stale = await submit({
    id: 'product',
    file: 'tab-architecture.json',
    revision: staleRevision,
    tabId: 'architecture',
  }, 'tab-feedback-stale');
  assert.equal(stale.status, 409);

  // An unknown tab id falls back to the active-document revision check.
  const unknownTabActiveRevision = await submit({
    id: 'product',
    file: 'workspace.json',
    revision: stateMachine.revision,
    tabId: 'deleted-tab',
  }, 'tab-feedback-unknown-active');
  assert.equal(unknownTabActiveRevision.status, 201, await unknownTabActiveRevision.clone().text());
  const unknownTabStaleRevision = await submit({
    id: 'product',
    file: 'workspace.json',
    revision: architecture.revision,
    tabId: 'deleted-tab',
  }, 'tab-feedback-unknown-stale');
  assert.equal(unknownTabStaleRevision.status, 409);
});

test('api/tab rejects an unknown tab id with 404 and a malformed tab id with 400', async t => {
  const { address, sessionDir } = await startServer(t, 'workspace-tabs-errors');
  const published = publishTab(sessionDir, 'architecture.json', workspaceDocument(), 'architecture', 'Architecture');
  assert.equal(published.status, 0, published.stderr);
  const cookie = await authenticatedCookie(address);

  const missing = await fetch(`${address.url}${address.base_path}api/tab/does-not-exist`, { headers: { Cookie: cookie } });
  assert.equal(missing.status, 404);

  const malformed = await fetch(`${address.url}${address.base_path}api/tab/Not%20Valid!`, { headers: { Cookie: cookie } });
  assert.equal(malformed.status, 400);

  const written = await fetch(`${address.url}${address.base_path}api/tab/architecture`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: 'http://malicious.local' },
    body: '{}',
  });
  assert.equal(written.status, 405);
});

test('republishing a second Workspace Tab notifies live SSE clients so the tab bar refreshes', async t => {
  const { address, sessionDir } = await startServer(t, 'workspace-tabs-sse');
  const published = publishTab(sessionDir, 'architecture.json', workspaceDocument(), 'architecture', 'Architecture');
  assert.equal(published.status, 0, published.stderr);
  const cookie = await authenticatedCookie(address);

  const events = await fetch(`${address.url}${address.base_path}api/events`, { headers: { Cookie: cookie } });
  const reader = events.body.getReader();
  t.after(() => reader.cancel());
  assert.match(await readUntil(reader, /connected/), /connected/);

  const second = publishTab(sessionDir, 'sequence.json', workspaceDocument({ title: 'Sequence' }), 'uml-sequence', 'Sequence');
  assert.equal(second.status, 0, second.stderr);
  assert.match(await readUntil(reader, /event: screen/), /event: screen/);
});
