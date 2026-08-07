// What happens to a Work after the loop is done with it, and what stays readable once its worktree is gone.
//
// AC-1: `finish` refuses an unfinished Work, and refuses one whose branch has reached nothing — each naming
//       the command that resolves it.
// AC-2: after the branch is landed, `finish` removes the linked worktree and clears the current-Work
//       selection, so nothing holds that branch checked out and the next open starts clean.
// AC-3: the branch and refs/pair/<work-id>/* survive, and every slice diff is still readable — from the
//       primary checkout, after the worktree is gone.
// AC-4: sessions are listed across every Work in the repository, newest first, open or long finished.

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  advanceWork,
  checkpointIndex,
  currentState,
  finishWork,
  sessionIndex,
  sliceEvidence,
} = require('../scripts/lib/pair-engine');
const { currentLocatorPath } = require('../scripts/lib/pair-store');
const { completedSlice, greenVerification, openTestWork, providerResult } = require('./helpers/warm-work');

function git(cwd, args) {
  const result = childProcess.spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

// One Work driven to completion the way the loop drives it: nobody marked a slice, so one run does all of it.
function completedWork(t, prefix, workId) {
  const opened = openTestWork(t, { prefix, workId, config: { human_in_the_loop_default: false } });
  const dependencies = {
    runProvider(input) {
      if (input.schema?.properties?.verdict) return providerResult({ verdict: 'approve', findings: [] }, { session_id: 'review-sess' });
      fs.writeFileSync(path.join(input.root, 'value.js'), 'module.exports = 2;\n');
      return providerResult(completedSlice(), { session_id: 'impl-sess' });
    },
    verify: greenVerification,
    hydrate: () => ({ hydrated: false }),
  };
  const state = advanceWork(opened.worktree, { runtime: 'claude', reviewPolicy: 'all' }, dependencies);
  assert.equal(state.lifecycle, 'complete', 'the fixture needs a completed Work');
  return opened;
}

test('finish refuses a Work whose branch has reached nothing, and names how to land it', t => {
  const opened = completedWork(t, 'finishrefuse', 'work-finish-refuse');

  assert.throws(() => finishWork(opened.root, { workId: opened.workId }), error => {
    assert.match(error.message, /has not reached/u);
    assert.match(error.message, /git merge --no-ff pair\/work-finish-refuse/u);
    assert.match(error.message, /cherry-pick/u);
    return true;
  });
  assert.ok(fs.existsSync(opened.worktree), 'and nothing was removed');
});

test('finish refuses a Work that is not complete', t => {
  const opened = openTestWork(t, { prefix: 'finishearly', workId: 'work-finish-early', config: { human_in_the_loop_default: false } });

  assert.throws(() => finishWork(opened.root, { workId: opened.workId }), /is ready, not complete/u);
});

test('finishing a landed Work removes the worktree and clears the current-Work selection', t => {
  const opened = completedWork(t, 'finishland', 'work-finish-land');
  git(opened.root, ['merge', '--no-ff', '-m', 'land the Work', `pair/${opened.workId}`]);

  const finished = finishWork(opened.root, { workId: opened.workId });

  assert.equal(finished.landed, true);
  assert.equal(finished.worktree_removed, true);
  assert.equal(fs.existsSync(opened.worktree), false, 'the worktree that held the branch checked out is gone');
  assert.equal(fs.existsSync(currentLocatorPath(opened.root)), false, 'and no Work is selected, so the next open starts clean');
  // The branch is what the code lives on and the refs are the review history: finishing keeps both.
  assert.equal(git(opened.root, ['rev-parse', '--verify', `pair/${opened.workId}`]), finished.head_commit);
  assert.match(git(opened.root, ['for-each-ref', '--format=%(refname)', `refs/pair/${opened.workId}`]), /refs\/pair\/work-finish-land\/checkpoints/u);
  // Nothing holds that branch any more, which is the thing that used to block later work with it.
  assert.doesNotMatch(git(opened.root, ['worktree', 'list']), /work-finish-land/u);
});

test('every slice diff is still readable from the primary checkout once the worktree is gone', t => {
  const opened = completedWork(t, 'finishread', 'work-finish-read');
  git(opened.root, ['merge', '--no-ff', '-m', 'land the Work', `pair/${opened.workId}`]);
  finishWork(opened.root, { workId: opened.workId });

  const index = checkpointIndex(opened.root, { workId: opened.workId });
  const slice = index.slices[0];

  assert.equal(index.worktree_exists, false);
  assert.equal(index.read_root, opened.root, 'the primary checkout answers for the removed worktree');
  assert.ok(slice.base_commit && slice.checkpoint_commit);
  assert.match(git(opened.root, ['diff', slice.base_commit, slice.checkpoint_commit]), /module\.exports = 2/u,
    'and the commit pair it names really is diffable there');

  // The assembled view a human reads goes through the same resolution, so `show` survives cleanup too.
  const evidence = sliceEvidence(opened.root, { workId: opened.workId, sliceId: slice.id });
  assert.equal(evidence.read_root, opened.root);
  assert.equal(evidence.worktree_exists, false);
  assert.equal(evidence.checkpoint_commit, slice.checkpoint_commit);
});

test('sessions are listed across every Work in the repository, newest first', t => {
  const opened = completedWork(t, 'finishsessions', 'work-sessions-a');
  // A second Work in the same repository, opened after the first one was finished.
  git(opened.root, ['merge', '--no-ff', '-m', 'land the Work', `pair/${opened.workId}`]);
  finishWork(opened.root, { workId: opened.workId });
  const second = openTestWork(t, { prefix: 'finishsessions', workId: 'work-sessions-b', config: { human_in_the_loop_default: false } });

  const sessions = sessionIndex(opened.root, { allWorks: true });

  assert.ok(sessions.length >= 2, 'the finished Work still reports its sessions');
  assert.deepEqual([...new Set(sessions.map(item => item.work_id))], ['work-sessions-a'],
    'the second Work has run nothing yet, so it contributes no session');
  assert.deepEqual(sessions.map(item => item.kind), ['review', 'implementation'], 'newest first');
  assert.ok(sessions.every(item => item.session_id && item.at));
  assert.ok(second.worktree, 'the second Work exists and did not disturb the first one\'s record');
  assert.equal(currentState(opened.root, 'work-sessions-a').lifecycle, 'complete');
});
