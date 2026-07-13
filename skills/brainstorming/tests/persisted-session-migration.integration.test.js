const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { SessionStore } = require('../scripts/session-store.cjs');
const { normalizeVisualDocument } = require('../scripts/visual-document.cjs');
const { createScratchDirectory } = require('./test-support');

const sessionCli = path.resolve(__dirname, '../scripts/visual-session.cjs');
const repositoryRoot = path.resolve(__dirname, '../../..');

function runSession(...args) {
  return childProcess.spawnSync(process.execPath, [sessionCli, ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: process.env,
  });
}

function parseEmbeddedState(html) {
  const match = html.match(/window\.__BRAINSTORM_EMBEDDED__ = (\{[\s\S]*?\});/u);
  assert.ok(match, 'standalone export must embed its complete state');
  return JSON.parse(match[1]);
}

function legacyDocument() {
  return normalizeVisualDocument({
    version: 1,
    profile: 'technical',
    audience: 'Software developers',
    title: 'Persisted Visual Session',
    summary: 'Keep the original session durable during the v2 migration.',
    sections: [{
      kind: 'decision',
      id: 'transport',
      title: 'Choose transport',
      options: [
        { id: 'sse', label: 'SSE', points: ['Resume from durable feedback.'] },
        { id: 'polling', label: 'Polling' },
      ],
    }],
  });
}

function seedPersistedV1(t, purpose) {
  const sessionDir = createScratchDirectory(t, purpose);
  const contentDir = path.join(sessionDir, 'content');
  const stateDir = path.join(sessionDir, 'state');
  fs.mkdirSync(contentDir, { recursive: true });

  const document = legacyDocument();
  const screenFile = path.join(contentDir, 'screen.json');
  fs.writeFileSync(screenFile, `${JSON.stringify(document)}\n`, { mode: 0o600 });

  const generatedIds = ['event-feedback-1', 'event-reply-1', 'cursor-write-1'];
  const store = new SessionStore(stateDir, {
    now: () => 1_725_000_000_000,
    randomUUID: () => generatedIds.shift(),
  });
  const feedback = store.appendBrowserTurn({
    clientTurnId: 'client-turn-1',
    message: 'Keep the reconnect evidence visible.',
    annotations: [{
      id: 'annotation-1',
      comment: 'This Component identity must survive.',
      target: { componentId: 'sse', selector: null, label: 'SSE' },
    }],
    choices: [{
      groupId: 'transport',
      componentId: 'sse',
      value: 'sse',
      label: 'SSE',
    }],
    screen: { id: 'screen', file: 'screen.json', revision: 'a1b2c3d4' },
  });
  store.publishAgentReply({
    replyTo: feedback.seq,
    message: 'Reconnect evidence remains part of the Decision.',
  });

  const eventsFile = path.join(stateDir, 'session.jsonl');
  const cursorFile = path.join(stateDir, 'agent-cursor.json');
  return {
    sessionDir,
    document,
    original: {
      screen: fs.readFileSync(screenFile),
      events: fs.readFileSync(eventsFile),
      cursor: fs.readFileSync(cursorFile),
      snapshot: store.snapshot(),
    },
  };
}

function assertOriginalV1Bytes(seed) {
  assert.deepEqual(
    fs.readFileSync(path.join(seed.sessionDir, 'content', 'screen.json')),
    seed.original.screen,
  );
  assert.deepEqual(
    fs.readFileSync(path.join(seed.sessionDir, 'state', 'session.jsonl')),
    seed.original.events,
  );
  assert.deepEqual(
    fs.readFileSync(path.join(seed.sessionDir, 'state', 'agent-cursor.json')),
    seed.original.cursor,
  );
}

function filesBelow(root) {
  const files = [];
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(candidate);
      else if (entry.isFile()) files.push(candidate);
    }
  };
  visit(root);
  return files;
}

function findWorkspaceFile(sessionDir, excluded = new Set()) {
  return filesBelow(sessionDir).find(file => {
    if (excluded.has(file)) return false;
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      return value?.version === 2 && typeof value.workspace_kind === 'string';
    } catch {
      return false;
    }
  });
}

test('persisted v1 Session Store migrates side by side and CLI backout restores the exact v1 active state', t => {
  const seed = seedPersistedV1(t, 'persisted-v1-migration-private-path');
  const output = path.join(seed.sessionDir, 'migrated-visual.html');
  const workId = 'work-20260712-visual-companion-vnext';
  const originalFiles = new Set(filesBelow(seed.sessionDir));

  const migrated = runSession(
    'migrate',
    '--session-dir', seed.sessionDir,
    '--work-id', workId,
    '--workspace-kind', 'review',
  );
  assert.equal(migrated.status, 0, migrated.stderr);
  const migratedResult = JSON.parse(migrated.stdout);
  assert.match(migratedResult.type, /migrated/u);
  assert.equal(migratedResult.active_version, 2);
  assert.equal(migrated.stdout.includes(seed.sessionDir), false, 'migration output must not expose private paths');
  assertOriginalV1Bytes(seed);

  const workspaceFile = findWorkspaceFile(seed.sessionDir, originalFiles);
  assert.ok(workspaceFile, 'migration must persist one discoverable v2 Visual Document side by side');
  const workspaceBytes = fs.readFileSync(workspaceFile);
  const workspace = JSON.parse(workspaceBytes);
  assert.equal(workspace.version, 2);
  assert.equal(workspace.work_id, workId);
  assert.equal(workspace.workspace_kind, 'review');
  assert.equal(workspace.read_only, true);
  assert.deepEqual(workspace.feedback_threads.map(thread => ({
    id: thread.id,
    component_id: thread.component_id,
    revision: thread.revision,
  })), [{ id: 'annotation-1', component_id: 'sse', revision: 'a1b2c3d4' }]);
  assert.equal(workspace.feedback_threads.some(thread => Object.hasOwn(thread, 'choices')), false);
  assert.equal(workspace.feedback_threads.some(thread => Object.hasOwn(thread, 'message')), false);

  const exportedV2 = runSession('export', '--session-dir', seed.sessionDir, '--output', output);
  assert.equal(exportedV2.status, 0, exportedV2.stderr);
  const v2State = parseEmbeddedState(fs.readFileSync(output, 'utf8'));
  assert.equal(v2State.screen.version, 2);
  assert.equal(v2State.screen.workspace_kind, 'review');
  assert.deepEqual(v2State.session.events, seed.original.snapshot.events);
  assert.equal(v2State.session.events[0].id, 'event-feedback-1');
  assert.equal(v2State.session.events[0].clientTurnId, 'client-turn-1');
  assert.equal(v2State.session.events[0].message, 'Keep the reconnect evidence visible.');
  assert.equal(v2State.session.events[0].annotations[0].id, 'annotation-1');
  assert.deepEqual(v2State.session.events[0].choices, [{
    groupId: 'transport', componentId: 'sse', value: 'sse', label: 'SSE',
  }]);
  assert.equal(v2State.session.events[0].screen.revision, 'a1b2c3d4');

  const backedOut = runSession('backout', '--session-dir', seed.sessionDir);
  assert.equal(backedOut.status, 0, backedOut.stderr);
  const backoutResult = JSON.parse(backedOut.stdout);
  assert.match(backoutResult.type, /backout/u);
  assert.equal(backoutResult.active_version, 1);
  assert.equal(backedOut.stdout.includes(seed.sessionDir), false, 'backout output must not expose private paths');
  assertOriginalV1Bytes(seed);
  assert.deepEqual(fs.readFileSync(workspaceFile), workspaceBytes, 'backout must retain the v2 state byte for byte');

  const unsafePublish = runSession(
    'publish',
    '--document', workspaceFile,
    '--session-dir', seed.sessionDir,
  );
  assert.notEqual(unsafePublish.status, 0, 'v2 Publish must not overwrite a backed-out v1 Visual Document');
  assert.match(unsafePublish.stderr, /migrate|active v1|backout/i);
  assertOriginalV1Bytes(seed);
  assert.deepEqual(fs.readFileSync(workspaceFile), workspaceBytes);

  const exportedV1 = runSession('export', '--session-dir', seed.sessionDir, '--output', output);
  assert.equal(exportedV1.status, 0, exportedV1.stderr);
  const v1State = parseEmbeddedState(fs.readFileSync(output, 'utf8'));
  assert.deepEqual(v1State.screen, seed.document);
  assert.deepEqual(v1State.session.events, seed.original.snapshot.events);
  assert.equal(v1State.session.cursor, seed.original.snapshot.cursor);
});

test('persisted-session migration reactivates retained byte-identical v2 state after backout without leaking its path', t => {
  const seed = seedPersistedV1(t, 'persisted-v1-non-overwrite-private-path');
  const originalFiles = new Set(filesBelow(seed.sessionDir));

  const firstMigration = runSession(
    'migrate',
    '--session-dir', seed.sessionDir,
    '--work-id', 'work-20260712-visual-companion-vnext',
    '--workspace-kind', 'review',
  );
  assert.equal(firstMigration.status, 0, firstMigration.stderr);
  const workspaceFile = findWorkspaceFile(seed.sessionDir, originalFiles);
  assert.ok(workspaceFile);
  const existingV2 = fs.readFileSync(workspaceFile);

  const backedOut = runSession('backout', '--session-dir', seed.sessionDir);
  assert.equal(backedOut.status, 0, backedOut.stderr);

  const reactivated = runSession(
    'migrate',
    '--session-dir', seed.sessionDir,
    '--work-id', 'work-20260712-visual-companion-vnext',
    '--workspace-kind', 'review',
  );

  assert.equal(reactivated.status, 0, reactivated.stderr);
  const result = JSON.parse(reactivated.stdout);
  assert.equal(result.active_version, 2);
  assert.match(result.type, /migrated|reactivated/u);
  assert.equal(reactivated.stdout.includes(seed.sessionDir), false);
  assert.deepEqual(fs.readFileSync(workspaceFile), existingV2);
  assertOriginalV1Bytes(seed);
});

test('persisted-session backout refuses a non-v1 fallback and leaves v2 active', t => {
  const seed = seedPersistedV1(t, 'persisted-v1-invalid-backout');
  const migrated = runSession(
    'migrate',
    '--session-dir', seed.sessionDir,
    '--work-id', 'work-20260712-visual-companion-vnext',
    '--workspace-kind', 'review',
  );
  assert.equal(migrated.status, 0, migrated.stderr);
  const workspaceFile = findWorkspaceFile(seed.sessionDir, new Set());
  assert.ok(workspaceFile);
  const workspaceBytes = fs.readFileSync(workspaceFile);
  const screenFile = path.join(seed.sessionDir, 'content', 'screen.json');
  fs.writeFileSync(screenFile, workspaceBytes);

  const backedOut = runSession('backout', '--session-dir', seed.sessionDir);
  assert.notEqual(backedOut.status, 0);
  assert.match(backedOut.stderr, /v1|legacy|backout|visual document/i);
  assert.equal(backedOut.stderr.includes(seed.sessionDir), false);
  assert.deepEqual(fs.readFileSync(workspaceFile), workspaceBytes);
  assert.equal(JSON.parse(fs.readFileSync(path.join(seed.sessionDir, 'state', 'visual-format.json'), 'utf8')).active_version, 2);
});
