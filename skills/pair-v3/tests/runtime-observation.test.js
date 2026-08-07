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

const { advanceWork } = require('../scripts/lib/pair-engine');
const { readEvents, readState } = require('../scripts/lib/pair-store');
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
function fakeRuntime({ probeStatus = 0 } = {}) {
  const calls = [];
  let up = false;
  function runtime(input) {
    calls.push({ phase: input.phase, command: input.command, env: input.env });
    if (input.phase === 'up') {
      up = true;
      return { status: 0, duration_ms: 1, log_digest: 'u'.repeat(64) };
    }
    if (input.phase === 'ready') return { status: up ? 0 : 1, duration_ms: 1, log_digest: 'r'.repeat(64) };
    return { status: probeStatus, duration_ms: 1, log_digest: 'p'.repeat(64) };
  }
  return { calls, runtime };
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

function openProbedWork(t, { prefix, workId, slices = twoSlicesWithProbes() }) {
  return openTestWork(t, {
    prefix,
    workId,
    slices,
    specMarkdown: TWO_SLICE_SPEC,
    // Committed, so the declaration is present in the Pair worktree the engine runs from — a runtime
    // declaration is repository content, not Pair state.
    files: { '.pair/runtime.json': RUNTIME_DECLARATION },
    config: { human_in_the_loop_default: false },
  });
}

function phases(calls) {
  return calls.map(call => call.phase);
}

test('the program is started once for the Work and asked once per slice', t => {
  const opened = openProbedWork(t, { prefix: 'probeonce', workId: 'work-probe-once' });
  const runtime = fakeRuntime();
  const { dependencies } = scriptedProvider({ runtime: runtime.runtime });

  const state = advanceWork(opened.worktree, { runtime: 'claude', reviewPolicy: 'all' }, dependencies);

  assert.equal(state.lifecycle, 'complete');
  assert.equal(phases(runtime.calls).filter(phase => phase === 'up').length, 1,
    'a second `up` would restart the human development stack in the middle of a Work');
  assert.deepEqual(phases(runtime.calls), ['ready', 'up', 'ready', 'probe', 'ready', 'probe'],
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

// A Work whose repository never said how to start a program runs exactly as it did before this existed.
test('a Work with no runtime declaration never touches a runtime', t => {
  const opened = openTestWork(t, { prefix: 'probenone', workId: 'work-probe-none', config: { human_in_the_loop_default: false } });
  const runtime = fakeRuntime();
  const { dependencies } = scriptedProvider({ runtime: runtime.runtime });

  const state = advanceWork(opened.worktree, { runtime: 'claude', reviewPolicy: 'all' }, dependencies);

  assert.equal(state.lifecycle, 'complete');
  assert.deepEqual(runtime.calls, []);
});
