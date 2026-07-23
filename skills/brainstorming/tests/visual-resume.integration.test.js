const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createScratchDirectory } = require('./test-support');

const sessionCli = path.resolve(__dirname, '../scripts/visual-session.cjs');

function workspaceFixture(title) {
  const document = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '../fixtures/product-concept-set.json'),
    'utf8',
  ));
  document.title = title;
  delete document.revision;
  return document;
}

function sessionEnvironment(scratchDir) {
  const env = { ...process.env, CLAUDE_SCRATCH_DIR: scratchDir };
  delete env.CODEX_THREAD_ID;
  return env;
}

// Spawns a foreground visual-session command and resolves with its first stdout line (the
// announce JSON) while the process keeps serving.
function spawnServing(args, options) {
  const child = childProcess.spawn(process.execPath, [sessionCli, ...args], {
    ...options,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const announced = new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      reject(new Error(`session did not announce in time; stderr: ${stderr}`));
    }, 30_000);
    child.stdout.on('data', chunk => {
      stdout += chunk;
      const newline = stdout.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timer);
      try {
        resolve(JSON.parse(stdout.slice(0, newline)));
      } catch (error) {
        reject(error);
      }
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.on('exit', code => {
      clearTimeout(timer);
      reject(new Error(`session exited early with code ${code}; stderr: ${stderr}`));
    });
  });
  return { child, announced };
}

function waitForExit(child) {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve();
  return new Promise(resolve => child.once('exit', resolve));
}

test('resume revives a crashed session on the same URL with its feedback history intact', async t => {
  const scratchDir = createScratchDirectory(t, 'resume-scratch');
  const projectDir = createScratchDirectory(t, 'resume-project');
  const candidateFile = path.join(createScratchDirectory(t, 'resume-candidate'), 'workspace.json');
  fs.writeFileSync(candidateFile, `${JSON.stringify(workspaceFixture('Resumable concepts'))}\n`);
  const spawnOptions = { cwd: projectDir, env: sessionEnvironment(scratchDir) };

  const first = spawnServing(['present', '--document', candidateFile, '--quiet'], spawnOptions);
  t.after(() => { try { first.child.kill('SIGKILL'); } catch { /* already gone */ } });
  const started = await first.announced;
  assert.equal(started.type, 'visual-session-presented');
  assert.match(started.connection_url, /^http:\/\/localhost:\d+\/session\/[a-z0-9-]+\/\?token=/u);

  const screenResponse = await fetch(`${new URL(started.connection_url).origin}${new URL(started.connection_url).pathname}api/screen${new URL(started.connection_url).search}`);
  assert.equal(screenResponse.status, 200);
  const screen = await screenResponse.json();
  assert.equal(screen.title, 'Resumable concepts');

  const base = new URL(started.connection_url);
  const feedbackResponse = await fetch(`${base.origin}${base.pathname}api/feedback${base.search}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientTurnId: 'resume-turn-1',
      message: 'Feedback recorded before the crash.',
      annotations: [],
      choices: [],
      screen: { id: 'product', file: 'workspace.json', revision: screen.revision },
    }),
  });
  assert.equal(feedbackResponse.status, 201);

  first.child.kill('SIGKILL');
  await waitForExit(first.child);

  const second = spawnServing(['resume', '--quiet'], spawnOptions);
  t.after(() => { try { second.child.kill('SIGKILL'); } catch { /* already gone */ } });
  const resumed = await second.announced;
  assert.equal(resumed.type, 'visual-session-resumed');
  assert.equal(resumed.session_dir, started.session_dir);
  assert.equal(resumed.connection_url, started.connection_url, 'resume must revive the identical URL');
  assert.equal(resumed.url_preserved, true);

  const sessionResponse = await fetch(`${base.origin}${base.pathname}api/session${base.search}`);
  assert.equal(sessionResponse.status, 200);
  const snapshot = await sessionResponse.json();
  const turns = snapshot.events.filter(event => event.type === 'user.turn');
  assert.equal(turns.length, 1, 'pre-crash feedback history must survive resume');
  assert.equal(turns[0].message, 'Feedback recorded before the crash.');

  second.child.kill('SIGTERM');
  await waitForExit(second.child);
});

test('resume refuses while the session is still running', async t => {
  const scratchDir = createScratchDirectory(t, 'resume-live-scratch');
  const projectDir = createScratchDirectory(t, 'resume-live-project');
  const candidateFile = path.join(createScratchDirectory(t, 'resume-live-candidate'), 'workspace.json');
  fs.writeFileSync(candidateFile, `${JSON.stringify(workspaceFixture('Live concepts'))}\n`);
  const spawnOptions = { cwd: projectDir, env: sessionEnvironment(scratchDir) };

  const serving = spawnServing(['present', '--document', candidateFile, '--quiet'], spawnOptions);
  t.after(() => { try { serving.child.kill('SIGKILL'); } catch { /* already gone */ } });
  await serving.announced;

  const result = childProcess.spawnSync(process.execPath, [sessionCli, 'resume'], {
    cwd: projectDir,
    env: sessionEnvironment(scratchDir),
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /already active|still running|no resumable/i);

  serving.child.kill('SIGTERM');
  await waitForExit(serving.child);
});
