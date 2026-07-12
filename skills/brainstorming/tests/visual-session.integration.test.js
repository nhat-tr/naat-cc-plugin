const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createBrainstormServer } = require('../scripts/server.cjs');
const { createScratchDirectory } = require('./test-support');

const sessionCli = path.resolve(__dirname, '../scripts/visual-session.cjs');

function runSession(...args) {
  return childProcess.spawnSync(process.execPath, [sessionCli, ...args], { encoding: 'utf8' });
}

function spawnSession(...args) {
  return childProcess.spawn(process.execPath, [sessionCli, ...args], { encoding: 'utf8' });
}

function processOutput(child) {
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  return new Promise(resolve => {
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
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

test('browser feedback is drained once on the next agent turn and replies return through the same session', async t => {
  const sessionDir = createScratchDirectory(t, 'integration');
  const contentDir = path.join(sessionDir, 'content');
  fs.mkdirSync(contentDir, { recursive: true });
  fs.writeFileSync(path.join(contentDir, 'screen.json'), JSON.stringify({
    profile: 'technical',
    audience: 'Software developers',
    title: 'Transport decision',
    sections: [{
      kind: 'decision',
      id: 'transport',
      title: 'Transport',
      options: [
        { id: 'transport-sse', label: 'SSE' },
        { id: 'transport-poll', label: 'Polling' },
      ],
    }],
  }));

  const app = createBrainstormServer({
    sessionDir,
    host: '127.0.0.1',
    port: 0,
    token: 'integration-secret',
    sessionId: 'integration-session',
    idleTimeoutMs: 60_000,
  });
  const address = await app.listen();
  t.after(() => app.close());

  const unauthorized = await fetch(`${address.url}${address.base_path}api/session`);
  assert.equal(unauthorized.status, 401);

  const root = await fetch(address.connection_url);
  const cookie = root.headers.get('set-cookie').split(';')[0];
  assert.equal(root.status, 200);
  assert.match(await root.text(), /visual-shell-root/);
  assert.doesNotMatch(root.headers.get('content-security-policy'), /unsafe-inline|ws:/);
  assert.match(root.headers.get('set-cookie'), /Path=\/session\/integration-session\//);

  const rejectedOrigin = await fetch(`${address.url}${address.base_path}api/feedback`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: 'http://malicious.local' },
    body: JSON.stringify({ message: 'Cross-origin turn' }),
  });
  assert.equal(rejectedOrigin.status, 403);

  const events = await fetch(`${address.url}${address.base_path}api/events`, { headers: { Cookie: cookie } });
  assert.match(events.headers.get('content-type'), /text\/event-stream/);
  const reader = events.body.getReader();
  t.after(() => reader.cancel());
  assert.match(await readUntil(reader, /connected/), /connected/);

  fs.writeFileSync(path.join(contentDir, 'screen.json'), JSON.stringify({
    profile: 'technical',
    title: 'Revised transport decision',
    sections: [{ kind: 'callout', id: 'revised', title: 'Revised', body: 'Prefer framework-owned SSE.', tone: 'positive' }],
  }));
  assert.match(await readUntil(reader, /event: screen/), /event: screen/);

  const submitted = await fetch(`${address.url}${address.base_path}api/feedback`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientTurnId: 'feedback-1',
      message: 'Show reconnection risk.',
      annotations: [{ id: 'note-1', comment: 'Keep ownership explicit.', target: { componentId: 'transport-sse' } }],
      choices: [{ groupId: 'transport', componentId: 'transport-sse', value: 'transport-sse', label: 'SSE' }],
      screen: { id: 'screen', file: 'screen.json' },
    }),
  });
  assert.equal(submitted.status, 201);

  const drained = runSession('drain', '--session-dir', sessionDir);
  assert.equal(drained.status, 0, drained.stderr);
  const browserTurn = JSON.parse(drained.stdout);
  assert.equal(browserTurn.message, 'Show reconnection risk.');
  assert.equal(browserTurn.annotations[0].target.componentId, 'transport-sse');

  const responseFile = path.join(sessionDir, 'agent-response.txt');
  fs.writeFileSync(responseFile, 'I added reconnect and ownership failure modes.');
  const replied = runSession('reply', '--session-dir', sessionDir, '--reply-to', String(browserTurn.seq), '--message-file', responseFile);
  assert.equal(replied.status, 0, replied.stderr);

  const drainedAgain = runSession('drain', '--session-dir', sessionDir);
  assert.deepEqual(JSON.parse(drainedAgain.stdout), { type: 'empty' });

  const session = await fetch(`${address.url}${address.base_path}api/session`, { headers: { Cookie: cookie } });
  const snapshot = await session.json();
  assert.equal(snapshot.cursor, browserTurn.seq);
  assert.equal(snapshot.pendingTurns, 0);
  assert.match(snapshot.events.at(-1).message, /reconnect and ownership/);

  const removedRoute = await fetch(`${address.url}${address.base_path}api/turns`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(removedRoute.status, 404);
});

test('wait returns the next browser feedback batch without a manual visual ready turn', async t => {
  const sessionDir = createScratchDirectory(t, 'wait-integration');
  const app = createBrainstormServer({
    sessionDir,
    host: '127.0.0.1',
    port: 0,
    token: 'wait-secret',
    sessionId: 'wait-session',
    idleTimeoutMs: 60_000,
  });
  const address = await app.listen();
  t.after(() => app.close());

  const root = await fetch(address.connection_url);
  const cookie = root.headers.get('set-cookie').split(';')[0];
  const waiter = spawnSession('wait', '--session-dir', sessionDir, '--timeout-ms', '1000');
  const waiterResult = processOutput(waiter);

  const submitted = await fetch(`${address.url}${address.base_path}api/feedback`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientTurnId: 'feedback-wait-1',
      message: 'No manual visual ready handoff.',
      screen: { id: 'screen', file: 'screen.json' },
    }),
  });
  assert.equal(submitted.status, 201);

  const waited = await waiterResult;
  assert.equal(waited.status, 0, waited.stderr);
  const browserTurn = JSON.parse(waited.stdout);
  assert.equal(browserTurn.clientTurnId, 'feedback-wait-1');
  assert.equal(browserTurn.message, 'No manual visual ready handoff.');

  const responseFile = path.join(sessionDir, 'agent-response.txt');
  fs.writeFileSync(responseFile, 'Received without a manual ready turn.');
  const replied = runSession('reply', '--session-dir', sessionDir, '--reply-to', String(browserTurn.seq), '--message-file', responseFile);
  assert.equal(replied.status, 0, replied.stderr);

  const drainedAgain = runSession('drain', '--session-dir', sessionDir);
  assert.deepEqual(JSON.parse(drainedAgain.stdout), { type: 'empty' });
});

test('each server scopes its browser cookie to a unique session path', async t => {
  const first = createBrainstormServer({ sessionDir: createScratchDirectory(t, 'cookie-first'), token: 'first-secret', idleTimeoutMs: 60_000 });
  const second = createBrainstormServer({ sessionDir: createScratchDirectory(t, 'cookie-second'), token: 'second-secret', idleTimeoutMs: 60_000 });
  const firstAddress = await first.listen();
  const secondAddress = await second.listen();
  t.after(() => Promise.all([first.close(), second.close()]));

  assert.notEqual(firstAddress.base_path, secondAddress.base_path);
  const firstCookie = (await fetch(firstAddress.connection_url)).headers.get('set-cookie');
  const secondCookie = (await fetch(secondAddress.connection_url)).headers.get('set-cookie');
  assert.match(firstCookie, new RegExp(`Path=${firstAddress.base_path.replaceAll('/', '\\/')}`));
  assert.match(secondCookie, new RegExp(`Path=${secondAddress.base_path.replaceAll('/', '\\/')}`));
});

test('scaffold command produces a screen the server accepts without a 422 repair cycle', async t => {
  const sessionDir = createScratchDirectory(t, 'scaffold-integration');
  const contentDir = path.join(sessionDir, 'content');
  const screenFile = path.join(contentDir, 'screen.json');
  fs.mkdirSync(contentDir, { recursive: true });

  const scaffolded = runSession(
    'scaffold',
    '--profile', 'technical',
    '--audience', 'Software developers',
    '--title', 'Framework-native design',
    '--summary', 'Compare observed capabilities.',
    '--kinds', 'anchor,flow,cards,decision,callout',
    '--output', screenFile,
  );
  assert.equal(scaffolded.status, 0, scaffolded.stderr);

  const app = createBrainstormServer({
    sessionDir,
    host: '127.0.0.1',
    port: 0,
    token: 'scaffold-secret',
    sessionId: 'scaffold-session',
    idleTimeoutMs: 60_000,
  });
  const address = await app.listen();
  t.after(() => app.close());

  const root = await fetch(address.connection_url);
  const cookie = root.headers.get('set-cookie').split(';')[0];
  const screen = await fetch(`${address.url}${address.base_path}api/screen`, { headers: { Cookie: cookie } });
  const screenPayload = await screen.json();
  assert.equal(screen.status, 200, JSON.stringify(screenPayload));
  assert.deepEqual(screenPayload.sections.map(section => section.kind), [
    'anchor', 'flow', 'cards', 'decision', 'callout',
  ]);
});

test('server rejects plaintext non-loopback binding without explicit risk acceptance', t => {
  let app;
  t.after(() => app?.close());
  assert.throws(() => {
    app = createBrainstormServer({
      sessionDir: createScratchDirectory(t, 'non-loopback'),
      host: '0.0.0.0',
      token: 'remote-secret',
    });
  }, /plaintext non-loopback/i);
});
