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
