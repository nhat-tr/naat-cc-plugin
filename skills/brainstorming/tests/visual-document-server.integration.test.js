const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createBrainstormServer } = require('../scripts/server.cjs');
const { createScratchDirectory } = require('./test-support');

const sessionCli = path.resolve(__dirname, '../scripts/visual-session.cjs');

test('server renders reusable shell and persists one feedback batch without agent polling', async t => {
  const sessionDir = createScratchDirectory(t, 'document-server');
  const contentDir = path.join(sessionDir, 'content');
  fs.mkdirSync(contentDir, { recursive: true });
  fs.writeFileSync(path.join(contentDir, 'screen.json'), JSON.stringify({
    profile: 'technical',
    audience: 'Software developers',
    title: 'Runtime flow',
    sections: [{
      kind: 'cards',
      id: 'constraints',
      title: 'Constraints',
      items: [{ id: 'same-session', title: 'Same session', detail: 'No resumed agent.' }],
    }],
  }));

  const app = createBrainstormServer({
    sessionDir,
    token: 'document-secret',
    sessionId: 'document-session',
    idleTimeoutMs: 60_000,
  });
  const address = await app.listen();
  t.after(() => app.close());

  const root = await fetch(address.connection_url);
  assert.equal(root.status, 200);
  const cookie = root.headers.get('set-cookie').split(';')[0];
  const html = await root.text();
  assert.match(html, /visual-shell-root/);
  assert.match(html, /assets\/app\.js/);
  assert.doesNotMatch(html, /brainstorm-companion-root/);

  const screen = await fetch(`${address.url}${address.base_path}api/screen`, { headers: { Cookie: cookie } });
  assert.equal(screen.status, 200);
  assert.equal((await screen.json()).profile, 'technical');

  const feedback = await fetch(`${address.url}${address.base_path}api/feedback`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientTurnId: 'feedback-1',
      message: 'Keep framework ownership visible.',
      annotations: [{ id: 'note-1', comment: 'Make this explicit.', target: { componentId: 'same-session' } }],
      choices: [],
      screen: { id: 'screen', file: 'screen.json' },
    }),
  });
  assert.equal(feedback.status, 201);
  assert.equal(app.store.nextUnacknowledgedTurn().clientTurnId, 'feedback-1');
});

test('publishing a decision document in place leaves an immediately readable screen', async t => {
  const sessionDir = createScratchDirectory(t, 'publish-roundtrip');
  const contentDir = path.join(sessionDir, 'content');
  const screenFile = path.join(contentDir, 'screen.json');
  fs.mkdirSync(contentDir, { recursive: true });
  fs.writeFileSync(screenFile, JSON.stringify({
    profile: 'technical',
    title: 'Choose transport',
    sections: [{
      kind: 'decision',
      id: 'transport',
      title: 'Transport',
      options: [
        { id: 'sse', label: 'SSE', score: 9 },
        { id: 'polling', label: 'Polling', score: 3 },
      ],
    }],
  }));

  const published = childProcess.spawnSync(process.execPath, [
    sessionCli,
    'publish',
    '--document', screenFile,
    '--session-dir', sessionDir,
  ], { encoding: 'utf8' });
  assert.equal(published.status, 0, published.stderr);

  const app = createBrainstormServer({
    sessionDir,
    token: 'roundtrip-secret',
    sessionId: 'roundtrip-session',
    idleTimeoutMs: 60_000,
  });
  const address = await app.listen();
  t.after(() => app.close());
  const root = await fetch(address.connection_url);
  const cookie = root.headers.get('set-cookie').split(';')[0];
  const screen = await fetch(`${address.url}${address.base_path}api/screen`, { headers: { Cookie: cookie } });

  assert.equal(screen.status, 200, await screen.text());
  assert.equal((await app.readScreen()).sections[0].options[0].label, 'SSE');
});
