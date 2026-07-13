const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildReviewSliceManifest } = require('../scripts/review-index.cjs');
const { planContractDigest } = require('../scripts/lib/pair-core');
const { validPairPlan } = require('./support/pair-plan-fixture');

const workId = 'work-20260712-visual-companion-vnext';

function reviewPlan() {
  const lines = validPairPlan().split('\n');
  const taskIndexes = lines
    .map((line, index) => (/^- \[ \] Task /.test(line) ? index : -1))
    .filter(index => index >= 0);
  const tasks = taskIndexes.map(index => lines[index]);
  tasks[0] = tasks[0].replace('Task 1.1 -', 'Task 1.2 -');
  tasks[1] = tasks[1].replace('Task 1.2 -', 'Task 1.1 -');
  tasks[2] = tasks[2]
    .replace('[ac:AC-1]', '[ac:AC-2,AC-1]')
    .replace('`src/greeting.js`', '`src/z-greeting.js`, `src/a-greeting.js`');
  lines.splice(taskIndexes[0], tasks.length, ...tasks);
  lines.splice(lines.indexOf('- [ ] AC-1: the command prints the requested greeting.') + 1, 0,
    '- [ ] AC-2: the public greeting entry point remains covered.');
  return lines.join('\n');
}

function git(root, ...args) {
  const result = childProcess.spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  return result.stdout.trim();
}

function write(root, relativePath, content) {
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function manifestInput(t, changedFiles = {}, plan = reviewPlan()) {
  const scratchRoot = process.env.CLAUDE_SCRATCH_DIR || path.join(os.homedir(), '.claude-scratch');
  const parent = path.join(scratchRoot, 'my-claude-code', 'review-slice');
  fs.mkdirSync(parent, { recursive: true });
  const repositoryRoot = fs.mkdtempSync(path.join(parent, 'repo-'));
  t.after(() => fs.rmSync(repositoryRoot, { recursive: true, force: true }));
  git(repositoryRoot, 'init', '-q');
  git(repositoryRoot, 'config', 'user.email', 'review-slice@example.test');
  git(repositoryRoot, 'config', 'user.name', 'Review Slice Test');
  for (const relativePath of [
    'README.md',
    'src/a-greeting.js',
    'src/z-greeting.js',
    'tests/greeting.test.js',
    'tests/greeting.integration.test.js',
  ]) write(repositoryRoot, relativePath, `base ${relativePath}\n`);
  git(repositoryRoot, 'add', '.');
  git(repositoryRoot, 'commit', '-qm', 'base');
  const baseTree = git(repositoryRoot, 'rev-parse', 'HEAD^{tree}');
  for (const [relativePath, contents] of Object.entries(changedFiles)) {
    write(repositoryRoot, relativePath, contents);
  }
  git(repositoryRoot, 'add', '.');
  git(repositoryRoot, 'commit', '--allow-empty', '-qm', 'head');

  return {
    workId,
    repositoryRoot,
    plan,
    baseTree,
    headTree: git(repositoryRoot, 'rev-parse', 'HEAD^{tree}'),
    planDigest: planContractDigest(plan),
    indexerVersion: 'review-index.v1',
  };
}

test('review slice manifest derives stable identity and contract fields from validated Pair tasks', t => {
  const input = manifestInput(t);
  const result = buildReviewSliceManifest(input);

  assert.deepEqual(result.manifest.review_slices.map(slice => ({
    task_id: slice.task_id,
    stream_id: slice.stream_id,
    acceptance_criteria: slice.acceptance_criteria,
    expected_files: slice.expected_files,
    verification_command: slice.verification_command,
  })), [
    {
      task_id: '1.1',
      stream_id: '1',
      acceptance_criteria: ['AC-1'],
      expected_files: ['tests/greeting.integration.test.js'],
      verification_command: 'node --test tests/greeting.integration.test.js',
    },
    {
      task_id: '1.2',
      stream_id: '1',
      acceptance_criteria: ['AC-1'],
      expected_files: ['tests/greeting.test.js'],
      verification_command: 'node --test tests/greeting.test.js',
    },
    {
      task_id: '1.3',
      stream_id: '1',
      acceptance_criteria: ['AC-1', 'AC-2'],
      expected_files: ['src/a-greeting.js', 'src/z-greeting.js'],
      verification_command: 'node --test tests/greeting.test.js tests/greeting.integration.test.js',
    },
  ]);

  const invalidPlan = reviewPlan().replace('Task 1.2 -', 'Task 1.1 -');
  assert.throws(
    () => buildReviewSliceManifest({ ...input, plan: invalidPlan }),
    /duplicate task ID 1\.1|validated Pair plan/i,
  );
  const remappedPlan = reviewPlan().replace(
    'files: `tests/greeting.test.js`',
    'files: `tests/greeting.test.js`, `README.md`',
  );
  assert.throws(
    () => buildReviewSliceManifest({ ...input, plan: remappedPlan }),
    /plan.*digest|digest.*plan/i,
  );
});

test('review slice manifest canonicalizes equal tree and indexer inputs to equal bytes and digests', t => {
  const input = manifestInput(t, {
    'README.md': 'changed README\n',
    'src/z-greeting.js': 'changed implementation\n',
    'tests/greeting.test.js': 'changed test\n',
  });
  const first = buildReviewSliceManifest(input);
  git(input.repositoryRoot, 'config', 'diff.noprefix', 'true');
  git(input.repositoryRoot, 'config', 'diff.algorithm', 'histogram');
  const second = buildReviewSliceManifest(input);

  assert.equal(first.bytes, second.bytes);
  assert.equal(first.digest, second.digest);
  assert.equal(first.digest, crypto.createHash('sha256').update(first.bytes).digest('hex'));
  assert.deepEqual(first.manifest.review_slices.map(slice => slice.task_id), ['1.1', '1.2', '1.3']);
  assert.throws(
    () => buildReviewSliceManifest({
      ...input,
      changes: [{ path: 'forged.js', hunkId: 'forged', claimedBy: [] }],
    }),
    /unsupported field.*changes/i,
  );
});

test('review slice manifest keeps overlapping and unclaimed changes explicit without inferred clustering', t => {
  const lines = reviewPlan().split('\n');
  const taskIndex = lines.findIndex(line => /^- \[ \] Task 1\.2 /.test(line));
  lines[taskIndex] = lines[taskIndex].replace(
    'files: `tests/greeting.test.js`',
    'files: `tests/greeting.test.js`, `src/a-greeting.js`',
  );
  const result = buildReviewSliceManifest(manifestInput(t, {
    'README.md': 'changed unexpected file\n',
    'src/a-greeting.js': 'changed shared implementation\n',
  }, lines.join('\n')));

  assert.deepEqual(result.manifest.cross_slice_changes.map(change => ({
    path: change.path,
    claimed_by: change.claimed_by,
  })), [{
    path: 'src/a-greeting.js',
    claimed_by: ['1.2', '1.3'],
  }]);
  assert.deepEqual(result.manifest.unmapped_changes.map(change => change.path), ['README.md']);
});
