const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { appendRevisionSnapshot, readRevisionSnapshots } = require('../scripts/revision-archive.cjs');
const { buildStandaloneHtml } = require('../scripts/visual-session.cjs');
const { createScratchDirectory } = require('./test-support');

const sessionCli = path.resolve(__dirname, '../scripts/visual-session.cjs');
const repositoryRoot = path.resolve(__dirname, '../../..');

function workspaceFixture(title) {
  const document = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '../fixtures/product-concept-set.json'),
    'utf8',
  ));
  document.title = title;
  delete document.revision;
  return document;
}

function normalizedFixture(title) {
  const { normalizeWorkspaceDocument } = require('../scripts/workspace-document.cjs');
  const { normalizeKnownWorkspaceContent } = require('../scripts/workspace-content.cjs');
  return normalizeWorkspaceDocument(workspaceFixture(title), {
    contentValidator: normalizeKnownWorkspaceContent,
  });
}

function liveSessionFixture(t, purpose) {
  const sessionDir = createScratchDirectory(t, purpose);
  const contentDir = path.join(sessionDir, 'content');
  const stateDir = path.join(sessionDir, 'state');
  fs.mkdirSync(contentDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(contentDir, 'workspace.json'),
    `${JSON.stringify(normalizedFixture('Initial concepts'))}\n`,
  );
  fs.writeFileSync(path.join(stateDir, 'visual-format.json'), `${JSON.stringify({
    version: 1,
    active_version: 2,
    v1_document: 'content/screen.json',
    v2_document: 'content/workspace.json',
  })}\n`);
  fs.writeFileSync(path.join(stateDir, 'session-meta.json'), `${JSON.stringify({
    session_dir: sessionDir,
    content_dir: contentDir,
    state_dir: stateDir,
    persistent: true,
    pid: process.pid,
  })}\n`);
  return { sessionDir, contentDir, stateDir };
}

test('appendRevisionSnapshot records ordered snapshots and skips consecutive duplicates', t => {
  const stateDir = path.join(createScratchDirectory(t, 'revision-archive-unit'), 'state');
  const first = normalizedFixture('First');
  const second = normalizedFixture('Second');

  assert.deepEqual(readRevisionSnapshots(stateDir), []);
  const appended = appendRevisionSnapshot(stateDir, first, { timestamp: 1_725_000_000_000 });
  assert.deepEqual({ appended: appended.appended, seq: appended.seq }, { appended: true, seq: 1 });
  const duplicate = appendRevisionSnapshot(stateDir, first);
  assert.deepEqual({ appended: duplicate.appended, seq: duplicate.seq }, { appended: false, seq: 1 });
  const next = appendRevisionSnapshot(stateDir, second, { timestamp: 1_725_000_000_500 });
  assert.deepEqual({ appended: next.appended, seq: next.seq }, { appended: true, seq: 2 });
  const reverted = appendRevisionSnapshot(stateDir, first);
  assert.equal(reverted.appended, true, 'returning to earlier content is a new timeline step');

  const snapshots = readRevisionSnapshots(stateDir);
  assert.equal(snapshots.length, 3);
  assert.deepEqual(snapshots.map(snapshot => snapshot.seq), [1, 2, 3]);
  assert.equal(snapshots[0].revision, first.revision);
  assert.equal(snapshots[0].timestamp, 1_725_000_000_000);
  assert.deepEqual(snapshots[0].document, first);
  assert.equal(snapshots[1].revision, second.revision);
});

test('appendRevisionSnapshot ignores documents without a v2 revision', t => {
  const stateDir = path.join(createScratchDirectory(t, 'revision-archive-v1'), 'state');
  const result = appendRevisionSnapshot(stateDir, { version: 1, title: 'Legacy', sections: [] });
  assert.deepEqual(result, { appended: false, seq: null });
  assert.deepEqual(readRevisionSnapshots(stateDir), []);
  assert.equal(fs.existsSync(path.join(stateDir, 'revisions.jsonl')), false);
});

test('readRevisionSnapshots fails closed on corrupt history', t => {
  const stateDir = path.join(createScratchDirectory(t, 'revision-archive-corrupt'), 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'revisions.jsonl'), '{"version":1,"seq":\n');
  assert.throws(() => readRevisionSnapshots(stateDir), /revision history/i);
});

test('publish archives each new document revision into revisions.jsonl', t => {
  const { sessionDir, contentDir, stateDir } = liveSessionFixture(t, 'publish-archives-revisions');
  const candidateFile = path.join(createScratchDirectory(t, 'publish-candidates'), 'workspace.json');
  fs.writeFileSync(candidateFile, `${JSON.stringify(workspaceFixture('Revised concepts'))}\n`);

  const result = childProcess.spawnSync(process.execPath, [
    sessionCli,
    'publish',
    '--session-dir', sessionDir,
    '--document', candidateFile,
  ], { cwd: repositoryRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);

  const published = JSON.parse(fs.readFileSync(path.join(contentDir, 'workspace.json'), 'utf8'));
  const snapshots = readRevisionSnapshots(stateDir);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].revision, published.revision);
  assert.deepEqual(snapshots[0].document, published);

  const repeat = childProcess.spawnSync(process.execPath, [
    sessionCli,
    'publish',
    '--session-dir', sessionDir,
    '--document', candidateFile,
  ], { cwd: repositoryRoot, encoding: 'utf8' });
  assert.equal(repeat.status, 0, repeat.stderr);
  assert.equal(readRevisionSnapshots(stateDir).length, 1, 'identical republish must not duplicate history');
});

test('standalone export embeds the revision timeline and stamps the exported marker', t => {
  const { sessionDir, stateDir } = liveSessionFixture(t, 'export-embeds-revisions');
  const first = normalizedFixture('First pass');
  const second = normalizedFixture('Second pass');
  appendRevisionSnapshot(stateDir, first, { timestamp: 1_725_000_000_000 });
  appendRevisionSnapshot(stateDir, second, { timestamp: 1_725_000_100_000 });
  fs.writeFileSync(path.join(stateDir, 'session.jsonl'), `${JSON.stringify({
    version: 1,
    id: 'event-1',
    seq: 1,
    timestamp: 1_725_000_050_000,
    type: 'user.turn',
    role: 'user',
    clientTurnId: 'turn-1',
    message: 'Feedback against the first pass.',
    annotations: [],
    choices: [],
    screen: { id: 'product', file: 'workspace.json', revision: first.revision },
  })}\n`);
  fs.writeFileSync(path.join(stateDir, 'agent-cursor.json'), '{"seq":0}\n');
  const output = path.join(createScratchDirectory(t, 'export-output'), 'visual.html');

  const result = childProcess.spawnSync(process.execPath, [
    sessionCli,
    'export',
    '--session-dir', sessionDir,
    '--output', output,
  ], { cwd: repositoryRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);

  const html = fs.readFileSync(output, 'utf8');
  const match = html.match(/window\.__BRAINSTORM_EMBEDDED__ = (\{[\s\S]*?\});/u);
  assert.ok(match, 'standalone export must embed its state');
  const state = JSON.parse(match[1]);
  assert.equal(Array.isArray(state.revisions), true, 'embedded state must carry the revision timeline');
  assert.equal(state.revisions.length, 2);
  assert.deepEqual(state.revisions.map(snapshot => snapshot.seq), [1, 2]);
  assert.equal(state.revisions[0].revision, first.revision);
  assert.deepEqual(state.revisions[0].document, first);
  assert.equal(state.revisions[1].revision, second.revision);

  const marker = JSON.parse(fs.readFileSync(path.join(stateDir, 'exported.json'), 'utf8'));
  assert.equal(marker.export_file, output);
  assert.equal(typeof marker.exported_at, 'string');
});

test('buildStandaloneHtml omits the revisions key when no history exists', () => {
  const screen = normalizedFixture('No history');
  const html = buildStandaloneHtml(screen, { version: 1, cursor: 0, pendingTurns: 0, events: [] });
  const match = html.match(/window\.__BRAINSTORM_EMBEDDED__ = (\{[\s\S]*?\});/u);
  assert.ok(match);
  const state = JSON.parse(match[1]);
  assert.equal(Object.hasOwn(state, 'revisions'), false);
});
