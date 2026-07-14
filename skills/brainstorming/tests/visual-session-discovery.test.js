'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { activeMetadata } = require('../scripts/visual-session.cjs');
const { createScratchDirectory } = require('./test-support');

function useScratchRoot(t, root) {
  const previous = process.env.CLAUDE_SCRATCH_DIR;
  process.env.CLAUDE_SCRATCH_DIR = root;
  t.after(() => {
    if (previous == null) delete process.env.CLAUDE_SCRATCH_DIR;
    else process.env.CLAUDE_SCRATCH_DIR = previous;
  });
}

function writePointer(root, key, metadata) {
  const brainstorm = path.join(root, key, 'brainstorm');
  fs.mkdirSync(brainstorm, { recursive: true });
  const activeFile = path.join(brainstorm, 'active-session.json');
  fs.writeFileSync(activeFile, `${JSON.stringify(metadata)}\n`);
  return activeFile;
}

test('activeMetadata discovers the single live session when the cwd-derived pointer is absent', t => {
  const root = createScratchDirectory(t, 'discovery');
  useScratchRoot(t, root);
  const sessionDir = path.join(root, 'other-repo-abcd1234', 'brainstorm', 'session-1');
  const activeFile = writePointer(root, 'other-repo-abcd1234', {
    version: 1,
    pid: process.pid,
    session_id: 'session-1',
    session_dir: sessionDir,
    state_dir: path.join(sessionDir, 'state'),
    url: 'http://localhost:60745',
  });

  // A caller whose git root derives a different key must still find the one running session.
  const resolved = activeMetadata({ projectDir: path.join(root, 'unrelated-project') });
  assert.equal(resolved.session_id, 'session-1');
  assert.equal(resolved.active_file, activeFile);
});

test('activeMetadata refuses to guess when multiple live sessions are ambiguous', t => {
  const root = createScratchDirectory(t, 'discovery-ambiguous');
  useScratchRoot(t, root);
  for (const key of ['repo-a-11111111', 'repo-b-22222222']) {
    const sessionDir = path.join(root, key, 'brainstorm', 's');
    writePointer(root, key, {
      version: 1,
      pid: process.pid,
      session_id: key,
      session_dir: sessionDir,
      state_dir: path.join(sessionDir, 'state'),
    });
  }
  assert.throws(
    () => activeMetadata({ projectDir: path.join(root, 'unrelated-project') }),
    /no active visual session/,
  );
});

test('activeMetadata ignores a stale pointer whose owning process is gone', t => {
  const root = createScratchDirectory(t, 'discovery-dead');
  useScratchRoot(t, root);
  // spawnSync returns after the child exits, so its pid names a process that is now gone (ESRCH).
  const deadPid = require('node:child_process').spawnSync(process.execPath, ['-e', '0']).pid;
  writePointer(root, 'dead-repo-99999999', {
    version: 1,
    pid: deadPid,
    session_id: 'dead',
    session_dir: path.join(root, 'dead-repo-99999999', 'brainstorm', 's'),
    state_dir: path.join(root, 'dead-repo-99999999', 'brainstorm', 's', 'state'),
  });
  assert.throws(
    () => activeMetadata({ projectDir: path.join(root, 'unrelated-project') }),
    /no active visual session/,
  );
});
