const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createScratchDirectory } = require('./test-support');

const sessionCli = path.resolve(__dirname, '../scripts/visual-session.cjs');

function projectKey(projectDir) {
  const digest = crypto.createHash('sha256').update(path.resolve(projectDir)).digest('hex').slice(0, 8);
  return `${path.basename(projectDir)}-${digest}`;
}

function cliEnvironment(scratchDir) {
  const env = { ...process.env, CLAUDE_SCRATCH_DIR: scratchDir };
  delete env.CODEX_THREAD_ID;
  return env;
}

function runSessions(args, scratchDir, projectDir) {
  return childProcess.spawnSync(process.execPath, [sessionCli, 'sessions', ...args], {
    cwd: projectDir,
    env: cliEnvironment(scratchDir),
    encoding: 'utf8',
  });
}

// A dead, exportable v1 session directory in the layout start() produces.
function seedSession(scratchDir, projectDir, sessionId, options = {}) {
  const brainstormDir = path.join(scratchDir, projectKey(projectDir), 'brainstorm');
  const sessionDir = path.join(brainstormDir, sessionId);
  const contentDir = path.join(sessionDir, 'content');
  const stateDir = path.join(sessionDir, 'state');
  fs.mkdirSync(contentDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(contentDir, 'screen.json'), `${JSON.stringify({
    version: 1,
    profile: 'technical',
    title: `Session ${sessionId}`,
    sections: [{ kind: 'callout', id: 'note', title: 'Note', body: 'Durable content.' }],
  })}\n`);
  fs.writeFileSync(path.join(stateDir, 'session.jsonl'), `${JSON.stringify({
    version: 1,
    id: 'event-1',
    seq: 1,
    timestamp: 1_725_000_000_000,
    type: 'user.turn',
    role: 'user',
    clientTurnId: `${sessionId}-turn-1`,
    message: 'Recorded feedback.',
    annotations: [],
    choices: [],
    screen: null,
  })}\n`);
  fs.writeFileSync(path.join(stateDir, 'agent-cursor.json'), '{"seq":0}\n');
  fs.writeFileSync(path.join(stateDir, 'session-meta.json'), `${JSON.stringify({
    session_id: sessionId,
    session_dir: sessionDir,
    content_dir: contentDir,
    state_dir: stateDir,
    artifact_dir: options.artifactDir ?? null,
    persistent: false,
    pid: options.pid ?? null,
  })}\n`);
  if (options.exportedAt) {
    fs.writeFileSync(path.join(stateDir, 'exported.json'), `${JSON.stringify({
      exported_at: options.exportedAt,
      export_file: '/nowhere/visual.html',
    })}\n`);
  }
  if (options.ageDays) {
    const past = new Date(Date.now() - options.ageDays * 86_400_000);
    for (const directory of [contentDir, stateDir]) {
      for (const name of fs.readdirSync(directory)) {
        fs.utimesSync(path.join(directory, name), past, past);
      }
    }
  }
  return sessionDir;
}

test('sessions list reports liveness, history counts, and export state per session', t => {
  const scratchDir = createScratchDirectory(t, 'sessions-list-scratch');
  const projectDir = createScratchDirectory(t, 'sessions-list-project');
  seedSession(scratchDir, projectDir, 'aaaaaaaa-dead0001');
  seedSession(scratchDir, projectDir, 'bbbbbbbb-dead0002', { exportedAt: '2026-07-01T00:00:00.000Z' });
  seedSession(scratchDir, projectDir, 'cccccccc-live0003', { pid: process.pid });

  const result = runSessions(['list'], scratchDir, projectDir);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.type, 'visual-sessions');
  assert.equal(output.sessions.length, 3);
  const byId = new Map(output.sessions.map(session => [session.session_id, session]));

  const dead = byId.get('aaaaaaaa-dead0001');
  assert.equal(dead.live, false);
  assert.equal(dead.feedback_turns, 1);
  assert.equal(dead.exported_at, null);
  assert.equal(typeof dead.modified, 'string');
  assert.equal(dead.size_bytes > 0, true);

  assert.equal(byId.get('bbbbbbbb-dead0002').exported_at, '2026-07-01T00:00:00.000Z');
  assert.equal(byId.get('cccccccc-live0003').live, true);
});

test('sessions archive exports a dead session then removes its scratch directory', t => {
  const scratchDir = createScratchDirectory(t, 'sessions-archive-scratch');
  const projectDir = createScratchDirectory(t, 'sessions-archive-project');
  const sessionDir = seedSession(scratchDir, projectDir, 'dddddddd-dead0004');
  const output = path.join(createScratchDirectory(t, 'sessions-archive-output'), 'visual.html');

  const result = runSessions(['archive', '--session-dir', sessionDir, '--output', output], scratchDir, projectDir);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.type, 'visual-session-archived');
  assert.equal(parsed.export_file, output);
  assert.equal(parsed.removed, true);
  assert.equal(fs.existsSync(output), true);
  assert.equal(fs.existsSync(output.replace(/\.html$/u, '.json')), true, 'data sidecar must exist');
  assert.equal(fs.existsSync(sessionDir), false, 'archived scratch session must be removed');
});

test('sessions archive refuses a live session', t => {
  const scratchDir = createScratchDirectory(t, 'sessions-archive-live-scratch');
  const projectDir = createScratchDirectory(t, 'sessions-archive-live-project');
  const sessionDir = seedSession(scratchDir, projectDir, 'eeeeeeee-live0005', { pid: process.pid });

  const result = runSessions(['archive', '--session-dir', sessionDir], scratchDir, projectDir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /still running/i);
  assert.equal(fs.existsSync(sessionDir), true);
});

test('sessions prune archives and deletes only dead sessions past the age threshold', t => {
  const scratchDir = createScratchDirectory(t, 'sessions-prune-scratch');
  const projectDir = createScratchDirectory(t, 'sessions-prune-project');
  const artifactDir = createScratchDirectory(t, 'sessions-prune-artifacts');
  const oldDir = seedSession(scratchDir, projectDir, 'ffffffff-old00006', {
    ageDays: 30,
    artifactDir: path.join(artifactDir, 'ffffffff-old00006'),
  });
  const recentDir = seedSession(scratchDir, projectDir, 'abababab-new00007');

  const preview = runSessions(['prune', '--older-than-days', '14', '--dry-run'], scratchDir, projectDir);
  assert.equal(preview.status, 0, preview.stderr);
  const previewOutput = JSON.parse(preview.stdout);
  assert.equal(previewOutput.type, 'visual-sessions-prune-preview');
  assert.deepEqual(previewOutput.candidates.map(candidate => candidate.session_id), ['ffffffff-old00006']);
  assert.equal(fs.existsSync(oldDir), true, 'dry-run must not delete');

  const result = runSessions(['prune', '--older-than-days', '14'], scratchDir, projectDir);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.type, 'visual-sessions-pruned');
  assert.equal(parsed.pruned.length, 1);
  assert.equal(parsed.pruned[0].session_dir, oldDir);
  assert.equal(fs.existsSync(parsed.pruned[0].export_file), true, 'prune must export before deleting');
  assert.equal(fs.existsSync(oldDir), false);
  assert.equal(fs.existsSync(recentDir), true, 'recent session must be kept');
});
