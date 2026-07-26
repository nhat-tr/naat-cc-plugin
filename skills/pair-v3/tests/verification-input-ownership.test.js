const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { snapshotWorktree, verifyOwnership } = require('../scripts/pair-task');

function testRepo(t) {
  const scratchRoot = process.env.CLAUDE_SCRATCH_DIR || path.join(os.homedir(), '.claude-scratch');
  fs.mkdirSync(path.join(scratchRoot, 'my-claude-code', 'pair-v3-tests'), { recursive: true });
  const root = fs.mkdtempSync(path.join(scratchRoot, 'my-claude-code', 'pair-v3-tests', 'verify-input-'));
  const scratch = fs.mkdtempSync(path.join(scratchRoot, 'my-claude-code', 'pair-v3-tests', 'verify-input-scratch-'));
  childProcess.spawnSync('git', ['init', '-q'], { cwd: root });
  childProcess.spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'base'], { cwd: root });
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  return { root, scratch };
}

test('a doer change to .pair/verify.sh is a hard ownership boundary, not a warning', t => {
  const { root, scratch } = testRepo(t);
  const snapshot = snapshotWorktree(root, scratch);
  fs.mkdirSync(path.join(root, '.pair'), { recursive: true });
  fs.writeFileSync(path.join(root, '.pair', 'verify.sh'), '#!/bin/sh\nexit 0\n');

  const ownership = verifyOwnership(root, { id: '1.1', files: ['src/a.js'] }, snapshot);
  assert.equal(ownership.status, 'fail');
  assert.ok(ownership.hardBoundaries.includes('.pair/verify.sh'));
  assert.match(ownership.output, /hard Pair boundary crossed/);
});

test('a doer change to .pair/extra-verify.json is a hard ownership boundary', t => {
  const { root, scratch } = testRepo(t);
  const snapshot = snapshotWorktree(root, scratch);
  fs.mkdirSync(path.join(root, '.pair'), { recursive: true });
  fs.writeFileSync(path.join(root, '.pair', 'extra-verify.json'), '{"schema":1,"entries":[]}\n');

  const ownership = verifyOwnership(root, { id: '1.1', files: ['src/a.js'] }, snapshot);
  assert.equal(ownership.status, 'fail');
  assert.ok(ownership.hardBoundaries.includes('.pair/extra-verify.json'));
});

test('a verify.sh change declared in the task files is owned, not a boundary', t => {
  const { root, scratch } = testRepo(t);
  const snapshot = snapshotWorktree(root, scratch);
  fs.mkdirSync(path.join(root, '.pair'), { recursive: true });
  fs.writeFileSync(path.join(root, '.pair', 'verify.sh'), '#!/bin/sh\nexit 0\n');

  const ownership = verifyOwnership(root, { id: '1.1', files: ['.pair/verify.sh'] }, snapshot);
  assert.equal(ownership.status, 'pass');
  assert.deepEqual(ownership.hardBoundaries, []);
});

test('an ordinary additional file still warns instead of failing (default behavior preserved)', t => {
  const { root, scratch } = testRepo(t);
  const snapshot = snapshotWorktree(root, scratch);
  fs.writeFileSync(path.join(root, 'stray.txt'), 'hello\n');

  const ownership = verifyOwnership(root, { id: '1.1', files: ['src/a.js'] }, snapshot);
  assert.equal(ownership.status, 'warn');
  assert.deepEqual(ownership.additional, ['stray.txt']);
});
