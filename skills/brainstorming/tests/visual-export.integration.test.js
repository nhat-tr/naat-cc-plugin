const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createBrainstormServer } = require('../scripts/server.cjs');
const { buildStandaloneHtml, writeStandaloneExport } = require('../scripts/visual-session.cjs');
const { createScratchDirectory } = require('./test-support');

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

const sessionCli = path.resolve(__dirname, '../scripts/visual-session.cjs');
const repoCwd = path.resolve(__dirname, '../../..');

function runSession(env, ...args) {
  return childProcess.spawnSync(process.execPath, [sessionCli, ...args], {
    encoding: 'utf8',
    cwd: repoCwd,
    env: { ...process.env, ...env },
  });
}

function firstLine(stream, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('timed out waiting for start output')), timeoutMs);
    stream.setEncoding('utf8');
    stream.on('data', chunk => {
      output += chunk;
      const newline = output.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timeout);
      resolve(output.slice(0, newline));
    });
  });
}

const decisionDocument = {
  profile: 'technical',
  title: 'Transport decision',
  summary: 'Pick the browser transport.',
  sections: [{
    kind: 'decision',
    id: 'transport',
    title: 'Transport',
    options: [
      { id: 'sse', label: 'SSE', score: 9, recommended: true },
      { id: 'polling', label: 'Polling', score: 3 },
    ],
  }],
};

test('the standalone export is self-contained and renders read-only without a server', t => {
  const stateDir = createScratchDirectory(t, 'export-build');
  const html = buildStandaloneHtml(decisionDocument, { version: 1, cursor: 0, pendingTurns: 0, events: [
    { type: 'user.turn', role: 'user', message: 'Prefer SSE.' },
    { type: 'agent.message', role: 'agent', message: 'Locked SSE.' },
  ] });

  assert.match(html, /visual-shell-root/);
  assert.match(html, /window\.__BRAINSTORM_EMBEDDED__ =/);
  // Nothing external: styles and script are inlined, no server-relative asset references remain.
  assert.doesNotMatch(html, /<link rel="stylesheet"/);
  assert.doesNotMatch(html, /<script src=/);
  assert.match(html, /Transport decision/);
  assert.match(html, /"readOnly":true/);
  // The embedded payload is valid JSON carrying the exact document.
  const payload = JSON.parse(html.match(/window\.__BRAINSTORM_EMBEDDED__ = (\{[\s\S]*?\});/)[1]);
  assert.equal(payload.screen.title, 'Transport decision');
  assert.equal(payload.session.events.length, 2);
  assert.equal(fs.existsSync(stateDir), true);
});

test('writeStandaloneExport falls back to a placeholder when no screen was published', t => {
  const sessionDir = createScratchDirectory(t, 'export-empty');
  const output = path.join(sessionDir, 'visual.html');
  const written = writeStandaloneExport({
    session_id: 'empty-session',
    session_dir: sessionDir,
    content_dir: path.join(sessionDir, 'content'),
    state_dir: path.join(sessionDir, 'state'),
  }, output);

  assert.equal(written, output);
  const html = fs.readFileSync(output, 'utf8');
  assert.match(html, /No visual published/);
});

test('the running server maintains a live visual.html without any manual export', async t => {
  const sessionDir = createScratchDirectory(t, 'live-artifact');
  const contentDir = path.join(sessionDir, 'content');
  fs.mkdirSync(contentDir, { recursive: true });

  const app = createBrainstormServer({
    sessionDir,
    token: 'live-secret',
    sessionId: 'live-session',
    idleTimeoutMs: 60_000,
  });
  const address = await app.listen();
  t.after(() => app.close());

  // The artifact exists from startup (placeholder before any publish) and is reported.
  assert.equal(address.visual_file, path.join(sessionDir, 'visual.html'));
  assert.equal(fs.existsSync(address.visual_file), true);

  // Publishing a document refreshes the live artifact.
  fs.writeFileSync(path.join(contentDir, 'screen.json'), JSON.stringify(decisionDocument));
  await waitFor(() => fs.readFileSync(address.visual_file, 'utf8').includes('Transport decision'));

  // A feedback batch flows into the same live artifact's history.
  const cookie = (await fetch(address.connection_url)).headers.get('set-cookie').split(';')[0];
  const submitted = await fetch(`${address.url}${address.base_path}api/feedback`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientTurnId: 'live-1', message: 'Keep SSE with reconnect notes.' }),
  });
  assert.equal(submitted.status, 201);
  await waitFor(() => fs.readFileSync(address.visual_file, 'utf8').includes('Keep SSE with reconnect notes.'));
});

test('the server saves numbered standalone snapshots into the artifact directory', async t => {
  const sessionDir = createScratchDirectory(t, 'save-endpoint');
  const artifactDir = path.join(createScratchDirectory(t, 'save-artifacts'), 'brainstorm', 'save-session');
  fs.mkdirSync(path.join(sessionDir, 'content'), { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'content', 'screen.json'), JSON.stringify(decisionDocument));

  const app = createBrainstormServer({ sessionDir, artifactDir, token: 'save-secret', sessionId: 'save-session', idleTimeoutMs: 60_000 });
  const address = await app.listen();
  t.after(() => app.close());
  const cookie = (await fetch(address.connection_url)).headers.get('set-cookie').split(';')[0];

  const rejected = await fetch(`${address.url}${address.base_path}api/save`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: 'http://evil.local' }, body: '{}',
  });
  assert.equal(rejected.status, 403);

  const first = await fetch(`${address.url}${address.base_path}api/save`, { method: 'POST', headers: { Cookie: cookie }, body: '{}' });
  const firstResult = await first.json();
  assert.equal(first.status, 201);
  assert.equal(firstResult.file, 'visual-001.html');
  assert.equal(fs.existsSync(firstResult.path), true);
  assert.match(fs.readFileSync(firstResult.path, 'utf8'), /Transport decision/);

  const second = await fetch(`${address.url}${address.base_path}api/save`, { method: 'POST', headers: { Cookie: cookie }, body: '{}' });
  assert.equal((await second.json()).file, 'visual-002.html');
  // The artifact dir is self-ignoring so it never clutters the repo's git status.
  assert.equal(fs.readFileSync(path.join(artifactDir, '.gitignore'), 'utf8'), '*\n');
});

test('a stopped scratch session leaves a standalone visual in the repo .artifacts directory', async t => {
  const scratchRoot = createScratchDirectory(t, 'export-stop');
  // A non-repo working directory so artifacts resolve under it, never into the real repo.
  const workDir = createScratchDirectory(t, 'export-stop-work');
  const env = { CLAUDE_SCRATCH_DIR: scratchRoot };
  const start = childProcess.spawn(process.execPath, [sessionCli, 'start'], {
    encoding: 'utf8',
    cwd: workDir,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let info;
  t.after(() => { if (start.exitCode == null) start.kill('SIGKILL'); });
  info = JSON.parse(await firstLine(start.stdout));

  assert.ok(info.visual_file.includes(path.join('.artifacts', 'brainstorm')), 'live artifact lives in repo .artifacts');
  assert.ok(info.visual_file.startsWith(path.join(workDir, '.artifacts')), 'artifacts resolve under the working dir');

  const documentFile = path.join(scratchRoot, 'visual.json');
  fs.writeFileSync(documentFile, JSON.stringify(decisionDocument));
  const published = runSession(env, 'publish', '--document', documentFile, '--session-dir', info.session_dir);
  assert.equal(published.status, 0, published.stderr);

  const stopped = runSession(env, 'stop', '--session-dir', info.session_dir);
  assert.equal(stopped.status, 0, stopped.stderr);
  const result = JSON.parse(stopped.stdout);

  assert.ok(result.export_file.startsWith(path.join(workDir, '.artifacts')), 'export lands in .artifacts');
  assert.equal(fs.existsSync(result.export_file), true, 'export survives scratch cleanup');
  assert.equal(fs.existsSync(info.session_dir), false, 'scratch session directory is removed');

  const html = fs.readFileSync(result.export_file, 'utf8');
  assert.match(html, /Transport decision/);
  assert.match(html, /window\.__BRAINSTORM_EMBEDDED__ =/);
});
