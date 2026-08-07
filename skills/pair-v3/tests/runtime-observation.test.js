// The loop starts the program once, waits until it answers, and asks it the slice's question after the
// slice's own tests pass.
//
// AC-4: the engine runs `up` once per Work, polls `ready` until it succeeds, and does not run `up` again
//       for a later slice in the same Work.
// AC-6: after a slice's `verify` succeeds its `probe` runs against the live runtime, and a failing probe
//       blocks the slice exactly as a failing verify does.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const childProcess = require('node:child_process');

const { acceptHumanReview, adjudicateFinding, advanceWork, setHumanLoop } = require('../scripts/lib/pair-engine');
const { blobAtCommit, readEvents, readJson, readState, workPaths } = require('../scripts/lib/pair-store');
const { listReviewOutcomes } = require('../scripts/lib/review-evidence');
const { completedSlice, greenVerification, openTestWork, providerResult } = require('./helpers/warm-work');

const PROBE = 'curl -fsS http://localhost:5080/health';
const SECOND_PROBE = 'curl -fsS http://localhost:5080/ready';

const RUNTIME_DECLARATION = JSON.stringify({
  up: 'start-the-program',
  ready: 'ask-whether-it-is-up',
  down: 'stop-the-program',
  env: { PAIR_TEST_RUNTIME: 'declared' },
});

const TWO_SLICE_SPEC = '# Spec\n\n## Acceptance Criteria\n\n- [ ] AC-1: value becomes two\n- [ ] AC-2: value becomes three\n';

// The same repository, able to answer which code its program is serving.
const IDENTIFIED_DECLARATION = JSON.stringify({
  up: 'start-the-program',
  ready: 'ask-whether-it-is-up',
  down: 'stop-the-program',
  identity: 'ask-which-code-it-serves',
  env: { PAIR_TEST_RUNTIME: 'declared' },
});

function twoSlicesWithProbes() {
  return [
    { id: 'S1', acceptance_criteria: ['AC-1'], outcome: 'Existing value returns two.', depends_on: [], verify: 'node verify.js', probe: PROBE },
    { id: 'S2', acceptance_criteria: ['AC-2'], outcome: 'Existing value returns three.', depends_on: ['S1'], verify: 'node verify.js', probe: SECOND_PROBE },
  ];
}

// A program that is down until something starts it, and stays up once started — which is what makes "run
// `up` once" observable: a second slice that asked `ready` first would find it already answering.
function fakeRuntime({ probeStatus = 0, downStatus = 0, serves = null } = {}) {
  const calls = [];
  let up = false;
  function runtime(input) {
    calls.push({ phase: input.phase, command: input.command, env: input.env });
    // What the program says it is serving. Only a repository that declared an `identity` command ever asks.
    if (input.phase === 'identity') return { status: 0, duration_ms: 1, log_digest: 'i'.repeat(64), output: `serving ${serves}\n` };
    if (input.phase === 'up') {
      up = true;
      return { status: 0, duration_ms: 1, log_digest: 'u'.repeat(64) };
    }
    if (input.phase === 'ready') return { status: up ? 0 : 1, duration_ms: 1, log_digest: 'r'.repeat(64) };
    if (input.phase === 'down') {
      // A `down` that fails stops nothing, which is the point of the failed-teardown case.
      if (downStatus === 0) up = false;
      return { status: downStatus, duration_ms: 1, log_digest: 'd'.repeat(64) };
    }
    return { status: probeStatus, duration_ms: 1, log_digest: 'p'.repeat(64) };
  }
  return { calls, runtime, isUp: () => up };
}

function scriptedProvider(extra) {
  const calls = [];
  return {
    calls,
    dependencies: {
      runProvider(input) {
        calls.push(input);
        if (input.schema?.properties?.verdict) return providerResult({ verdict: 'approve', findings: [] }, { session_id: 'review-sess' });
        fs.writeFileSync(path.join(input.root, 'value.js'), `module.exports = ${calls.length + 1};\n`);
        return providerResult(completedSlice(), { session_id: 'impl-sess' });
      },
      verify: greenVerification,
      hydrate: () => ({ hydrated: false }),
      ...extra,
    },
  };
}

function openProbedWork(t, { prefix, workId, slices = twoSlicesWithProbes(), config = {}, declaration = RUNTIME_DECLARATION }) {
  return openTestWork(t, {
    prefix,
    workId,
    slices,
    specMarkdown: TWO_SLICE_SPEC,
    // Committed, so the declaration is present in the Pair worktree the engine runs from — a runtime
    // declaration is repository content, not Pair state.
    files: { '.pair/runtime.json': declaration },
    config: { human_in_the_loop_default: false, ...config },
  });
}

function phases(calls) {
  return calls.map(call => call.phase);
}

function ownerRecord(opened) {
  return workPaths(opened.worktree, opened.workId).runtimeOwner;
}

// A reviewer that finds one thing per entry in `findsOn` — listing a slice twice is a slice reviewed twice,
// which is the road to the block — anchored to the checkpoint that slice is standing on, and approves
// everything else. `completionVerifyFails` reddens only the cumulative run, whose sliceId is 'completion',
// leaving every slice's own verification green.
function reviewingProvider(opened, runtime, { findsOn = [], completionVerifyFails = false } = {}) {
  const rounds = [...findsOn];
  let built = 1;
  return {
    runProvider(input) {
      if (input.schema?.properties?.verdict) {
        const sliceId = activeSliceId(opened);
        const round = rounds.indexOf(sliceId);
        if (round === -1) return providerResult({ verdict: 'approve', findings: [] }, { session_id: 'review-sess' });
        rounds.splice(round, 1);
        return providerResult({ verdict: 'findings', findings: [modelFinding(opened, sliceId)] }, { session_id: 'review-sess' });
      }
      built += 1;
      // One file per Review Slice: two slices editing the same file make the Work require a combined-diff
      // review, which would put a dispatch between the acceptance and the completion under test.
      fs.writeFileSync(path.join(input.root, `${activeSliceId(opened)}.js`), `module.exports = ${built};\n`);
      return providerResult(completedSlice(), { session_id: 'impl-sess' });
    },
    verify(input) {
      if (completionVerifyFails && input.sliceId === 'completion') return { status: 1, duration_ms: 3, log_digest: 'b'.repeat(64) };
      return greenVerification();
    },
    hydrate: () => ({ hydrated: false }),
    runtime,
  };
}

// The provider call carries no slice id, so the slice being reviewed is read from the state the dispatch
// saved before asking: the one standing at review-ready, or failing that the first one not yet accepted.
function activeSliceId(opened) {
  const slices = readState(opened.worktree, opened.workId).slices;
  return (slices.find(item => item.status === 'review-ready') || slices.find(item => item.status !== 'accepted') || slices[0]).id;
}

function modelFinding(opened, sliceId) {
  const projected = readState(opened.worktree, opened.workId).slices.find(item => item.id === sliceId);
  return {
    severity: 'MAJOR',
    claim: `The export is a bare literal with no lookup seam (${sliceId}).`,
    scenario: 'A second composition root cannot obtain its own value.',
    impact: 'Callers share one module-global value.',
    pass_condition: 'Two independent roots each observe their own value.',
    evidence: {
      commit: projected.checkpoint_commit,
      path: 'value.js',
      blob: blobAtCommit(opened.worktree, projected.checkpoint_commit, 'value.js'),
      line_start: 1,
      line_end: 1,
    },
  };
}

// Building, reviewing, correcting: the road to the gate, none of it the subject here.
function driveUntil(opened, dependencies, arrived) {
  for (let action = 0; action < 12; action += 1) {
    if (arrived(readState(opened.worktree, opened.workId))) return;
    advanceWork(opened.worktree, { runtime: 'claude', reviewPolicy: 'all' }, dependencies);
  }
  assert.ok(arrived(readState(opened.worktree, opened.workId)), 'the fixture never reached the state under test');
}

// The same road, with the human answering each finding on the way so the slice reaches the gate its
// corrected checkpoint waits at.
function driveToAcceptance(opened, dependencies, sliceId) {
  for (let action = 0; action < 12; action += 1) {
    const projected = readState(opened.worktree, opened.workId).slices.find(item => item.id === sliceId);
    if (projected?.status === 'awaiting-human-review') return;
    if (projected?.status === 'awaiting-feedback') adjudicateFinding(opened.worktree, adjudication(opened, sliceId), dependencies);
    else advanceWork(opened.worktree, { runtime: 'claude', reviewPolicy: 'all' }, dependencies);
  }
  assert.fail(`Review Slice ${sliceId} never reached human acceptance`);
}

// The human's gesture: the finding is real, and it is the only one open.
function adjudication(opened, sliceId) {
  const projected = readState(opened.worktree, opened.workId).slices.find(item => item.id === sliceId);
  const outcome = listReviewOutcomes(opened.worktree, opened.workId)
    .find(item => item.review_outcome_id === projected.review_outcome_id);
  return { findingId: outcome.findings[0].finding_id, disposition: 'valid', reason: 'The lookup seam is genuinely missing.' };
}

// A pid that certainly existed and certainly does not now, rather than a large number guessed to be free:
// a guess that happens to hit a live process turns this test into a flake that blames the wrong code.
function deadPid() {
  return childProcess.spawnSync('true').pid;
}

test('the program is started once for the Work and asked once per slice', t => {
  const opened = openProbedWork(t, { prefix: 'probeonce', workId: 'work-probe-once' });
  const runtime = fakeRuntime();
  const { dependencies } = scriptedProvider({ runtime: runtime.runtime });

  const state = advanceWork(opened.worktree, { runtime: 'claude', reviewPolicy: 'all' }, dependencies);

  assert.equal(state.lifecycle, 'complete');
  assert.equal(phases(runtime.calls).filter(phase => phase === 'up').length, 1,
    'a second `up` would restart the human development stack in the middle of a Work');
  assert.deepEqual(phases(runtime.calls), ['ready', 'up', 'ready', 'probe', 'ready', 'probe', 'down'],
    'ready is asked before up, polled until it answers, and asked again for the next slice instead of starting a second instance');
  assert.deepEqual(
    runtime.calls.filter(call => call.phase === 'probe').map(call => call.command),
    [PROBE, SECOND_PROBE],
    'each slice asked its own question');
});

test('the declared environment reaches the command that starts the program', t => {
  const opened = openProbedWork(t, { prefix: 'probeenv', workId: 'work-probe-env' });
  const runtime = fakeRuntime();
  const { dependencies } = scriptedProvider({ runtime: runtime.runtime });

  advanceWork(opened.worktree, { runtime: 'claude', reviewPolicy: 'all' }, dependencies);

  assert.deepEqual(runtime.calls.find(call => call.phase === 'up').env, { PAIR_TEST_RUNTIME: 'declared' });
});

// The point of the whole change: green tests and a program that answers wrong is a failed slice, not an
// accepted one. It travels the road a failing verify travels — one bounded correction, then the block.
test('a wrong answer from the running program blocks the slice', t => {
  const opened = openProbedWork(t, { prefix: 'probered', workId: 'work-probe-red' });
  const runtime = fakeRuntime({ probeStatus: 1 });
  const { dependencies } = scriptedProvider({ runtime: runtime.runtime });

  const state = advanceWork(opened.worktree, { runtime: 'claude', reviewPolicy: 'all' }, dependencies);

  assert.equal(state.lifecycle, 'blocked');
  const first = readState(opened.worktree, opened.workId).slices[0];
  assert.equal(first.status, 'blocked');
  assert.equal(first.verification.status, 1, 'the slice is red even though its own verification command passed');

  const probeEvents = readEvents(opened.worktree, opened.workId).filter(event => event.event === 'probe-finished');
  assert.ok(probeEvents.length >= 1);
  assert.equal(probeEvents[0].review_slice_id, 'S1');
  assert.equal(probeEvents[0].status, 1);
});

// Nothing the program says is ever written down. `up` carries an env map that names where credentials come
// from, and a probe talks to a live service, so only a status, a duration and a digest survive the call.
test('no probe output is persisted', t => {
  const opened = openProbedWork(t, { prefix: 'probequiet', workId: 'work-probe-quiet' });
  const runtime = fakeRuntime({ probeStatus: 1 });
  const { dependencies } = scriptedProvider({ runtime: runtime.runtime });

  advanceWork(opened.worktree, { runtime: 'claude', reviewPolicy: 'all' }, dependencies);

  const events = readEvents(opened.worktree, opened.workId).filter(event => event.event === 'probe-finished');
  assert.deepEqual(Object.keys(events[0]).filter(key => key.includes('output') || key === 'stdout' || key === 'stderr'), []);
  const failure = readState(opened.worktree, opened.workId).slices[0].verification_failure || '';
  assert.equal(failure.includes('PAIR_TEST_RUNTIME'), false);
});

// AC-8: the three ways a Work stops driving its program, and the one instance that must not survive any of
// them. A stale instance is worse than no instance: it answers, and it answers for the previous code.
test('the program is stopped when the Work completes', t => {
  const opened = openProbedWork(t, { prefix: 'downdone', workId: 'work-down-done' });
  const runtime = fakeRuntime();
  const { dependencies } = scriptedProvider({ runtime: runtime.runtime });

  const state = advanceWork(opened.worktree, { runtime: 'claude', reviewPolicy: 'all' }, dependencies);

  assert.equal(state.lifecycle, 'complete');
  assert.equal(phases(runtime.calls).at(-1), 'down', 'the last thing a finished Work does is stop its program');
  assert.equal(runtime.isUp(), false);
  const stopped = readEvents(opened.worktree, opened.workId).filter(event => event.event === 'runtime-stopped');
  assert.equal(stopped.length, 1);
  assert.equal(stopped[0].status, 0);
  assert.equal(fs.existsSync(ownerRecord(opened)), false, 'a released instance leaves no claim behind');
});

test('the program is stopped when the Work blocks', t => {
  const opened = openProbedWork(t, { prefix: 'downblock', workId: 'work-down-block' });
  const runtime = fakeRuntime({ probeStatus: 1 });
  const { dependencies } = scriptedProvider({ runtime: runtime.runtime });

  const state = advanceWork(opened.worktree, { runtime: 'claude', reviewPolicy: 'all' }, dependencies);

  assert.equal(state.lifecycle, 'blocked');
  assert.equal(phases(runtime.calls).at(-1), 'down');
  assert.equal(runtime.isUp(), false);
  assert.equal(fs.existsSync(ownerRecord(opened)), false);
});

// A dispatch is not the only thing that ends a Work, and two reviews in a row each found a DIFFERENT road
// into a terminal lifecycle with no `down` on it: a human `adjudicate` that spends the last correction, then
// an `accept` whose cumulative verification finishes the Work. Both are reducer calls the loop is not
// standing in, and the claim the previous run parked reads `null`, which reclamation leaves alone by design
// as an instance handed on rather than abandoned. So the roads are enumerated rather than sampled — one
// entry per gesture that can land a Work in `complete` or `blocked` — and they share their assertions,
// because what is under test is that arriving is enough, whichever way the Work arrives.
const TERMINAL_PATHS = [
  {
    label: 'a dispatch finishes the Work',
    lifecycle: 'complete',
    config: { human_in_the_loop_default: false },
    approach: (opened, dependencies) => () => advanceWork(opened.worktree, { runtime: 'claude', reviewPolicy: 'all' }, dependencies),
  },
  {
    label: 'the running program answers a slice wrong',
    lifecycle: 'blocked',
    config: { human_in_the_loop_default: false },
    runtime: { probeStatus: 1 },
    approach: (opened, dependencies) => () => advanceWork(opened.worktree, { runtime: 'claude', reviewPolicy: 'all' }, dependencies),
  },
  {
    label: 'a human adjudication spends the last correction',
    lifecycle: 'blocked',
    parked: true,
    // One action per run, so every dispatch ends the way a real one does: short of finishing, handing its
    // program to the next run and leaving a claim that names no process.
    config: { human_in_the_loop_default: false, autonomous_actions_per_run: 1 },
    provider: { findsOn: ['S1', 'S1'] },
    approach(opened, dependencies) {
      driveUntil(opened, dependencies, state => state.slices[0].correction_count >= 1);
      // The human steps into the next round, which is what leaves the second finding for them to answer.
      setHumanLoop(opened.worktree, { sliceId: 'S1', humanLoop: true });
      driveUntil(opened, dependencies, state => state.slices[0].status === 'awaiting-feedback');
      return () => adjudicateFinding(opened.worktree, adjudication(opened, 'S1'), dependencies);
    },
  },
  {
    label: 'a human accepts the corrected checkpoint of the last Review Slice',
    lifecycle: 'complete',
    parked: true,
    config: { human_in_the_loop_default: true },
    provider: { findsOn: ['S2'] },
    approach(opened, dependencies) {
      driveToAcceptance(opened, dependencies, 'S2');
      return () => acceptHumanReview(opened.worktree, { sliceId: 'S2' }, dependencies);
    },
  },
  {
    label: 'the cumulative verification the acceptance triggers comes back red',
    lifecycle: 'blocked',
    parked: true,
    config: { human_in_the_loop_default: true },
    provider: { findsOn: ['S2'], completionVerifyFails: true },
    approach(opened, dependencies) {
      driveToAcceptance(opened, dependencies, 'S2');
      return () => acceptHumanReview(opened.worktree, { sliceId: 'S2' }, dependencies);
    },
  },
];

for (const [index, terminal] of TERMINAL_PATHS.entries()) {
  test(`the program is stopped when ${terminal.label}`, t => {
    const opened = openProbedWork(t, {
      prefix: `downpath${index}`,
      workId: `work-down-path-${index}`,
      config: terminal.config,
    });
    const runtime = fakeRuntime(terminal.runtime || {});
    const dependencies = reviewingProvider(opened, runtime.runtime, terminal.provider || {});

    const cross = terminal.approach(opened, dependencies);
    if (terminal.parked) {
      assert.equal(readJson(ownerRecord(opened)).pid, null, 'the run before the gesture ended at a gate, so its claim names no process');
      assert.equal(runtime.isUp(), true, 'and the program it handed on is still running');
    }
    runtime.calls.length = 0;
    const state = cross();

    assert.equal(state.lifecycle, terminal.lifecycle);
    assert.equal(phases(runtime.calls).at(-1), 'down', 'the Work stopped being driven, so its program stopped too');
    assert.equal(runtime.isUp(), false);
    assert.equal(fs.existsSync(ownerRecord(opened)), false, 'and no claim is left on the Work’s worktree');
  });
}

// The case no exit handler can cover: the loop was killed outright, so nothing ran on the way out and the
// instance is still up. The claim it left names a pid that is gone — which is what the next run reads.
test('a program left behind by a killed loop is stopped by the next run', t => {
  const opened = openProbedWork(t, { prefix: 'downkilled', workId: 'work-down-killed' });
  const runtime = fakeRuntime();
  const { dependencies } = scriptedProvider({ runtime: runtime.runtime });
  fs.mkdirSync(path.dirname(ownerRecord(opened)), { recursive: true });
  fs.writeFileSync(ownerRecord(opened), JSON.stringify({
    pid: deadPid(),
    work_id: opened.workId,
    worktree: opened.worktree,
    at: new Date().toISOString(),
  }));

  advanceWork(opened.worktree, { runtime: 'claude', reviewPolicy: 'all' }, dependencies);

  assert.equal(phases(runtime.calls)[0], 'down', 'the abandoned instance is stopped before this run asks anything');
  const reclaimed = readEvents(opened.worktree, opened.workId).filter(event => event.event === 'runtime-reclaimed');
  assert.equal(reclaimed.length, 1);
});

// The same abandonment, one Work over — and the likelier half of it, because a loop killed while driving one
// Work is usually followed by a run on a different one. Reading only the driven Work's claim leaves the
// stranded instance up, and since the runtime binds fixed host ports it then answers the new Work's
// readiness check and is adopted: the new Work reports on the killed Work's worktree under its own name.
test('a program stranded on another Work is stopped by a run on this one', t => {
  const opened = openProbedWork(t, { prefix: 'downcross', workId: 'work-down-cross' });
  const runtime = fakeRuntime();
  const { dependencies } = scriptedProvider({ runtime: runtime.runtime });
  const stranded = workPaths(opened.worktree, 'work-down-stranded').runtimeOwner;
  fs.mkdirSync(path.dirname(stranded), { recursive: true });
  fs.writeFileSync(stranded, JSON.stringify({
    pid: deadPid(),
    work_id: 'work-down-stranded',
    worktree: opened.worktree,
    at: new Date().toISOString(),
  }));

  advanceWork(opened.worktree, { runtime: 'claude', reviewPolicy: 'all' }, dependencies);

  assert.equal(phases(runtime.calls)[0], 'down', 'the other Work’s abandoned instance is stopped before this run asks anything');
  assert.equal(fs.existsSync(stranded), false, 'and its claim is gone, so no later run stops it a second time');
  const reclaimed = readEvents(opened.worktree, 'work-down-stranded').filter(event => event.event === 'runtime-reclaimed');
  assert.equal(reclaimed.length, 1, 'recorded against the Work that was abandoned, not the one that cleaned up after it');
});

// The safety half of the same record. `ready` answering before `up` means the instance was already there —
// the human's own development stack — and stopping it would destroy something the loop never started.
test('a program the loop did not start is never stopped', t => {
  const opened = openProbedWork(t, { prefix: 'downtheirs', workId: 'work-down-theirs' });
  const runtime = fakeRuntime();
  runtime.runtime({ phase: 'up', command: 'started-by-the-human', env: {} });
  runtime.calls.length = 0;
  const { dependencies } = scriptedProvider({ runtime: runtime.runtime });

  advanceWork(opened.worktree, { runtime: 'claude', reviewPolicy: 'all' }, dependencies);

  assert.deepEqual(phases(runtime.calls).filter(phase => phase === 'up' || phase === 'down'), [],
    'neither started nor stopped: the instance belongs to whoever brought it up');
  assert.equal(runtime.isUp(), true);
});

// AC-2: green only says something is listening on a fixed host port. When the repository can ask which code
// is being served and the answer names this Work's worktree, that program is used as it stands: restarting a
// program that is already serving the right code buys nothing and costs the human their running stack.
test('a program already serving this Work is used without being restarted', t => {
  const opened = openProbedWork(t, {
    prefix: 'probeidentity',
    workId: 'work-probe-identity',
    declaration: IDENTIFIED_DECLARATION,
  });
  const runtime = fakeRuntime({ serves: path.basename(opened.worktree) });
  runtime.runtime({ phase: 'up', command: 'already-running-against-this-worktree', env: {} });
  runtime.calls.length = 0;
  const { dependencies } = scriptedProvider({ runtime: runtime.runtime });

  const state = advanceWork(opened.worktree, { runtime: 'claude', reviewPolicy: 'all' }, dependencies);

  assert.equal(state.lifecycle, 'complete');
  assert.deepEqual(phases(runtime.calls).filter(phase => phase === 'up'), [],
    'the program was proven to be ours, so there was nothing to start');
  assert.deepEqual(phases(runtime.calls).slice(0, 3), ['ready', 'identity', 'probe'],
    'identity is asked after green and before the slice question it makes trustworthy');
});

// A run that stops at the action cap exits normally at a non-terminal lifecycle, so it keeps its instance —
// and the claim it leaves must not read as a death. Tearing down here would restart the human's stack at
// every capped and hitl boundary, and would break S-01's "up runs once per Work".
test('a run that stops short of finishing hands the program to the next run', t => {
  const opened = openProbedWork(t, {
    prefix: 'downcapped',
    workId: 'work-down-capped',
    config: { autonomous_actions_per_run: 2 },
  });
  const runtime = fakeRuntime();
  const { dependencies } = scriptedProvider({ runtime: runtime.runtime });

  const first = advanceWork(opened.worktree, { runtime: 'claude', reviewPolicy: 'all' }, dependencies);

  assert.notEqual(first.lifecycle, 'complete', 'the cap is what ends this run, not the Work finishing');
  assert.deepEqual(phases(runtime.calls).filter(phase => phase === 'down'), [], 'a capped run keeps its program');
  assert.equal(runtime.isUp(), true);
  assert.equal(readJson(ownerRecord(opened)).pid, null, 'the claim stops naming a process without being deleted');

  runtime.calls.length = 0;
  advanceWork(opened.worktree, { runtime: 'claude', reviewPolicy: 'all' }, dependencies);

  assert.deepEqual(phases(runtime.calls).filter(phase => phase === 'up' || phase === 'down'), [],
    'the next run adopts the instance it was handed instead of stopping it and booting a second');
});

// The claim is the only durable evidence that this Work owes a teardown, so it cannot be spent before the
// step that can fail. A `down` that exits non-zero has stopped nothing.
test('a failed teardown keeps the claim so a later run retries it', t => {
  const opened = openProbedWork(t, { prefix: 'downfails', workId: 'work-down-fails' });
  const runtime = fakeRuntime({ downStatus: 1 });
  const progress = [];
  const { dependencies } = scriptedProvider({ runtime: runtime.runtime, onProgress: event => progress.push(event) });

  advanceWork(opened.worktree, { runtime: 'claude', reviewPolicy: 'all' }, dependencies);

  assert.equal(runtime.isUp(), true, 'the program a failing `down` did not stop is still running');
  assert.equal(readJson(ownerRecord(opened)).pid, process.pid, 'the claim survives to name a pid a later run finds dead');
  assert.ok(progress.some(event => event.phase === 'runtime-stop-failed' && event.status === 1),
    'a program still running against the worktree is said out loud, not left as a field in the journal');
});

// The defect this replaced: the handlers were removed in a `finally` that ran before the event loop could
// ever dispatch a queued signal, so Ctrl-C during a fully synchronous dispatch tore down nothing.
test('the signal handlers outlive the dispatch that armed them', t => {
  const opened = openProbedWork(t, { prefix: 'downsignal', workId: 'work-down-signal' });
  const runtime = fakeRuntime();
  const { dependencies } = scriptedProvider({ runtime: runtime.runtime });

  advanceWork(opened.worktree, { runtime: 'claude', reviewPolicy: 'all' }, dependencies);
  const armed = process.listenerCount('SIGINT');

  assert.ok(armed > 0,
    'a signal queued during the synchronous dispatch is only deliverable if the listener is still installed when the stack unwinds');
  assert.ok(process.listenerCount('SIGTERM') > 0);

  advanceWork(opened.worktree, { runtime: 'claude', reviewPolicy: 'all' }, dependencies);

  assert.equal(process.listenerCount('SIGINT'), armed, 'arming is idempotent: a run per Work must not stack a handler per run');
});

// A Work whose repository never said how to start a program runs exactly as it did before this existed.
test('a Work with no runtime declaration never touches a runtime', t => {
  const opened = openTestWork(t, { prefix: 'probenone', workId: 'work-probe-none', config: { human_in_the_loop_default: false } });
  const runtime = fakeRuntime();
  const { dependencies } = scriptedProvider({ runtime: runtime.runtime });

  const state = advanceWork(opened.worktree, { runtime: 'claude', reviewPolicy: 'all' }, dependencies);

  assert.equal(state.lifecycle, 'complete');
  assert.deepEqual(runtime.calls, []);
});
