// Whose program is answering. The runtime binds fixed host ports, so anything up answers green — and only
// the `identity` question can tell this Work's program apart from another Work's, or from the human's own
// stack. What the answer buys is the right to refuse.
//
// AC-3: when `identity` is declared and its output does not match, the runtime is not probed; a claim held
//       by another Work is torn down first, and with no such claim the run refuses.
// AC-5: a refusal says what it found, names both ways forward, and spends no correction — refusing to guess
//       is not a failure to implement, and the budget belongs to defects.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { RUNTIME_OWNERSHIP_PRECONDITION, advanceWork, unblockWork, verifyActiveSlice } = require('../scripts/lib/pair-engine');
const { readEvents, readState, workPaths } = require('../scripts/lib/pair-store');
const {
  IDENTIFIED_DECLARATION,
  fakeRuntime,
  openProbedWork,
  ownerRecord,
  phases,
  scriptedProvider,
} = require('./helpers/runtime-work');

// AC-3: green, serving another Work's worktree, and claimed by that Work — so the loop started it and still
// owes it a `down`. Stopping it is that teardown, and it frees the fixed host ports this Work's own instance
// needs. Nothing is asked of the stranger on the way past.
test('a program serving another Work is stopped before this Work starts its own', t => {
  const opened = openProbedWork(t, {
    prefix: 'probestranger',
    workId: 'work-probe-stranger',
    declaration: IDENTIFIED_DECLARATION,
  });
  // Up before this run begins and serving the other Work, so only this repository's own `up` can make the
  // program answer for this worktree.
  const runtime = fakeRuntime({
    alreadyUp: true,
    serves: 'work-probe-elsewhere',
    startsServing: path.basename(opened.worktree),
  });
  const { dependencies } = scriptedProvider({ runtime: runtime.runtime });
  // Parked, not abandoned: reclamation leaves a `null` pid alone by design, so this is the claim only the
  // identity answer can expose.
  const stranger = workPaths(opened.worktree, 'work-probe-elsewhere').runtimeOwner;
  fs.mkdirSync(path.dirname(stranger), { recursive: true });
  fs.writeFileSync(stranger, JSON.stringify({
    pid: null,
    work_id: 'work-probe-elsewhere',
    worktree: opened.worktree,
    at: new Date().toISOString(),
  }));

  const state = advanceWork(opened.worktree, { runtime: 'claude', reviewPolicy: 'all' }, dependencies);

  assert.equal(state.lifecycle, 'complete');
  assert.deepEqual(phases(runtime.calls).slice(0, 4), ['ready', 'identity', 'down', 'up'],
    'the stranger is torn down before this Work’s own program is started, and is never probed');
  assert.equal(fs.existsSync(stranger), false, 'the other Work’s claim is settled by the teardown that honoured it');
  assert.equal(
    readEvents(opened.worktree, opened.workId).filter(event => event.event === 'runtime-foreign').length,
    1);
});

// AC-3, the other half: nobody claims what is answering, so this loop never started it — the human's own
// stack on the same fixed ports. Stopping it is not this run's to do and probing it would answer this
// slice's question against their checkout, so the run refuses and names why.
test('a program nobody claims stops the run instead of being adopted', t => {
  const opened = openProbedWork(t, {
    prefix: 'probeunowned',
    workId: 'work-probe-unowned',
    declaration: IDENTIFIED_DECLARATION,
  });
  const runtime = fakeRuntime({ serves: 'the-humans-own-checkout' });
  runtime.runtime({ phase: 'up', command: 'started-by-the-human', env: {} });
  runtime.calls.length = 0;
  const { dependencies } = scriptedProvider({ runtime: runtime.runtime });

  const state = advanceWork(opened.worktree, { runtime: 'claude', reviewPolicy: 'all' }, dependencies);

  assert.equal(state.lifecycle, 'blocked');
  assert.deepEqual(phases(runtime.calls).filter(phase => phase !== 'ready' && phase !== 'identity'), [],
    'nothing was started, nothing was stopped, and nothing was asked of a program that is not ours');
  assert.equal(runtime.isUp(), true);
  const blocked = readState(opened.worktree, opened.workId);
  assert.match(blocked.blocked_reason || '', /no Pair Work claims it/);
  assert.equal((blocked.blocked_reason || '').includes(path.basename(opened.worktree)), true,
    'the refusal names the worktree the program should have been serving');
});

// AC-5: the tests passed. What stopped the run is that nothing could prove which checkout the answering
// program is serving — a fact about the host, not a defect in the slice. Sending the one bounded correction
// at it would spend the budget instructing a model to fix code that is already right, and then the second
// refusal would block the slice for good. So the refusal parks on a precondition, exactly as a dirty
// worktree does, and re-verification is what clears it.
test('a refusal it cannot prove parks the Work and spends no correction', t => {
  const opened = openProbedWork(t, {
    prefix: 'probenocorrection',
    workId: 'work-probe-no-correction',
    declaration: IDENTIFIED_DECLARATION,
  });
  const runtime = fakeRuntime({ alreadyUp: true, serves: 'the-humans-own-checkout' });
  const { calls, dependencies } = scriptedProvider({ runtime: runtime.runtime });

  const state = advanceWork(opened.worktree, { runtime: 'claude', reviewPolicy: 'all' }, dependencies);

  assert.equal(state.lifecycle, 'blocked');
  assert.equal(state.blocked_precondition, RUNTIME_OWNERSHIP_PRECONDITION);
  assert.equal(calls.length, 1, 'the implementation ran and nothing else did: no correction was dispatched');
  const projected = state.slices[0];
  assert.equal(projected.status, 'blocked');
  assert.equal(projected.correction_count || 0, 0, 'the one bounded correction is still there to spend on a defect');
  assert.equal(projected.verification_failure, undefined,
    'nothing deterministic failed, so the slice is not armed to dispatch a correction on unblock');
  assert.notEqual(projected.blocked_from, 'blocked');
});

// AC-5: what it found, and both ways out of it — because neither is guessable from a status. The finding is
// which of the two ways the proof failed: an answer that named somebody else, or no answer at all.
test('a refusal reports what it found and names both ways forward', t => {
  const opened = openProbedWork(t, {
    prefix: 'probeunanswered',
    workId: 'work-probe-unanswered',
    declaration: IDENTIFIED_DECLARATION,
  });
  const runtime = fakeRuntime({ alreadyUp: true, serves: 'the-humans-own-checkout', identityStatus: 3 });
  const { dependencies } = scriptedProvider({ runtime: runtime.runtime });

  const state = advanceWork(opened.worktree, { runtime: 'claude', reviewPolicy: 'all' }, dependencies);

  const reason = state.blocked_reason || '';
  assert.match(reason, /identity/, 'the finding is about the question that could not be answered');
  assert.match(reason, /exited 3/, 'and it says how it failed, which distinguishes it from an answer that named someone else');
  assert.match(reason, /stop/i, 'the first way forward: the instance answering there goes away');
  assert.match(reason, /report/i, 'the second: the repository states how the program reports what it serves');
  assert.match(reason, /is a correction/, 'and that taking either costs no correction, which no status says');
});

// AC-5: the refusal must not itself do the thing it refused to make a decision about. `down` is a declared
// command against whatever holds the fixed ports, not a signal at a pid, so tearing down on the way into the
// block would stop the program the run had just declined to even ask a question of. Reachable because this
// Work can hold an outstanding claim from a slice that did start a program, which is what makes the block's
// lifecycle terminal and the teardown automatic.
test('a refusal stops nothing while it cannot say what it would be stopping', t => {
  const opened = openProbedWork(t, {
    prefix: 'probenodown',
    workId: 'work-probe-no-down',
    declaration: IDENTIFIED_DECLARATION,
  });
  const runtime = fakeRuntime({ alreadyUp: true, serves: 'the-humans-own-checkout', identityStatus: 3 });
  const { dependencies } = scriptedProvider({ runtime: runtime.runtime });
  // An earlier slice of this Work started a program and handed it on, so a claim of its own is outstanding —
  // and a claim is all `down` needs to run.
  fs.mkdirSync(path.dirname(ownerRecord(opened)), { recursive: true });
  fs.writeFileSync(ownerRecord(opened), JSON.stringify({
    pid: null,
    work_id: opened.workId,
    worktree: opened.worktree,
    at: new Date().toISOString(),
  }));

  const state = advanceWork(opened.worktree, { runtime: 'claude', reviewPolicy: 'all' }, dependencies);

  assert.equal(state.blocked_precondition, RUNTIME_OWNERSHIP_PRECONDITION);
  assert.equal(phases(runtime.calls).includes('down'), false, 'nothing was stopped that nothing could identify');
  assert.equal(runtime.isUp(), true);
  assert.equal(fs.existsSync(ownerRecord(opened)), true, 'the debt stays recorded for a run that can say what it is paying');
  assert.equal(JSON.parse(fs.readFileSync(ownerRecord(opened), 'utf8')).pid, null,
    'and parked, so reclamation does not speak down at it blindly on the next run');
});

// AC-5: both ways forward, and only ways that work. Unblocking clears a block by recording a human decision
// about this Work, and this block is a fact about the host — there is no ownership to waive, so unblocking
// would resume the slice as a fresh attempt over its own uncommitted worktree and land a second block naming
// a wrong cause, with the identity question still unasked.
test('unblocking is refused for a refusal and names the gesture that re-asks the question', t => {
  const opened = openProbedWork(t, {
    prefix: 'probeunblock',
    workId: 'work-probe-unblock',
    declaration: IDENTIFIED_DECLARATION,
  });
  const runtime = fakeRuntime({ alreadyUp: true, serves: 'the-humans-own-checkout' });
  const { dependencies } = scriptedProvider({ runtime: runtime.runtime });
  advanceWork(opened.worktree, { runtime: 'claude', reviewPolicy: 'all' }, dependencies);

  assert.throws(
    () => unblockWork(opened.worktree, { workId: opened.workId, reason: 'I am sure that program is mine' }),
    /pair-loop verify --slice S1/,
    'the refusal names the free gesture instead of clearing a precondition it cannot clear',
  );
  const after = readState(opened.worktree, opened.workId);
  assert.equal(after.blocked_precondition, RUNTIME_OWNERSHIP_PRECONDITION, 'the block stands rather than becoming a dirty-worktree block');
  assert.equal(after.slices[0].status, 'blocked');
});

// AC-5, the way back: the human stopped the instance, and the gesture that resumes the slice is the free one.
// Re-verification is not a model action, so the refusal costs nothing at all — the slice reaches its
// checkpoint on the same road an environmental verification failure reaches it.
test('re-verification after the instance is stopped checkpoints the refused Review Slice', t => {
  const opened = openProbedWork(t, {
    prefix: 'probecleared',
    workId: 'work-probe-cleared',
    declaration: IDENTIFIED_DECLARATION,
  });
  const runtime = fakeRuntime({
    alreadyUp: true,
    serves: 'the-humans-own-checkout',
    startsServing: path.basename(opened.worktree),
  });
  const { dependencies } = scriptedProvider({ runtime: runtime.runtime });
  const blocked = advanceWork(opened.worktree, { runtime: 'claude', reviewPolicy: 'all' }, dependencies);
  assert.equal(blocked.lifecycle, 'blocked');

  // The human's own hands, outside the loop: the instance that was in the way is gone.
  runtime.runtime({ phase: 'down', command: 'the-human-stopped-their-own-stack', env: {} });
  runtime.calls.length = 0;

  const { report, state } = verifyActiveSlice(opened.worktree, { workId: opened.workId, sliceId: 'S1' }, dependencies);

  assert.equal(report.status, 0);
  assert.ok(report.checkpoint_created, 're-verification is the escape from a refusal, as it is from a flake');
  assert.equal(state.slices[0].correction_count || 0, 0, 'no model ran, so no correction was spent');
  assert.notEqual(state.lifecycle, 'blocked');
  assert.equal(state.blocked_precondition, null);
  assert.equal(state.slices[0].blocked_from, undefined);
  assert.deepEqual(phases(runtime.calls).slice(0, 2), ['ready', 'up'], 'this Work started its own program on the freed ports');
});
