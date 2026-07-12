const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createScratchDirectory } = require('./test-support');
const { defaultActiveFile } = require('../scripts/visual-session.cjs');

const scriptsDir = path.resolve(__dirname, '../scripts');

function firstOutputLine(stream, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('timed out waiting for server startup output')), timeoutMs);
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

test('start-server is one foreground process and stores no capability in session metadata', async t => {
  const scratchRoot = createScratchDirectory(t, 'launcher');
  // Run from a throwaway working dir so repo-local .artifacts never lands in the real repo.
  const workDir = createScratchDirectory(t, 'launcher-work');
  const launcher = childProcess.spawn(path.join(scriptsDir, 'start-server.sh'), [], {
    cwd: workDir,
    env: { ...process.env, CLAUDE_SCRATCH_DIR: scratchRoot },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let info;
  t.after(() => {
    if (info?.session_dir) {
      childProcess.spawnSync(path.join(scriptsDir, 'stop-server.sh'), [info.session_dir], {
        encoding: 'utf8',
        env: { ...process.env, CLAUDE_SCRATCH_DIR: scratchRoot },
      });
    }
    if (launcher.exitCode == null) launcher.kill('SIGTERM');
  });

  info = JSON.parse(await firstOutputLine(launcher.stdout));
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(launcher.exitCode, null);
  assert.match(info.connection_url, /\?token=/);
  assert.equal(Number(fs.readFileSync(path.join(info.state_dir, 'server.pid'), 'utf8')), launcher.pid);

  const mode = file => fs.statSync(file).mode & 0o777;
  assert.equal(mode(info.session_dir), 0o700);
  assert.equal(mode(info.state_dir), 0o700);
  assert.equal(mode(info.active_file), 0o600);
  assert.doesNotMatch(fs.readFileSync(info.active_file, 'utf8'), /token|connection_url/i);
  assert.doesNotMatch(fs.readFileSync(path.join(info.state_dir, 'server-info'), 'utf8'), /token|connection_url/i);

  const stopped = childProcess.spawnSync(path.join(scriptsDir, 'stop-server.sh'), [info.session_dir], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_SCRATCH_DIR: scratchRoot },
  });
  assert.equal(stopped.status, 0, stopped.stderr || stopped.stdout);
  assert.match(stopped.stdout, /visual-session-stopped/);
});

test('launcher contains no detached background or polling machinery', () => {
  const launcher = fs.readFileSync(path.join(scriptsDir, 'start-server.sh'), 'utf8');
  assert.match(launcher, /exec node .*visual-session\.cjs.*start/);
  assert.doesNotMatch(launcher, /nohup|disown|--background|sleep/);
});

test('an explicit project directory controls active-session discovery', t => {
  const scratchRoot = createScratchDirectory(t, 'project-active');
  const projectDir = path.join(scratchRoot, 'customer-project');
  fs.mkdirSync(projectDir);
  const previous = process.env.CLAUDE_SCRATCH_DIR;
  process.env.CLAUDE_SCRATCH_DIR = scratchRoot;
  t.after(() => {
    if (previous == null) delete process.env.CLAUDE_SCRATCH_DIR;
    else process.env.CLAUDE_SCRATCH_DIR = previous;
  });

  const activeFile = defaultActiveFile({ projectDir });
  assert.ok(activeFile.startsWith(path.join(scratchRoot, path.sep)));
  assert.match(activeFile, /customer-project-[0-9a-f]{8}[/\\]brainstorm[/\\]active-session\.json$/);

  // Two checkouts that share a basename must not share one active-session pointer.
  const sibling = path.join(scratchRoot, 'other-root', 'customer-project');
  fs.mkdirSync(sibling, { recursive: true });
  assert.notEqual(defaultActiveFile({ projectDir: sibling }), activeFile);
});
