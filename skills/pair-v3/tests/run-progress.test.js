// A chained run waits minutes per action and prints its result only at the end, so a working run and a
// wedged one looked the same from outside. Observed live, verbatim: "it hangs at the first state".
//
// AC-1: a run reports every long wait as it starts and ends — provider call and verification alike.
// AC-2: each transition says where the loop landed and how many actions it has spent.
// AC-3: a reporter that throws never costs the run the action it already spent.
// AC-4: the rendered lines name the slice, the phase, and what it cost; --quiet installs no reporter.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { advanceWork } = require('../scripts/lib/pair-engine');
const { workPaths } = require('../scripts/lib/pair-store');
const { progressLine, runDependencies } = require('../scripts/pair-cli');
const { completedSlice, greenVerification, openTestWork, providerResult } = require('./helpers/warm-work');

function autonomousRun(t, prefix, workId, { onProgress, reviewOutput } = {}) {
  const opened = openTestWork(t, { prefix, workId, config: { human_in_the_loop_default: false } });
  return autonomousRunWith(t, opened, { onProgress }, reviewOutput);
}

function autonomousRunWith(t, opened, { onProgress }, reviewOutput = { verdict: 'approve', findings: [] }) {
  let calls = 0;
  const dependencies = {
    onProgress,
    runProvider(input) {
      calls += 1;
      if (input.schema?.properties?.verdict) return providerResult(reviewOutput, { session_id: 'review-sess' });
      fs.writeFileSync(path.join(input.root, 'value.js'), 'module.exports = 2;\n');
      return providerResult(completedSlice(), { session_id: 'impl-sess', duration_ms: 61000 });
    },
    verify: greenVerification,
    hydrate: () => ({ hydrated: false }),
  };
  const state = advanceWork(opened.worktree, { runtime: 'claude', reviewPolicy: 'all' }, dependencies);
  return { opened, state, calls };
}

test('a run narrates every wait it makes the human sit through', t => {
  const events = [];
  const { state } = autonomousRun(t, 'progress', 'work-progress', { onProgress: event => events.push(event) });

  assert.equal(state.lifecycle, 'complete');
  assert.deepEqual(events.map(event => event.phase), [
    'provider-started',
    'provider-finished',
    'verification-started',
    'verification-finished',
    'transition',
    'provider-started',
    'provider-finished',
    // The review accepted the last slice, so the cumulative gate runs inside that same action — the
    // longest wait of the Work, and the one that comes after the last model call has already finished.
    // Its transition is reported once the action lands, which is why it follows rather than precedes.
    'verification-started',
    'verification-finished',
    'transition',
  ]);
  assert.ok(events.every(event => event.at), 'every event is stamped, because the elapsed time is the point');
  assert.equal(events[0].kind, 'implementation');
  assert.equal(events[5].kind, 'review');
});

test('each transition says where the loop landed and what it has spent', t => {
  const events = [];
  autonomousRun(t, 'progresstrans', 'work-progress-trans', { onProgress: event => events.push(event) });
  const transitions = events.filter(event => event.phase === 'transition');

  assert.deepEqual(transitions.map(event => event.actions), [1, 2]);
  assert.equal(transitions[0].review_slice_id, 'S1');
  assert.equal(transitions[0].status, 'review-ready');
  assert.equal(transitions[0].human_in_the_loop, false);
  assert.ok(transitions[0].action_cap >= 2);
  assert.equal(transitions[1].review_slice_id, null, 'the slice was accepted, so nothing is in flight');
});

test('a progress reporter that throws does not cost the run its action', t => {
  const { state, calls } = autonomousRun(t, 'progressthrow', 'work-progress-throw', {
    onProgress() { throw new Error('the sink is broken'); },
  });

  assert.equal(state.lifecycle, 'complete');
  assert.equal(calls, 2, 'both actions ran');
});

test('the rendered lines name the slice, the phase, and the cost', () => {
  const at = '2026-08-07T12:31:02.000Z';

  assert.match(progressLine({ at, phase: 'provider-started', review_slice_id: 'S-05', kind: 'implementation', runtime: 'claude', model: 'opus-5', warm: true }),
    /S-05 implementation started — claude\/opus-5, warm session$/u);
  assert.match(progressLine({ at, phase: 'provider-finished', review_slice_id: 'S-05', kind: 'implementation', duration_ms: 665402, output_tokens: 40395, context_tokens: 160851, cost_usd: 5.84 }),
    /S-05 implementation finished — 11m05s, 40\.4k out, 160\.9k ctx, \$5\.84$/u);
  assert.match(progressLine({ at, phase: 'verification-finished', review_slice_id: 'S-05', status: 1, observed_status: 1, duration_ms: 197000 }),
    /S-05 verification FAILED \(exit 1\) — 3m17s$/u);
  assert.match(progressLine({ at, phase: 'transition', actions: 3, action_cap: 40, lifecycle: 'ready', review_slice_id: 'S-10', status: 'queued', human_in_the_loop: true }),
    /action 3\/40 → ready, S-10 queued \(hitl — the loop stops here\)$/u);
  assert.match(progressLine({ at, phase: 'run-capped', actions: 40, next_action: 'run Review Slice S-09' }),
    /cap reached after 40; run again to continue: run Review Slice S-09$/u);
});

// The answer to "where do i suppose to see these progress", asked by a human whose driver collects the run's
// output and renders it only when the process exits. stderr serves a terminal; the log file serves everyone
// else, so it is written even when stderr is silenced.
test('progress is written to the Work log even when stderr is silenced', t => {
  const opened = openTestWork(t, { prefix: 'proglog', workId: 'work-progress-log', config: { human_in_the_loop_default: false } });
  const quiet = runDependencies(opened.worktree, { quiet: true, workId: opened.workId });
  const errors = [];
  const originalError = console.error;
  console.error = line => errors.push(line);
  try {
    autonomousRunWith(t, opened, quiet);
  } finally {
    console.error = originalError;
  }

  const log = fs.readFileSync(workPaths(opened.worktree, opened.workId).progressLog, 'utf8');
  assert.deepEqual(errors, [], '--quiet keeps stderr clean');
  assert.match(log, /S1 implementation started/u);
  assert.match(log, /S1 verification clean/u);
  assert.match(log, /action 2\/40 → complete/u);
});

test('a run with no reporter installed still narrates to stderr by default', () => {
  const dependencies = runDependencies(null, {});
  assert.equal(typeof dependencies.onProgress, 'function');
});
