// A repository that never declared a runtime. Everything the runtime-ownership work added answers one
// question — whose program is answering on the fixed host ports — and where no program was ever declared
// there is no question to ask, no claim that this loop could have written, and nothing a teardown could
// stop. So none of it may be reachable from here: not the identity question, not the reconciliation that
// runs before every dispatch, not the refusals, and not the signal handlers that exist to pay a `down`.
//
// AC-10: a Work in a repository with no runtime declaration performs no identity, reconciliation, or
//        refusal step.

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { advanceWork } = require('../scripts/lib/pair-engine');
const { readEvents, readJson, workPaths } = require('../scripts/lib/pair-store');
const { openTestWork } = require('./helpers/warm-work');
const { TWO_SLICE_SPEC, scriptedProvider, twoSlicesWithProbes } = require('./helpers/runtime-work');

// The same two-slice Work the runtime tests drive, with the two things a quiet repository does not have:
// the declaration, and the per-slice question a declaration makes obligatory.
function openQuietWork(t, { prefix, workId }) {
  const slices = twoSlicesWithProbes().map(({ probe, ...slice }) => slice);
  return openTestWork(t, {
    prefix,
    workId,
    slices,
    specMarkdown: TWO_SLICE_SPEC,
    config: { human_in_the_loop_default: false },
  });
}

// A pid that certainly existed and certainly does not now, so a claim naming it reads as abandoned.
function deadPid() {
  return childProcess.spawnSync('true').pid;
}

test('a repository that declares no runtime is asked nothing about a program', t => {
  const opened = openQuietWork(t, { prefix: 'quietnone', workId: 'work-quiet-none' });
  const calls = [];
  const { dependencies } = scriptedProvider({
    runtime(input) {
      calls.push(input.phase);
      return { status: 0, duration_ms: 1, log_digest: 'q'.repeat(64) };
    },
  });

  const state = advanceWork(opened.worktree, { runtime: 'claude', reviewPolicy: 'all' }, dependencies);

  assert.equal(state.lifecycle, 'complete', 'the Work runs to the end: nothing here can refuse it');
  assert.equal(state.blocked_precondition ?? null, null, 'and no ownership precondition was ever in play');
  assert.deepEqual(calls, [], 'no declared command is spoken — not up, not ready, not identity, not down');
  assert.equal(fs.existsSync(workPaths(opened.worktree, opened.workId).runtimeOwner), false,
    'and no claim is written for a program that was never started');
});

// Reconciliation is the one step that runs before any slice does and reads across every Work, so it is the
// step most able to touch a repository that asked for none of this. A claim left in the Pair store — by a
// declaration since deleted, or by a hand that wrote it — is not this run's to settle: with no declaration
// there is no `down` to speak, and the reading that clears the record without stopping the program is the
// same silent lie that an unreachable worktree's `down` would tell.
test('a repository that declares no runtime reconciles no claim', t => {
  const opened = openQuietWork(t, { prefix: 'quietclaim', workId: 'work-quiet-claim' });
  const { dependencies } = scriptedProvider({
    runtime() { throw new Error('a quiet repository must not run a declared runtime command'); },
  });
  const record = workPaths(opened.worktree, 'work-quiet-stranger').runtimeOwner;
  fs.mkdirSync(path.dirname(record), { recursive: true });
  const claim = { work_id: 'work-quiet-stranger', pid: deadPid(), worktree: opened.worktree, at: new Date().toISOString() };
  fs.writeFileSync(record, JSON.stringify(claim));

  const state = advanceWork(opened.worktree, { runtime: 'claude', reviewPolicy: 'all' }, dependencies);

  assert.equal(state.lifecycle, 'complete');
  assert.deepEqual(readJson(record), claim, 'the claim is left exactly as it was found, neither settled nor deleted');
  assert.deepEqual(readEvents(opened.worktree, 'work-quiet-stranger'), [],
    'and nothing is said against a Work this repository cannot act for');
});

// The handlers exist to pay a `down` on the way out. A repository with no `down` gains nothing from them and
// still pays for them: the loop stops dying from the first Ctrl-C by default disposition and starts dying
// from a re-raise instead, which is a change in how the person at the keyboard stops a run they never asked
// to have a program in.
test('a repository that declares no runtime arms no termination handler', t => {
  const opened = openQuietWork(t, { prefix: 'quietsignal', workId: 'work-quiet-signal' });
  const { dependencies } = scriptedProvider({
    runtime() { throw new Error('a quiet repository must not run a declared runtime command'); },
  });
  assert.deepEqual(armedSignals(), [], 'nothing of ours is listening before the run');

  advanceWork(opened.worktree, { runtime: 'claude', reviewPolicy: 'all' }, dependencies);

  assert.deepEqual(armedSignals(), [], 'and nothing of ours is listening after it');
});

// The loop's own handlers, told apart from whatever else in this test process listens for a signal.
function armedSignals() {
  return ['SIGINT', 'SIGTERM'].filter(signal =>
    process.listeners(signal).some(listener => listener.name === 'stopRuntimeOnSignal'));
}
