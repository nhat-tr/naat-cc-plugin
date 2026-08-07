// The loop drives itself unless a human asked to stand in it.
//
// AC-1: `human_in_the_loop_default` ships as false, so an unmarked Review Slice is autonomous.
// AC-2: one `run` carries an unmarked slice from implementation through review to acceptance.
// AC-3: an autonomous slice adjudicates its own model findings as valid, spends the one bounded correction,
//       and re-reviews the corrected checkpoint.
// AC-4: a second round of valid findings still blocks for a human, so the autonomous loop terminates.
// AC-5: a slice marked hitl keeps exactly today's gates — one model action per run, and the human gate holds.
// AC-6: the chain stops before the first action of a hitl slice.
// AC-7: an interrupted attempt is never re-dispatched by the chain.
// AC-8: the per-run action cap bounds what one run may spend.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  acceptHumanReview,
  adjudicateFinding,
  advanceWork,
  dispatchNextSlice,
  humanLoopReport,
  setHumanLoop,
  unblockWork,
} = require('../scripts/lib/pair-engine');
const { blobAtCommit, readState } = require('../scripts/lib/pair-store');
const { humanLoopSettings } = require('../scripts/lib/human-loop');
const { feedbackForFinding, listReviewOutcomes } = require('../scripts/lib/review-evidence');
const { completedSlice, greenVerification, openTestWork, providerResult, withPairConfig } = require('./helpers/warm-work');

const APPROVE = { verdict: 'approve', findings: [] };

const TWO_SLICE_SPEC = '# Spec\n\n## Acceptance Criteria\n\n- [ ] AC-1: value becomes two\n- [ ] AC-2: value becomes three\n';

function twoSlices({ secondHitl = false } = {}) {
  return [
    { id: 'S1', acceptance_criteria: ['AC-1'], outcome: 'Existing value returns two.', depends_on: [], verify: 'node verify.js' },
    {
      id: 'S2',
      acceptance_criteria: ['AC-2'],
      outcome: 'Existing value returns three.',
      depends_on: ['S1'],
      verify: 'node verify.js',
      ...(secondHitl ? { hitl: true } : {}),
    },
  ];
}

// A review call is the one that carries the review schema; post-diff design also runs in review mode but
// answers with the implementation schema, so the schema is what tells them apart.
function isReviewCall(input) {
  return Boolean(input.schema?.properties?.verdict);
}

// One finding anchored the way a real one must be — the exact commit, path, blob and line of the checkpoint
// the review is about. Read at call time because every correction moves the checkpoint.
function findingAgainstCurrentCheckpoint(worktree, workId) {
  const checkpoint = readState(worktree, workId).slices.find(slice => slice.checkpoint_commit)?.checkpoint_commit;
  return {
    verdict: 'findings',
    findings: [{
      severity: 'MAJOR',
      claim: 'The exported value is not covered by the declared verification.',
      scenario: 'A caller reading value.js observes the old value under the verify command.',
      impact: 'The slice can be accepted with the behavior unproven.',
      pass_condition: 'The verification command fails when the export returns 1.',
      evidence: {
        commit: checkpoint,
        path: 'value.js',
        blob: blobAtCommit(worktree, checkpoint, 'value.js'),
        line_start: 1,
        line_end: 1,
      },
    }],
  };
}

// `reviews` is consumed one entry per review call; a function entry is evaluated at call time, and the queue
// falls back to approval once it runs dry.
function scriptedProvider(opened, { reviews = [], interruptAt = null } = {}) {
  const queue = [...reviews];
  const calls = [];
  const dependencies = {
    runProvider(input) {
      calls.push(input);
      if (interruptAt === calls.length) {
        const error = new Error('interrupted by human');
        error.pair_interrupted = true;
        throw error;
      }
      if (isReviewCall(input)) {
        const next = queue.shift() ?? APPROVE;
        const output = typeof next === 'function' ? next() : next;
        return providerResult(output, { session_id: 'review-sess' });
      }
      fs.writeFileSync(path.join(input.root, 'value.js'), `module.exports = ${calls.length + 1};\n`);
      return providerResult(completedSlice(), { session_id: 'impl-sess', resumed: Boolean(input.resumeSessionId) });
    },
    verify: greenVerification,
    hydrate: () => ({ hydrated: false }),
  };
  return { calls, dependencies };
}

function kinds(calls) {
  return calls.map(input => (isReviewCall(input) ? 'review' : 'implementation'));
}

// The shipped default decides how every Work opened from now on behaves, so it is asserted on the settings
// themselves rather than inferred from a fixture that writes its own preferences.
test('human in the loop is opt-in, so an unconfigured Pair drives itself', t => {
  withPairConfig(t, {});

  const settings = humanLoopSettings(process.env);

  assert.equal(settings.humanInTheLoopByDefault, false);
  assert.ok(settings.actionsPerRun >= 2, 'a run that may only take one action would still hand the loop back every time');
});

test('one run carries an unmarked Review Slice from implementation to acceptance', t => {
  const opened = openTestWork(t, { prefix: 'autorun', workId: 'work-auto-run', config: { human_in_the_loop_default: false } });
  const { calls, dependencies } = scriptedProvider(opened, { reviews: [APPROVE] });

  const state = advanceWork(opened.worktree, { runtime: 'claude', reviewPolicy: 'all' }, dependencies);

  assert.deepEqual(kinds(calls), ['implementation', 'review'], 'the review followed the checkpoint without being asked for');
  assert.equal(state.lifecycle, 'complete');
  assert.equal(readState(opened.worktree, opened.workId).slices[0].status, 'accepted');
  assert.equal(state.pair_autonomous_actions, 2, 'and the run says how many actions it took');
});

test('an autonomous slice adjudicates its own findings and re-reviews the correction', t => {
  const opened = openTestWork(t, { prefix: 'autofix', workId: 'work-auto-fix', config: { human_in_the_loop_default: false } });
  const { calls, dependencies } = scriptedProvider(opened, {
    reviews: [() => findingAgainstCurrentCheckpoint(opened.worktree, opened.workId), APPROVE],
  });

  const state = advanceWork(opened.worktree, { runtime: 'claude', reviewPolicy: 'all' }, dependencies);

  assert.deepEqual(kinds(calls), ['implementation', 'review', 'implementation', 'review'],
    'the finding was taken at face value, corrected, and the corrected checkpoint reviewed again');
  assert.equal(calls[2].resumeSessionId, 'impl-sess', 'the correction went into the warm session carrying the slice');
  assert.equal(state.lifecycle, 'complete');

  const outcome = listReviewOutcomes(opened.worktree, opened.workId).find(item => item.findings.length > 0);
  const feedback = feedbackForFinding(opened.worktree, opened.workId, outcome.findings[0].finding_id);
  assert.equal(feedback[0].disposition, 'valid');
  assert.equal(feedback[0].adjudicator, 'autonomous', 'the record says a machine gave this verdict, not a person');
});

test('a second round of valid findings blocks for a human', t => {
  const opened = openTestWork(t, { prefix: 'autoblock', workId: 'work-auto-block', config: { human_in_the_loop_default: false } });
  const { calls, dependencies } = scriptedProvider(opened, {
    reviews: [
      () => findingAgainstCurrentCheckpoint(opened.worktree, opened.workId),
      () => findingAgainstCurrentCheckpoint(opened.worktree, opened.workId),
    ],
  });

  const state = advanceWork(opened.worktree, { runtime: 'claude', reviewPolicy: 'all' }, dependencies);

  assert.deepEqual(kinds(calls), ['implementation', 'review', 'implementation', 'review']);
  assert.equal(state.lifecycle, 'blocked', 'the one bounded correction still bounds the model loop');
  assert.match(state.blocked_reason, /exhausted its one correction/u);
});

// The block is real and correct — the model loop exhausted its one correction — but a human finding earns a
// round and the Work leaves the block. What must not survive that is the reason: read live as current
// thirty minutes after it was resolved, in a progress line narrating a healthy transition.
test('a reason for a block does not outlive the block', t => {
  const opened = openTestWork(t, { prefix: 'blockstale', workId: 'work-block-stale', config: { human_in_the_loop_default: false } });
  const { dependencies } = scriptedProvider(opened, {
    reviews: [
      () => findingAgainstCurrentCheckpoint(opened.worktree, opened.workId),
      () => findingAgainstCurrentCheckpoint(opened.worktree, opened.workId),
    ],
  });
  advanceWork(opened.worktree, { runtime: 'claude', reviewPolicy: 'all' }, dependencies);
  assert.equal(readState(opened.worktree, opened.workId).lifecycle, 'blocked', 'the model loop is bounded, as designed');
  assert.match(readState(opened.worktree, opened.workId).blocked_reason, /exhausted its one correction/u);

  const unblocked = unblockWork(opened.worktree, { workId: opened.workId, reason: 'a human read the checkpoint and grants the round' });

  assert.equal(unblocked.lifecycle, 'ready');
  assert.equal(readState(opened.worktree, opened.workId).blocked_reason, null, 'nothing later can read it as current');
});

test('a Review Slice marked hitl keeps its human gate', t => {
  const opened = openTestWork(t, {
    prefix: 'hitlgate',
    workId: 'work-hitl-gate',
    slices: [{ id: 'S1', acceptance_criteria: ['AC-1'], outcome: 'Existing value returns two.', depends_on: [], verify: 'node verify.js', hitl: true }],
    config: { human_in_the_loop_default: false },
  });
  const { calls, dependencies } = scriptedProvider(opened, {
    reviews: [() => findingAgainstCurrentCheckpoint(opened.worktree, opened.workId)],
  });

  const afterImplementation = advanceWork(opened.worktree, { runtime: 'claude', reviewPolicy: 'all' }, dependencies);
  assert.deepEqual(kinds(calls), ['implementation'], 'a slice a human is reading takes one action per run');
  assert.equal(readState(opened.worktree, opened.workId).slices[0].status, 'review-ready');
  assert.equal(afterImplementation.lifecycle, 'ready');

  const afterReview = advanceWork(opened.worktree, { runtime: 'claude', reviewPolicy: 'all' }, dependencies);
  assert.equal(afterReview.lifecycle, 'awaiting-human', 'the findings wait for the person who asked to see them');
  assert.equal(readState(opened.worktree, opened.workId).slices[0].status, 'awaiting-feedback');
});

test('the chain stops before the first action of a hitl slice', t => {
  const opened = openTestWork(t, {
    prefix: 'hitlnext',
    workId: 'work-hitl-next',
    slices: twoSlices({ secondHitl: true }),
    specMarkdown: TWO_SLICE_SPEC,
    config: { human_in_the_loop_default: false },
  });
  const { calls, dependencies } = scriptedProvider(opened, { reviews: [APPROVE] });

  const state = advanceWork(opened.worktree, { runtime: 'claude', reviewPolicy: 'all' }, dependencies);

  assert.deepEqual(kinds(calls), ['implementation', 'review'], 'S1 ran to acceptance and S2 was not started');
  assert.equal(state.lifecycle, 'ready');
  assert.match(state.next_action, /run Review Slice S2/u);
  assert.equal(readState(opened.worktree, opened.workId).slices[1].status, 'queued');

  const report = humanLoopReport(opened.worktree, { workId: opened.workId });
  assert.equal(report.default_human_in_the_loop, false);
  assert.deepEqual(report.slices.map(slice => [slice.id, slice.human_in_the_loop]), [['S1', false], ['S2', true]]);
});

test('marking a slice hitl mid-Work holds the loop at its next gate', t => {
  const opened = openTestWork(t, {
    prefix: 'hitlmark',
    workId: 'work-hitl-mark',
    slices: twoSlices(),
    specMarkdown: TWO_SLICE_SPEC,
    config: { human_in_the_loop_default: false },
  });
  const { calls, dependencies } = scriptedProvider(opened, { reviews: [APPROVE, APPROVE] });

  setHumanLoop(opened.worktree, { workId: opened.workId, sliceId: 'S2', humanLoop: true });
  advanceWork(opened.worktree, { runtime: 'claude', reviewPolicy: 'all' }, dependencies);

  assert.deepEqual(kinds(calls), ['implementation', 'review']);
  assert.equal(readState(opened.worktree, opened.workId).slices[1].hitl, true);
});

// Observed live: an accept left an autonomous Work idle at `run Review Slice S-05` with nothing scheduled
// to start it, which is indistinguishable from the loop having hung.
test('accepting a checkpoint hands the Work to the next Review Slice', t => {
  const opened = openTestWork(t, {
    prefix: 'accepthand',
    workId: 'work-accept-hand',
    slices: [{ ...twoSlices()[0], hitl: true }, twoSlices()[1]],
    specMarkdown: TWO_SLICE_SPEC,
    config: { human_in_the_loop_default: false },
  });
  const { calls, dependencies } = scriptedProvider(opened, {
    reviews: [() => findingAgainstCurrentCheckpoint(opened.worktree, opened.workId), APPROVE],
  });

  advanceWork(opened.worktree, { runtime: 'claude', reviewPolicy: 'all' }, dependencies);
  advanceWork(opened.worktree, { runtime: 'claude', reviewPolicy: 'all' }, dependencies);
  const outcome = listReviewOutcomes(opened.worktree, opened.workId).find(item => item.findings.length > 0);
  adjudicateFinding(opened.worktree, {
    findingId: outcome.findings[0].finding_id,
    disposition: 'false-positive',
    reason: 'the declared verification does cover the exported value',
  });
  assert.equal(readState(opened.worktree, opened.workId).slices[0].status, 'awaiting-human-review');

  acceptHumanReview(opened.worktree, { sliceId: 'S1' });
  const dispatched = dispatchNextSlice(opened.worktree, { runtime: 'claude', reviewPolicy: 'all' }, dependencies);

  assert.equal(dispatched.dispatched, true);
  assert.equal(dispatched.review_slice_id, 'S2');
  // Both slices touch value.js, so accepting the second one earns the combined-diff review — which the
  // chain also runs, carrying the Work to complete on the strength of one acceptance.
  assert.deepEqual(kinds(calls), ['implementation', 'review', 'implementation', 'review', 'review'],
    'the acceptance started S2 and carried it to acceptance without a further gesture');
  assert.equal(dispatched.state.lifecycle, 'complete');
});

test('accepting stops at the next Review Slice when a human marked it', t => {
  const opened = openTestWork(t, {
    prefix: 'accepthold',
    workId: 'work-accept-hold',
    slices: twoSlices({ secondHitl: true }),
    specMarkdown: TWO_SLICE_SPEC,
    config: { human_in_the_loop_default: false },
  });
  const { calls, dependencies } = scriptedProvider(opened, { reviews: [APPROVE] });

  advanceWork(opened.worktree, { runtime: 'claude', reviewPolicy: 'all' }, dependencies);
  const dispatched = dispatchNextSlice(opened.worktree, { runtime: 'claude', reviewPolicy: 'all' }, dependencies);

  assert.equal(dispatched.dispatched, false, 'the mark on S2 is the request to be asked first');
  assert.deepEqual(kinds(calls), ['implementation', 'review']);
});

test('an interrupted attempt is not re-dispatched by the chain', t => {
  const opened = openTestWork(t, { prefix: 'autostop', workId: 'work-auto-stop', config: { human_in_the_loop_default: false } });
  const { calls, dependencies } = scriptedProvider(opened, { interruptAt: 2 });

  const state = advanceWork(opened.worktree, { runtime: 'claude', reviewPolicy: 'all' }, dependencies);

  assert.equal(calls.length, 2, 'the interrupted review was the last thing this run did');
  assert.equal(state.pair_transition, 'interrupted');
  assert.equal(state.lifecycle, 'ready', 'an interrupt is a human decision, so it neither blocks the Work nor cycles it');
});

test('the per-run action cap bounds one run', t => {
  const opened = openTestWork(t, {
    prefix: 'autocap',
    workId: 'work-auto-cap',
    config: { human_in_the_loop_default: false, autonomous_actions_per_run: 1 },
  });
  const { calls, dependencies } = scriptedProvider(opened, { reviews: [APPROVE] });

  const state = advanceWork(opened.worktree, { runtime: 'claude', reviewPolicy: 'all' }, dependencies);

  assert.deepEqual(kinds(calls), ['implementation']);
  assert.equal(state.pair_autonomous_stopped, 'action-cap');
  assert.equal(readState(opened.worktree, opened.workId).slices[0].status, 'review-ready');
});
