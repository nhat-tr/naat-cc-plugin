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
  verifyActiveSlice,
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

// The same anchoring rule one step out. A combined-diff review judges the whole Work, so its evidence must
// name the Work's head rather than any one slice's checkpoint — the two differ the moment a second slice
// commits, which is exactly when a combined review is earned.
function combinedFindingAgainstHead(worktree, workId) {
  const head = readState(worktree, workId).head_commit;
  return {
    verdict: 'findings',
    findings: [{
      severity: 'MAJOR',
      claim: 'The combined diff leaves the exported value unproven.',
      scenario: 'Both slices land, and no declared verification observes the composed export.',
      impact: 'The Work can complete with the composed behavior untested.',
      pass_condition: 'A verification observes the export produced by both slices together.',
      evidence: {
        commit: head,
        path: 'value.js',
        blob: blobAtCommit(worktree, head, 'value.js'),
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

// Asked live: "pair-loop is the only agent touching the code — if verification fails, it must fix it, right?"
// It must, and it must first find out whether there is anything to fix: Pair's own instruction is to re-run
// verification before treating a red gate as a defect, and only a human ever followed it. A flake that clears
// on the second run costs a suite, not a correction — and not a block.
test('a red gate is re-verified before it is treated as a defect', t => {
  const opened = openTestWork(t, { prefix: 'gateflake', workId: 'work-gate-flake', config: { human_in_the_loop_default: false } });
  const verifications = [];
  const { calls, dependencies } = scriptedProvider(opened, { reviews: [APPROVE] });
  // Red once, then clean: the shape of a flake, a busy port, or a container that was not up yet.
  dependencies.verify = () => {
    verifications.push('run');
    return verifications.length === 1
      ? { status: 1, duration_ms: 3, log_digest: 'b'.repeat(64), failing_tests: ['Suite.OneTest'], introduced_failing_tests: ['Suite.OneTest'] }
      : greenVerification();
  };

  const state = advanceWork(opened.worktree, { runtime: 'claude', reviewPolicy: 'all' }, dependencies);

  assert.equal(verifications.length, 3, 'the red run, its free re-run, and the cumulative gate');
  assert.deepEqual(kinds(calls), ['implementation', 'review'], 'no correction was spent on a failure that was not real');
  assert.equal(state.lifecycle, 'complete');
});

// The bound is progress, not permission. While each attempt changes which tests fail the loop keeps working the
// problem; an attempt that leaves the identical set failing has stopped moving, and that is the honest moment
// to stop rather than after a fixed count.
test('a red gate that stops making progress blocks, and one that keeps moving does not', t => {
  const opened = openTestWork(t, { prefix: 'gatestall', workId: 'work-gate-stall', config: { human_in_the_loop_default: false } });
  const { calls, dependencies } = scriptedProvider(opened, { reviews: [APPROVE] });
  // Always the same failing test: the second attempt has changed nothing the suite can see.
  dependencies.verify = () => ({
    status: 1,
    duration_ms: 3,
    log_digest: 'c'.repeat(64),
    failing_tests: ['Suite.StubbornTest'],
    introduced_failing_tests: ['Suite.StubbornTest'],
  });

  const state = advanceWork(opened.worktree, { runtime: 'claude', reviewPolicy: 'all' }, dependencies);

  assert.deepEqual(kinds(calls), ['implementation', 'implementation'],
    'one correction was spent on the real failure, and the second attempt earned no third');
  assert.equal(state.lifecycle, 'blocked');
  assert.match(state.blocked_reason, /stopped making progress/u);
});

// Observed live, forty minutes of it: the loop blocked a slice on a red gate, the human re-verified by hand,
// the suite came back clean after 3m19s — and the block outlived the evidence that refuted it. A block made of
// a failing gate is unmade by a passing one; that is the same evidence read again, not an override.
test('a clean re-verification clears a block its own red gate created', t => {
  const opened = openTestWork(t, { prefix: 'gateclear', workId: 'work-gate-clear', config: { human_in_the_loop_default: false } });
  const { dependencies } = scriptedProvider(opened, { reviews: [APPROVE] });
  let red = true;
  dependencies.verify = () => (red
    ? { status: 1, duration_ms: 3, log_digest: 'd'.repeat(64), failing_tests: ['Suite.Stubborn'], introduced_failing_tests: ['Suite.Stubborn'] }
    : greenVerification());
  advanceWork(opened.worktree, { runtime: 'claude', reviewPolicy: 'all' }, dependencies);
  assert.equal(readState(opened.worktree, opened.workId).lifecycle, 'blocked');

  // What a human does next, and what the loop already believes is the right first move.
  red = false;
  const { report, state } = verifyActiveSlice(opened.worktree, { workId: opened.workId, sliceId: 'S1' }, dependencies);

  assert.equal(report.status, 0);
  assert.equal(report.checkpoint_created, true, 'the work in the tree became a checkpoint, as it would have on a green gate');
  assert.notEqual(state.lifecycle, 'blocked', 'and the block is gone with the failure that made it');
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

// The one block no Review Slice can clear. A combined-diff finding is raised against the whole Work, so it
// matches no slice, no correcting session is dispatched, and the state says "human correction required" and
// means it. Observed live: nothing committed that human's correction, so head_commit never moved, the next
// combined review re-read the identical commit and raised the identical finding, and the Work could not be
// finished at all — the only escape was calling a valid finding false.
test('a human correction after a combined-diff finding is committed so the next review can see it', t => {
  const opened = openTestWork(t, {
    prefix: 'combinedfix',
    workId: 'work-combined-fix',
    slices: twoSlices(),
    specMarkdown: TWO_SLICE_SPEC,
    config: { human_in_the_loop_default: false },
  });
  const { dependencies } = scriptedProvider(opened, {
    reviews: [APPROVE, APPROVE, () => combinedFindingAgainstHead(opened.worktree, opened.workId)],
  });

  advanceWork(opened.worktree, { runtime: 'claude', reviewPolicy: 'all' }, dependencies);
  assert.equal(readState(opened.worktree, opened.workId).lifecycle, 'awaiting-human',
    'both slices are accepted and the combined review found something');

  const combined = listReviewOutcomes(opened.worktree, opened.workId)
    .find(item => item.review_slice_id === 'work-completion');
  adjudicateFinding(opened.worktree, {
    findingId: combined.findings[0].finding_id,
    disposition: 'valid',
    reason: 'the combined diff does leave the exported value unproven',
  });
  const blockedState = readState(opened.worktree, opened.workId);
  assert.equal(blockedState.lifecycle, 'blocked');

  // The correction a combined-diff finding asks for: a person edits the worktree, because no slice owns it.
  fs.writeFileSync(path.join(opened.worktree, 'value.js'), 'module.exports = 99;\n');

  const state = unblockWork(opened.worktree, { reason: 'corrected the export by hand' });

  assert.notEqual(state.head_commit, blockedState.head_commit,
    'the human correction is a commit, so the review that reads commits can see it');
  assert.equal(blobAtCommit(opened.worktree, state.head_commit, 'value.js'),
    blobAtCommit(opened.worktree, 'HEAD', 'value.js'),
    'and head_commit names the commit the worktree actually produced');
  assert.match(state.next_action, /cumulative deterministic verification/u);
});

// The other half: unblocking without touching anything must not invent a commit, and must say plainly that
// the review will raise the same finding again — silence there is what made the loop above look like a bug
// in the review rather than a missing gesture.
test('unblocking a combined-diff finding without a correction commits nothing and says so', t => {
  const opened = openTestWork(t, {
    prefix: 'combinednofix',
    workId: 'work-combined-nofix',
    slices: twoSlices(),
    specMarkdown: TWO_SLICE_SPEC,
    config: { human_in_the_loop_default: false },
  });
  const { dependencies } = scriptedProvider(opened, {
    reviews: [APPROVE, APPROVE, () => combinedFindingAgainstHead(opened.worktree, opened.workId)],
  });

  advanceWork(opened.worktree, { runtime: 'claude', reviewPolicy: 'all' }, dependencies);
  const combined = listReviewOutcomes(opened.worktree, opened.workId)
    .find(item => item.review_slice_id === 'work-completion');
  adjudicateFinding(opened.worktree, {
    findingId: combined.findings[0].finding_id,
    disposition: 'valid',
    reason: 'the combined diff does leave the exported value unproven',
  });
  const blockedState = readState(opened.worktree, opened.workId);

  const state = unblockWork(opened.worktree, { reason: 'looking again before correcting' });

  assert.equal(state.head_commit, blockedState.head_commit, 'nothing changed, so nothing is committed');
  assert.match(state.next_action, /the worktree is unchanged/u,
    'and the surface says why the same finding is about to come back');
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
