const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { parseOptions } = require('../scripts/visual-session.cjs');
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

test('parseOptions accepts value-less boolean flags alongside paired options', () => {
  assert.deepEqual(
    parseOptions(['--quiet', '--session-dir', '/tmp/session']),
    { quiet: true, sessionDir: '/tmp/session' },
  );
  assert.deepEqual(
    parseOptions(['--session-dir', '/tmp/session', '--quiet']),
    { quiet: true, sessionDir: '/tmp/session' },
  );
  assert.deepEqual(parseOptions(['--dry-run', '--all']), { dryRun: true, all: true });
  assert.throws(() => parseOptions(['--session-dir']), /invalid option/);
  assert.throws(() => parseOptions(['--nonsense', 'x']), /unknown option/);
});

test('validate accepts a well-formed Visual Document candidate without serving it', t => {
  const candidateFile = path.join(createScratchDirectory(t, 'validate-document'), 'workspace.json');
  fs.writeFileSync(candidateFile, `${JSON.stringify(workspaceFixture('Candidate concepts'))}\n`);

  const result = childProcess.spawnSync(process.execPath, [
    sessionCli,
    'validate',
    '--document', candidateFile,
  ], { cwd: repositoryRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.type, 'visual-document.validated');
  assert.equal(output.source, 'document');
  assert.equal(output.workspace_kind, 'product');
  assert.equal(output.revision, normalizedFixture('Candidate concepts').revision);
  assert.equal(output.render_preflight, 'not_applicable');
});

test('validate fails closed on a malformed candidate', t => {
  const candidateFile = path.join(createScratchDirectory(t, 'validate-malformed'), 'workspace.json');
  fs.writeFileSync(candidateFile, '{"version":2,"broken":\n');

  const result = childProcess.spawnSync(process.execPath, [
    sessionCli,
    'validate',
    '--document', candidateFile,
  ], { cwd: repositoryRoot, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invalid json/i);
});

test('present --quiet reuses the live session and omits verbose payloads', t => {
  const sessionDir = createScratchDirectory(t, 'present-quiet-live');
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
    url: 'http://localhost:39999',
    base_path: '/session/test-1234abcd/',
    persistent: true,
    pid: process.pid,
  })}\n`);
  fs.writeFileSync(
    path.join(stateDir, 'capability.json'),
    `${JSON.stringify({ token: 'f'.repeat(48) })}\n`,
  );
  const candidateFile = path.join(createScratchDirectory(t, 'present-quiet-candidate'), 'workspace.json');
  fs.writeFileSync(candidateFile, `${JSON.stringify(workspaceFixture('Represented concepts'))}\n`);

  const result = childProcess.spawnSync(process.execPath, [
    sessionCli,
    'present',
    '--session-dir', sessionDir,
    '--document', candidateFile,
    '--quiet',
  ], { cwd: repositoryRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.type, 'visual-session-represented');
  assert.equal(output.revision, normalizedFixture('Represented concepts').revision);
  assert.match(output.connection_url, /\/session\/test-1234abcd\/\?token=/u);
  assert.equal(Object.hasOwn(output, 'elk_preflight'), false, '--quiet must drop preflight geometry');
  assert.equal(Object.hasOwn(output, 'feedback_delivery'), false);

  const published = JSON.parse(fs.readFileSync(path.join(contentDir, 'workspace.json'), 'utf8'));
  assert.equal(published.title, 'Represented concepts');
});
