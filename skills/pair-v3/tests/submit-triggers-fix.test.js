// AC-7: with dispatch_correction_on_submit enabled (default), closing adjudication with a valid finding
// or `finding --submit` immediately dispatches the correction; disabled restores manual run.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  adjudicateFinding,
  advanceWork,
  dispatchCorrectionOnSubmit,
  recordHumanFinding,
  submitHumanFindings,
} = require('../scripts/lib/pair-engine');
const { blobAtCommit, readState } = require('../scripts/lib/pair-store');
const { listReviewOutcomes } = require('../scripts/lib/review-evidence');
const { completedSlice, greenVerification, openTestWork } = require('./helpers/warm-work');

// Anchored the way a real finding must be: the exact commit, path, blob and line range of the immutable
// checkpoint it is a claim about.
function modelFinding(worktree, checkpoint) {
  return {
    severity: 'MAJOR',
    claim: 'The new export is not covered by the declared verification.',
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
  };
}

// Drives a slice to a green checkpoint that is then reviewed, and returns everything the test needs to
// adjudicate what the review found.
function reviewedSlice(t, { prefix, workId, config = {} }) {
  const opened = openTestWork(t, { prefix, workId, config });
  const calls = [];
  const dependencies = {
    runProvider(input) {
      calls.push(input);
      if (input.mode === 'review') {
        const checkpoint = readState(opened.worktree, workId).slices[0].checkpoint_commit;
        return {
          output: { verdict: 'findings', findings: [modelFinding(opened.worktree, checkpoint)] },
          usage: {}, duration_ms: 1, runtime: 'claude', model: 'test-model', effort: 'medium', session_id: 'review-sess',
        };
      }
      fs.writeFileSync(path.join(input.root, 'value.js'), `module.exports = ${calls.length + 1};\n`);
      return {
        output: completedSlice(),
        usage: { context_tokens: 900 }, duration_ms: 1, runtime: 'claude', model: 'test-model', effort: 'medium',
        session_id: 'impl-sess', resumed: Boolean(input.resumeSessionId),
      };
    },
    verify: greenVerification,
    hydrate: () => ({ hydrated: false }),
  };
  advanceWork(opened.worktree, { runtime: 'claude', reviewPolicy: 'all' }, dependencies);
  advanceWork(opened.worktree, { runtime: 'claude', reviewPolicy: 'all' }, dependencies);
  return { opened, calls, dependencies };
}

// The observed expectation, verbatim: "after submitting … coding agent fix my issue immediately". The
// submit IS the human input; asking for a second gesture to confirm it is where the review round's
// thirty-to-fifty-five minutes went.
test('closing adjudication on a valid finding dispatches the correction in the same breath', t => {
  const { opened, calls, dependencies } = reviewedSlice(t, { prefix: 'submitfix', workId: 'work-submit-fix' });
  const before = calls.length;
  const outcome = listReviewOutcomes(opened.worktree, opened.workId).at(-1);

  adjudicateFinding(opened.worktree, {
    findingId: outcome.findings[0].finding_id,
    disposition: 'valid',
    reason: 'the verification does not cover the exported value',
  });
  assert.equal(calls.length, before, 'recording the verdict is bookkeeping and spends nothing on its own');

  // What the CLI does next, in the same breath as the gesture.
  const dispatched = dispatchCorrectionOnSubmit(opened.worktree, { runtime: 'claude' }, dependencies);
  assert.equal(dispatched.dispatched, true);
  assert.equal(calls.length, before + 1, 'the correction ran without a second human gesture');
  assert.equal(calls.at(-1).resumeSessionId, 'impl-sess', 'and it went into the warm session, not a new one');
});

test('disabling the flag restores today explicit run', t => {
  const { opened, calls, dependencies } = reviewedSlice(t, {
    prefix: 'submitmanual',
    workId: 'work-submit-manual',
    config: { dispatch_correction_on_submit: false },
  });
  const before = calls.length;
  const outcome = listReviewOutcomes(opened.worktree, opened.workId).at(-1);

  adjudicateFinding(opened.worktree, {
    findingId: outcome.findings[0].finding_id,
    disposition: 'valid',
    reason: 'holding this one for a human',
  });
  const dispatched = dispatchCorrectionOnSubmit(opened.worktree, { runtime: 'claude' }, dependencies);

  assert.equal(dispatched.dispatched, false, 'nothing dispatches when the human asked to keep the gesture');
  assert.equal(calls.length, before);
  assert.equal(readState(opened.worktree, opened.workId).slices[0].status, 'correction-ready');
  assert.match(dispatched.state.next_action, /run one human-valid correction for S1/u);
});

test('a human submitting their own finding dispatches the same way', t => {
  const { opened, calls, dependencies } = reviewedSlice(t, { prefix: 'humansubmit', workId: 'work-human-submit' });
  const before = calls.length;
  const checkpoint = readState(opened.worktree, opened.workId).slices[0].checkpoint_commit;

  recordHumanFinding(opened.worktree, {
    sliceId: 'S1',
    file: 'value.js',
    lineStart: 1,
    claim: 'The exported value is not what the acceptance criterion asks for.',
    passCondition: 'value.js exports 2.',
  });
  submitHumanFindings(opened.worktree, { sliceId: 'S1' });
  const dispatched = dispatchCorrectionOnSubmit(opened.worktree, { runtime: 'claude', sliceId: 'S1' }, dependencies);

  assert.equal(dispatched.dispatched, true);
  assert.equal(calls.length, before + 1, 'submission is the verdict, so it is also the trigger');
  assert.equal(calls.at(-1).resumeSessionId, 'impl-sess');
  assert.match(calls.at(-1).prompt, /The exported value is not what the acceptance criterion asks for\./u);
  assert.ok(checkpoint, 'the finding anchored against a real checkpoint');
});

// Nothing here cycles autonomously. A dispatch happens only in the breath of a human act, so an
// adjudication that does not produce a correction dispatches nothing at all.
test('an adjudication that produces no correction dispatches nothing', t => {
  const { opened, calls, dependencies } = reviewedSlice(t, { prefix: 'nofix', workId: 'work-no-fix' });
  const before = calls.length;
  const outcome = listReviewOutcomes(opened.worktree, opened.workId).at(-1);

  adjudicateFinding(opened.worktree, {
    findingId: outcome.findings[0].finding_id,
    disposition: 'false-positive',
    reason: 'the verification does cover it, in the negative control',
  });
  const dispatched = dispatchCorrectionOnSubmit(opened.worktree, { runtime: 'claude' }, dependencies);

  assert.equal(dispatched.dispatched, false);
  assert.equal(calls.length, before, 'no valid finding, nothing to fix, nothing spent');
  assert.equal(readState(opened.worktree, opened.workId).slices[0].status, 'awaiting-human-review');
});
