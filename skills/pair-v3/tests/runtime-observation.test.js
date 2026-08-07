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

const { advanceWork } = require('../scripts/lib/pair-engine');
const { readEvents, readJson, readState, workPaths } = require('../scripts/lib/pair-store');
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

function twoSlicesWithProbes() {
  return [
    { id: 'S1', acceptance_criteria: ['AC-1'], outcome: 'Existing value returns two.', depends_on: [], verify: 'node verify.js', probe: PROBE },
    { id: 'S2', acceptance_criteria: ['AC-2'], outcome: 'Existing value returns three.', depends_on: ['S1'], verify: 'node verify.js', probe: SECOND_PROBE },
  ];
}

// A program that is down until something starts it, and stays up once started — which is what makes "run
// `up` once" observable: a second slice that asked `ready` first would find it already answering.
function fakeRuntime({ probeStatus = 0, downStatus = 0 } = {}) {
  const calls = [];
  let up = false;
  function runtime(input) {
    calls.push({ phase: input.phase, command: input.command, env: input.env });
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

function openProbedWork(t, { prefix, workId, slices = twoSlicesWithProbes(), config = {} }) {
  return openTestWork(t, {
    prefix,
    workId,
    slices,
    specMarkdown: TWO_SLICE_SPEC,
    // Committed, so the declaration is present in the Pair worktree the engine runs from — a runtime
    // declaration is repository content, not Pair state.
    files: { '.pair/runtime.json': RUNTIME_DECLARATION },
    config: { human_in_the_loop_default: false, ...config },
  });
}

function phases(calls) {
  return calls.map(call => call.phase);
}

function ownerRecord(opened) {
  return workPaths(opened.worktree, opened.workId).runtimeOwner;
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
