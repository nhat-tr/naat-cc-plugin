const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createBrainstormServer } = require('../scripts/server.cjs');
const { createScratchDirectory } = require('./test-support');

const CAPABILITY = 'current-capability-value';
const STALE_CAPABILITY = 'stale-capability-value';
const PRIVATE_VALUE = 'private-value-that-must-not-appear';

function v1Document() {
  return {
    version: 1,
    profile: 'technical',
    title: 'Security boundary fixture',
    sections: [{
      kind: 'callout',
      id: 'security-boundary',
      title: 'Security boundary',
      body: 'Only the active capability may read this Visual Document.',
    }],
  };
}

function workspaceContract() {
  return require('../scripts/workspace-document.cjs');
}

function workspaceDocument(overrides = {}) {
  return {
    version: 2,
    work_id: 'work-20260712-visual-companion-vnext',
    workspace_kind: 'architecture',
    title: 'Security boundary fixture',
    evidence_refs: [{ id: 'EVD-001', label: 'Observed architecture' }],
    frames: [{ id: 'frame-main', title: 'Current architecture', component_ids: ['service-boundary'] }],
    components: [{ id: 'service-boundary', frame_id: 'frame-main', label: 'Service boundary' }],
    decisions: [],
    feedback_threads: [],
    content: { nodes: [] },
    read_only: false,
    ...overrides,
  };
}

function normalize(document) {
  const { documentRevision, normalizeWorkspaceDocument } = workspaceContract();
  const candidate = structuredClone(document);
  if (!Object.hasOwn(candidate, 'revision')) candidate.revision = documentRevision(candidate);
  return normalizeWorkspaceDocument(candidate, {
    contentValidator: content => structuredClone(content),
  });
}

function assertSecretSafe(error) {
  const serialized = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : JSON.stringify(error);
  assert.doesNotMatch(serialized, new RegExp(CAPABILITY, 'u'));
  assert.doesNotMatch(serialized, new RegExp(STALE_CAPABILITY, 'u'));
  assert.doesNotMatch(serialized, new RegExp(PRIVATE_VALUE, 'u'));
}

test('visual security rejects oversized v2 envelopes before content validation', () => {
  const { MAX_WORKSPACE_DOCUMENT_BYTES, normalizeWorkspaceDocument } = workspaceContract();
  assert.equal(Number.isSafeInteger(MAX_WORKSPACE_DOCUMENT_BYTES), true);
  assert.ok(MAX_WORKSPACE_DOCUMENT_BYTES > 0);
  let contentValidationCalls = 0;

  assert.throws(() => normalizeWorkspaceDocument(workspaceDocument({
    content: { padding: 'x'.repeat(MAX_WORKSPACE_DOCUMENT_BYTES + 1) },
  }), {
    contentValidator: content => {
      contentValidationCalls += 1;
      return content;
    },
  }), /workspace.*exceeds|too large|bytes/i);
  assert.equal(contentValidationCalls, 0);
});

test('visual security rejects unknown and secret-bearing envelope fields without echoing their values', () => {
  for (const [field, value] of [
    ['capability_token', CAPABILITY],
    ['prompt', PRIVATE_VALUE],
    ['transcript', PRIVATE_VALUE],
    ['html', `<script>${PRIVATE_VALUE}</script>`],
    ['__proto__', { polluted: true }],
    ['constructor', { prototype: { polluted: true } }],
  ]) {
    let rejection;
    try {
      normalize(workspaceDocument({ [field]: value }));
    } catch (error) {
      rejection = error;
    }
    assert.ok(rejection, `${field} must be rejected`);
    assert.match(rejection.message, /unsupported|unknown|not allowed/i);
    assertSecretSafe(rejection);
  }
});

test('visual security rejects malformed references, identifiers, Revisions, and duplicate identities', () => {
  const invalidDocuments = [
    workspaceDocument({ revision: 'latest' }),
    workspaceDocument({ evidence_refs: [{ label: 'Missing stable identity' }] }),
    workspaceDocument({ evidence_refs: [{ id: 'EVD-001', label: 'Traversal', path: '../../private.json' }] }),
    workspaceDocument({ frames: [{ id: '../frame', title: 'Traversal', component_ids: [] }] }),
    workspaceDocument({
      components: [
        { id: 'service-boundary', frame_id: 'frame-main', label: 'First' },
        { id: 'service-boundary', frame_id: 'frame-main', label: 'Duplicate' },
      ],
    }),
    workspaceDocument({
      frames: [{ id: 'frame-main', title: 'Current architecture', component_ids: ['missing-component'] }],
      components: [],
    }),
  ];

  for (const document of invalidDocuments) {
    assert.throws(() => normalize(document), /revision|evidence|unsupported.*path|identifier|duplicate|component/i);
  }
});

test('visual security preserves the existing capability, same-origin, and request-size baseline', async t => {
  const sessionDir = createScratchDirectory(t, 'visual-security-capability');
  const contentDir = path.join(sessionDir, 'content');
  fs.mkdirSync(contentDir, { recursive: true });
  fs.writeFileSync(path.join(contentDir, 'screen.json'), `${JSON.stringify(v1Document())}\n`);
  const app = createBrainstormServer({
    sessionDir,
    token: CAPABILITY,
    sessionId: 'visual-security-capability-session',
    idleTimeoutMs: 60_000,
  });
  const address = await app.listen();
  t.after(() => app.close());

  const stale = await fetch(`${address.url}${address.base_path}api/screen`, {
    headers: { Cookie: `brainstorm_session=${STALE_CAPABILITY}` },
  });
  assert.equal(stale.status, 401);
  const stalePayload = await stale.json();
  assert.deepEqual(stalePayload, { error: 'unauthorized visual session' });
  assertSecretSafe(stalePayload);
  assert.equal(JSON.stringify(stalePayload).includes(sessionDir), false);

  const root = await fetch(address.connection_url);
  const cookie = root.headers.get('set-cookie').split(';')[0];
  const crossOrigin = await fetch(`${address.url}${address.base_path}api/feedback`, {
    method: 'POST',
    headers: {
      Cookie: cookie,
      'Content-Type': 'application/json',
      Origin: 'https://untrusted.example',
    },
    body: JSON.stringify({ message: PRIVATE_VALUE }),
  });
  assert.equal(crossOrigin.status, 403);
  const crossOriginPayload = await crossOrigin.json();
  assert.deepEqual(crossOriginPayload, { error: 'cross-origin feedback rejected' });
  assertSecretSafe(crossOriginPayload);

  const oversized = await fetch(`${address.url}${address.base_path}api/feedback`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'x'.repeat(70 * 1024) }),
  });
  assert.equal(oversized.status, 413);
  assertSecretSafe(await oversized.json());
});

test('visual security refuses a screen.json symlink instead of reading outside the Visual Session', t => {
  const sessionDir = createScratchDirectory(t, 'visual-security-symlink');
  const outsideDir = createScratchDirectory(t, 'visual-security-outside');
  const outsideFile = path.join(outsideDir, 'private-screen.json');
  fs.writeFileSync(outsideFile, `${JSON.stringify(v1Document())}\n`);

  const app = createBrainstormServer({
    sessionDir,
    token: CAPABILITY,
    sessionId: 'visual-security-symlink-session',
    idleTimeoutMs: 60_000,
  });
  t.after(() => app.close());
  fs.symlinkSync(outsideFile, app.screenPath);

  let rejection;
  try {
    app.readScreen();
  } catch (error) {
    rejection = error;
  }

  assert.ok(rejection, 'screen.json symlinks must be rejected');
  assert.match(rejection.message, /symlink|regular file|outside/i);
  assert.equal(rejection.message.includes(outsideDir), false);
  assertSecretSafe(rejection);
});

test('visual security rejects malformed active-format metadata instead of silently selecting v1', t => {
  const sessionDir = createScratchDirectory(t, 'visual-security-format');
  const app = createBrainstormServer({
    sessionDir,
    token: CAPABILITY,
    sessionId: 'visual-security-format-session',
    idleTimeoutMs: 60_000,
  });
  t.after(() => app.close());
  fs.writeFileSync(app.screenPath, `${JSON.stringify(v1Document())}\n`);
  fs.writeFileSync(path.join(app.stateDir, 'visual-format.json'), `${JSON.stringify({
    version: 99,
    active_version: 7,
    private_path: PRIVATE_VALUE,
  })}\n`);

  assert.throws(() => app.readScreen(), /visual format|metadata|malformed/i);
});

test('visual security fails closed on missing active state and redacts malformed JSON details', async t => {
  const sessionDir = createScratchDirectory(t, 'visual-security-active-state');
  const app = createBrainstormServer({
    sessionDir,
    token: CAPABILITY,
    sessionId: 'visual-security-active-state-session',
    idleTimeoutMs: 60_000,
  });
  const address = await app.listen();
  t.after(() => app.close());
  fs.writeFileSync(path.join(app.stateDir, 'visual-format.json'), `${JSON.stringify({
    version: 1,
    active_version: 2,
    v1_document: 'content/screen.json',
    v2_document: 'content/workspace.json',
  })}\n`);

  assert.throws(() => app.readScreen(), /active|workspace|unavailable|visual document/i);
  const cookie = (await fetch(address.connection_url)).headers.get('set-cookie').split(';')[0];
  const screen = await fetch(`${address.url}${address.base_path}api/screen`, { headers: { Cookie: cookie } });
  assert.equal(screen.status, 422);
  assertSecretSafe(await screen.json());
  const feedback = await fetch(`${address.url}${address.base_path}api/feedback`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientTurnId: 'missing-active-feedback',
      message: PRIVATE_VALUE,
      screen: { revision: 'a1b2c3d4' },
    }),
  });
  assert.equal(feedback.status, 400);
  assertSecretSafe(await feedback.json());
  assert.equal(app.store.snapshot().events.length, 0);

  fs.rmSync(path.join(app.stateDir, 'visual-format.json'));
  fs.writeFileSync(app.screenPath, `{"version":1,"private":"${PRIVATE_VALUE}",`);
  let malformed;
  try { app.readScreen(); } catch (error) { malformed = error; }
  assert.ok(malformed);
  assert.match(malformed.message, /invalid json|visual document/i);
  assertSecretSafe(malformed);
});
