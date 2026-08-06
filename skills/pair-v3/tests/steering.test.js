// AC-6: `pair-loop interrupt` ends an in-flight attempt with outcome interrupted-by-human (no correction
// spent, never environment-failure); `pair-loop steer --text` reaches the warm session as a resumed turn;
// the next run continues that session.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { STEER_TEXT_LIMIT_BYTES, advanceWork, steerWarmSession } = require('../scripts/lib/pair-engine');
const { readEvents, readState, signalDispatch, signalDispatchChildren, withDispatchLease } = require('../scripts/lib/pair-store');
const { runProviderSession } = require('../scripts/lib/provider-runtime');
const { completedSlice, greenVerification, openTestWork } = require('./helpers/warm-work');

function interruptedError() {
  const error = new Error('claude implementation session was interrupted by a human');
  error.pair_invocation = {
    runtime: 'claude', mode: 'implementation', failure: 'interrupted-by-human',
    usage: { input_tokens: 40, cached_input_tokens: 900, output_tokens: 120, context_tokens: 5000 },
    duration_ms: 900, session_id: 'sess-interrupt', resumed: false,
  };
  error.pair_interrupted = true;
  return error;
}

test('a child killed by SIGINT is reported as a human interrupt, not a provider failure', () => {
  assert.throws(() => runProviderSession({
    runtime: 'claude', mode: 'implementation', root: '/repo', prompt: 'p',
    schemaPath: '/s', schema: { type: 'object' }, outputPath: '/o', model: 'claude-opus-5',
  }, { spawnSync: () => ({ status: null, signal: 'SIGINT', stdout: '', stderr: '' }) }), error => {
    assert.equal(error.pair_interrupted, true);
    assert.equal(error.pair_invocation.failure, 'interrupted-by-human');
    assert.doesNotMatch(error.message, /environment|infrastructure/iu,
      'an interrupt recorded as an environment failure spends the loop\'s patience on the human\'s own decision');
    return true;
  });
});

// The whole design of `interrupt` rests on this: the dispatch owner is the process that will journal the
// attempt as interrupted-by-human. Signal it too and there is nobody left to write any of that down,
// which is exactly the interrupt-recorded-as-infrastructure-failure being replaced. `stop` keeps the old
// whole-tree behavior, because ending the run is what it is for.
test('interrupt signals the provider alone; stop still ends the whole dispatch', t => {
  const opened = openTestWork(t, { prefix: 'signal', workId: 'work-signal' });
  withDispatchLease(opened.worktree, opened.workId, { command: 'test' }, () => {
    const interrupted = signalDispatchChildren(opened.worktree, opened.workId, 0);
    assert.ok(interrupted, 'the lease names the owning process');
    assert.ok(!interrupted.signalled.includes(process.pid),
      'the process that has to record the interrupt must survive it');

    const stopped = signalDispatch(opened.worktree, opened.workId, 0);
    assert.ok(stopped.signalled.includes(process.pid), 'stop still reaches the owner');
  });
});

test('an interrupted attempt spends no correction and leaves the Work ready to continue', t => {
  const opened = openTestWork(t, { prefix: 'interrupt', workId: 'work-interrupt' });
  const state = advanceWork(opened.worktree, { runtime: 'claude' }, {
    runProvider(input) {
      // The interrupt lands after the session has already edited the worktree, which is what makes the
      // dirty-tree gate the thing that would otherwise make continuing impossible.
      fs.writeFileSync(path.join(input.root, 'value.js'), 'module.exports = 2; // half done\n');
      throw interruptedError();
    },
    verify: greenVerification,
    hydrate: () => ({ hydrated: false }),
  });

  assert.equal(state.lifecycle, 'ready', 'stopping a run is not a block');
  assert.match(state.next_action, /steer or re-run S1/u, 'and the surface says what to do next');
  const projected = readState(opened.worktree, opened.workId).slices[0];
  assert.equal(projected.correction_count, 0, 'a human stopping the attempt does not spend the one correction');
  assert.notEqual(projected.status, 'blocked');

  const events = readEvents(opened.worktree, opened.workId);
  const recorded = events.findLast(event => event.event === 'provider-interrupted');
  assert.equal(recorded.failure, 'interrupted-by-human');
  assert.equal(recorded.session_id, 'sess-interrupt');
  assert.equal(recorded.output_tokens, 120, 'the tokens it did spend are still counted');
  assert.ok(events.some(event => event.event === 'attempt-interrupted' && event.review_slice_id === 'S1'));
});

test('steering reaches the session as a resumed turn and the next run continues it', t => {
  const opened = openTestWork(t, { prefix: 'steer', workId: 'work-steer' });
  const calls = [];
  const dependencies = {
    runProvider(input) {
      calls.push(input);
      if (calls.length === 1) {
        fs.writeFileSync(path.join(input.root, 'value.js'), 'module.exports = 2; // half done\n');
        throw interruptedError();
      }
      fs.writeFileSync(path.join(input.root, 'value.js'), 'module.exports = 2;\n');
      return {
        output: completedSlice(),
        usage: { input_tokens: 5, cached_input_tokens: 4000, output_tokens: 90, context_tokens: 6000 },
        duration_ms: 3, runtime: 'claude', model: 'test-model', effort: 'medium',
        session_id: 'sess-interrupt', resumed: Boolean(input.resumeSessionId),
      };
    },
    verify: greenVerification,
    hydrate: () => ({ hydrated: false }),
  };

  advanceWork(opened.worktree, { runtime: 'claude' }, dependencies);
  assert.equal(readState(opened.worktree, opened.workId).slices[0].warm_session, undefined,
    'a failed attempt records no session to resume');

  // The session the interrupted attempt ran under is what steering has to reach, so put one on the slice
  // the way a completed first call would have.
  const state = readState(opened.worktree, opened.workId);
  state.slices[0].warm_session = { session_id: 'sess-interrupt', runtime: 'claude', model: 'test-model', context_tokens: 5000, calls: 1 };
  require('../scripts/lib/pair-store').writeState(opened.worktree, opened.workId, state);

  const steered = steerWarmSession(opened.worktree, { runtime: 'claude', text: 'Keep the change inside value.js.\n\nDo not touch the callers.' }, dependencies);
  assert.equal(steered.warm_session, true);
  assert.equal(steered.dispatched, true, 'a steer at ready is a turn, not a note nobody reads');

  const resumed = calls.at(-1);
  assert.equal(resumed.resumeSessionId, 'sess-interrupt', 'the next run continues that same session');
  assert.match(resumed.prompt, /Keep the change inside value\.js\./u);
  assert.match(resumed.prompt, /Do not touch the callers\./u);
  // Not reflowed: a person writing paragraphs is not writing a single model-facing claim.
  assert.match(resumed.prompt, /value\.js\.\n\nDo not touch/u);

  const events = readEvents(opened.worktree, opened.workId);
  assert.ok(events.some(event => event.event === 'steering-recorded' && event.warm_session === true));
  assert.ok(events.some(event => event.event === 'steering-delivered'));
  assert.equal(readState(opened.worktree, opened.workId).slices[0].steering_ref, undefined,
    'steering is spent by the attempt that carried it, as a Correction Direction is');
});

test('steering is bounded by what a person types, not by the caps that bound model output', t => {
  const opened = openTestWork(t, { prefix: 'steerbound', workId: 'work-steer-bound' });
  const dependencies = { runProvider() { throw new Error('no session may run for a bounds check'); } };

  // Comfortably past the 1000-character cap that bounds a Correction Direction, and accepted.
  const long = 'x'.repeat(4000);
  const steered = steerWarmSession(opened.worktree, { text: long, dispatch: false }, dependencies);
  assert.equal(steered.dispatched, false);
  assert.equal(readState(opened.worktree, opened.workId).slices[0].steering_bytes, 4000);

  assert.throws(() => steerWarmSession(opened.worktree, { text: 'y'.repeat(STEER_TEXT_LIMIT_BYTES + 1), dispatch: false }, dependencies),
    new RegExp(`bounded at ${STEER_TEXT_LIMIT_BYTES} bytes`, 'u'));
  assert.throws(() => steerWarmSession(opened.worktree, { text: '   ' }, dependencies), /requires --text/u);
});

test('steering a Work that is waiting on a human records without dispatching', t => {
  const opened = openTestWork(t, { prefix: 'steerwait', workId: 'work-steer-wait' });
  const state = readState(opened.worktree, opened.workId);
  state.lifecycle = 'awaiting-human';
  require('../scripts/lib/pair-store').writeState(opened.worktree, opened.workId, state);

  const steered = steerWarmSession(opened.worktree, { text: 'look at the retry path' }, {
    runProvider() { throw new Error('no session may run while the loop waits for a human'); },
  });
  assert.equal(steered.dispatched, false, 'steering must not jump the gate that is waiting for the human');
  assert.ok(readState(opened.worktree, opened.workId).slices[0].steering_ref, 'and the text still waits for the next attempt');
});
