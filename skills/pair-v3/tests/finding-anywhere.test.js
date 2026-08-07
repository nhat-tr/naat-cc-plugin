// A human standing in the loop reads a checkpoint against the code around it, so a finding is not confined
// to the paths the Review Slice changed.
//
// AC-1: a finding anchors any file tracked at the checkpoint, including one this slice never touched.
// AC-2: the path a human types is accepted as their editor shows it — absolute, or with a leading ./.
// AC-3: a path that is not in the checkpoint tree is refused by name, not by a raw git failure.

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { advanceWork, recordHumanFinding, submitHumanFindings } = require('../scripts/lib/pair-engine');
const { readState } = require('../scripts/lib/pair-store');
const { completedSlice, greenVerification, openTestWork, providerResult } = require('./helpers/warm-work');

// One checkpoint, reached the ordinary way, with a second tracked file the slice never edits.
function checkpointedWork(t, prefix, workId) {
  const opened = openTestWork(t, {
    prefix,
    workId,
    files: { 'caller.js': 'const value = require("./value");\nmodule.exports = value + 1;\n' },
    config: { human_in_the_loop_default: true },
  });
  const dependencies = {
    runProvider(input) {
      fs.writeFileSync(path.join(input.root, 'value.js'), 'module.exports = 2;\n');
      return providerResult(completedSlice(), { session_id: 'impl-sess' });
    },
    verify: greenVerification,
    hydrate: () => ({ hydrated: false }),
  };
  advanceWork(opened.worktree, { runtime: 'claude', reviewPolicy: 'off' }, dependencies);
  return opened;
}

test('a finding anchors a file this Review Slice never changed', t => {
  const opened = checkpointedWork(t, 'anywhere', 'work-finding-anywhere');

  const drafted = recordHumanFinding(opened.worktree, {
    sliceId: 'S1',
    file: 'caller.js',
    lineStart: 2,
    claim: 'The caller adds one to a value the slice just changed the meaning of.',
  });
  const recorded = submitHumanFindings(opened.worktree, { sliceId: 'S1' });

  assert.equal(drafted.findings[0].evidence.path, 'caller.js');
  assert.equal(recorded.outcome.findings[0].evidence.path, 'caller.js');
  assert.equal(readState(opened.worktree, opened.workId).slices[0].status, 'correction-ready',
    'submission is the verdict, so a finding outside the diff earns the same correction');
});

test('the path is accepted as an editor shows it', t => {
  const opened = checkpointedWork(t, 'anyabs', 'work-finding-absolute');

  const absolute = recordHumanFinding(opened.worktree, {
    sliceId: 'S1',
    file: path.join(opened.worktree, 'caller.js'),
    lineStart: 1,
    claim: 'The caller reads the module through a path that will not exist after this slice.',
  });
  const dotted = recordHumanFinding(opened.worktree, {
    sliceId: 'S1',
    file: './value.js',
    lineStart: 1,
    claim: 'The exported value is not what the acceptance criterion asks for.',
  });

  assert.equal(absolute.findings[0].evidence.path, 'caller.js');
  assert.equal(dotted.findings[1].evidence.path, 'value.js');
});

// Said live: "it is very often that i do spontaneous review, when there is no review slice yet". Reading code
// and having something to say about it is not an activity the loop schedules, so drafting cannot require a
// checkpoint to exist — the worktree's own HEAD is an immutable commit and anchors a claim exactly as well.
test('a finding can be drafted before anything has been checkpointed', t => {
  const opened = openTestWork(t, {
    prefix: 'anyearly',
    workId: 'work-finding-early',
    files: { 'caller.js': 'const value = require("./value");\nmodule.exports = value + 1;\n' },
    config: { human_in_the_loop_default: true },
  });
  const head = childProcess.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: opened.worktree, encoding: 'utf8' }).trim();

  const drafted = recordHumanFinding(opened.worktree, {
    file: 'caller.js',
    lineStart: 2,
    claim: 'The caller adds one to a value whose meaning this Work is about to change.',
  });
  const recorded = submitHumanFindings(opened.worktree, {});

  assert.equal(drafted.findings[0].evidence.commit, head, 'the claim anchors the commit the human actually read');
  assert.equal(recorded.outcome.findings.length, 1, 'and it submits with no checkpoint in existence');
  assert.equal(readState(opened.worktree, opened.workId).slices[0].status, 'correction-ready',
    'the first implementation of the slice runs as the correction that carries it');
});

test('a path outside the checkpoint tree is refused by name', t => {
  const opened = checkpointedWork(t, 'anymiss', 'work-finding-missing');

  assert.throws(() => recordHumanFinding(opened.worktree, {
    sliceId: 'S1',
    file: 'src/not-tracked.js',
    lineStart: 1,
    claim: 'This file does not exist in the checkpoint at all.',
  }), /src\/not-tracked\.js is not in commit/u);
});
