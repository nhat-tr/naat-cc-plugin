// Per-process machine scope: the real machine lease is global, and parallel test files would refuse
// each other's verifications. Required before the engine, so the env var is set when pair-store reads it.
require('./helpers/isolate-machine-lease');

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  acceptHumanReview,
  adjudicateFinding,
  advanceWork,
  humanFindingDrafts,
  openWork,
  recordCorrectionDirection,
  listHumanFindingDraft,
  recordHumanFinding,
  setHumanFindingPassCondition,
  submitHumanFindings,
  unblockWork,
} = require('../scripts/lib/pair-engine');
const { readEvents, readState } = require('../scripts/lib/pair-store');
const { listReviewOutcomes } = require('../scripts/lib/review-evidence');

// Pair's guards were written as walls: accept refused unless awaiting-human-review, a Correction
// Direction was admitted only at correction-ready, and an architecture-sensitive slice could not reach
// acceptance without a model review. That makes the machine the gatekeeper of the human, which is
// backwards — the human has more context than the reducer, and the invariant Pair actually needs is
// that a checkpoint EXPLAINS itself, not that a human cannot act. So a policy guard is overridable
// with a recorded reason, and only structurally impossible states stay refused.
function designCheck() {
  return {
    seam: 'src/consumer.js -> Registry.get; registry creation and lookup.',
    ownership: 'The composition root owns one instance; state stays private for its lifetime.',
    runtime: 'Callers serialize mutations; lookup failures return to the caller.',
    contract: 'Existing Registry.get callers retain the same lookup contract.',
    alternative: 'Reject process-global singleton state.',
    proof: 'Integration test two independent composition roots.',
  };
}

function providerResult(output) {
  return {
    output,
    usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 20 },
    duration_ms: 5,
    runtime: 'codex', model: 'default', effort: 'medium',
  };
}

// A Work whose only slice has a green checkpoint sitting at review-ready: the exact state the human
// reaches after reading the diff themselves and not wanting a model reviewer.
function reviewReadyFixture(t) {
  const scratch = process.env.CLAUDE_SCRATCH_DIR || path.join(os.homedir(), '.claude-scratch');
  const parent = path.join(scratch, 'my-claude-code', 'pair-override-tests');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'override-'));
  for (const args of [['init', '-q'], ['config', 'user.email', 'pair@test'], ['config', 'user.name', 'Pair Test']]) {
    childProcess.execFileSync('git', args, { cwd: root });
  }
  fs.writeFileSync(path.join(root, 'value.js'), 'module.exports = 1;\n');
  childProcess.execFileSync('git', ['add', '.'], { cwd: root });
  childProcess.execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
  const spec = path.join(parent, `${path.basename(root)}-spec.md`);
  const manifest = path.join(parent, `${path.basename(root)}-slices.json`);
  fs.writeFileSync(spec, '# Spec\n\n## Acceptance Criteria\n\n- [ ] AC-1: value becomes two\n');
  fs.writeFileSync(manifest, JSON.stringify({
    schema: 1,
    work_id: 'work-override',
    slices: [{ id: 'S1', acceptance_criteria: ['AC-1'], outcome: 'Existing value returns two.', depends_on: [], verify: 'node verify.js' }],
  }));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(spec, { force: true });
    fs.rmSync(manifest, { force: true });
  });
  const opened = openWork(root, { workId: 'work-override', specPath: spec, manifestPath: manifest });
  // architecture-sensitive so the fresh review is mandatory — the case no flag can skip today.
  advanceWork(opened.worktree, { runtime: 'codex' }, {
    runProvider() {
      return providerResult({ status: 'design-required', architecture_risk: 'Registry ownership is unowned.', design_check: designCheck(), failure_proof: null, blocker: null });
    },
    verify() { return { status: 0, stdout: '', stderr: '', durationMs: 1 }; },
  });
  advanceWork(opened.worktree, { runtime: 'codex' }, {
    runProvider(input) {
      // Several lines, so a correction can land away from an anchored line: with a one-line checkpoint
      // every hunk necessarily overlaps line 1, and "changed the file but not at your lines" — the case
      // that misleads a reviewer — cannot be expressed at all.
      fs.writeFileSync(path.join(input.root, 'value.js'), ['module.exports = 2;', ...Array.from({ length: 39 }, (_item, index) => `// line ${index + 2}`)].join('\n') + '\n');
      return providerResult({
        status: 'completed', architecture_risk: 'Registry ownership is unowned.', design_check: null,
        failure_proof: { boundary: 'module export', method: 'unit', negative_control: 'Returning 1 fails the verification.' }, blocker: null,
      });
    },
    verify() { return { status: 0, stdout: '', stderr: '', durationMs: 1 }; },
  });
  return { root, worktree: opened.worktree };
}

test('a human who reviewed the checkpoint themselves can accept it without a model review', t => {
  const { root, worktree } = reviewReadyFixture(t);
  assert.equal(readState(root).slices[0].status, 'review-ready', 'the fresh review is mandatory by default');

  assert.throws(
    () => acceptHumanReview(worktree, { sliceId: 'S1' }),
    /not awaiting human acceptance/u,
    'the default still refuses, so nothing is loosened by accident',
  );

  acceptHumanReview(worktree, { sliceId: 'S1', override: true, reason: 'Read the whole diff in nvim; ownership matches the Design Check.' });

  const state = readState(root);
  assert.equal(state.slices[0].status, 'accepted');
  const override = readEvents(root, 'work-override').findLast(event => event.event === 'human-override');
  assert.ok(override, 'the override is recorded, which is what keeps the checkpoint self-explaining');
  assert.equal(override.review_slice_id, 'S1');
  assert.equal(override.from_status, 'review-ready');
  assert.match(override.reason, /Read the whole diff in nvim/u);
});

test('an override still refuses a transition the state cannot represent', t => {
  const { root, worktree } = reviewReadyFixture(t);
  const state = readState(root);
  state.slices.push({ id: 'S-unbuilt', status: 'queued', correction_count: 0 });
  require('../scripts/lib/pair-store').writeState(root, 'work-override', state);

  assert.throws(
    () => acceptHumanReview(worktree, { sliceId: 'S-unbuilt', override: true, reason: 'skip it' }),
    /no checkpoint/u,
    'accepting a slice that produced no checkpoint would record an empty acceptance',
  );
});

test('an override requires a reason, because an unexplained override defeats the audit trail', t => {
  const { worktree } = reviewReadyFixture(t);

  assert.throws(
    () => acceptHumanReview(worktree, { sliceId: 'S1', override: true }),
    /reason/u,
  );
});

test('a human-authored finding drives the one correction exactly like a model finding', t => {
  const { root, worktree } = reviewReadyFixture(t);

  recordHumanFinding(worktree, {
    sliceId: 'S1',
    file: 'value.js',
    lineStart: 1,
    lineEnd: 1,
    claim: 'The export is a bare literal with no lookup seam.',
    scenario: 'A second composition root cannot obtain its own value.',
    impact: 'Callers share one module-global value.',
    passCondition: 'Two independent roots each observe their own value.',
  });
  const recorded = submitHumanFindings(worktree, { sliceId: 'S1' });

  const outcome = listReviewOutcomes(root, 'work-override').find(item => item.review_outcome_id === recorded.outcome.review_outcome_id);
  assert.equal(outcome.verdict, 'findings');
  assert.equal(outcome.findings.length, 1);
  assert.equal(outcome.reviewer.human, true, 'provenance distinguishes a human finding from a model one');
  assert.equal(outcome.findings[0].evidence.commit, readState(root).slices[0].checkpoint_commit);
  assert.equal(readState(root).slices[0].status, 'awaiting-feedback', 'it enters the normal adjudication path');
});

test('a Correction Direction is admitted at any status so steering never waits for the reducer', t => {
  const { root, worktree } = reviewReadyFixture(t);

  recordCorrectionDirection(worktree, { sliceId: 'S1', text: 'Bound the fix to the lookup seam only.' });

  assert.match(readState(root).slices[0].correction_direction, /lookup seam only/u);
});

test('a blocked Work is unblocked by a recorded human decision rather than by hand-editing state', t => {
  const { root, worktree } = reviewReadyFixture(t);
  const state = readState(root);
  state.lifecycle = 'blocked';
  state.blocked_reason = 'provider committed inside the Review Slice';
  state.next_action = 'human inspection required';
  require('../scripts/lib/pair-store').writeState(root, 'work-override', state);

  unblockWork(worktree, { reason: 'Inspected the stray commit and reset it; the worktree is clean.' });

  const after = readState(root);
  assert.equal(after.lifecycle, 'ready');
  assert.equal(after.blocked_reason, null);
  const override = readEvents(root, 'work-override').findLast(event => event.event === 'human-override');
  assert.match(override.reason, /Inspected the stray commit/u);
});

// Raising a second finding replaced the first: review_outcome_id was overwritten, so the earlier
// finding stayed on disk but nothing referenced it — and the Review Inbox then showed duplicate rows
// from stale outcomes, where staging a disposition recorded feedback the adjudication gate could never
// see. Observed live on S-03 with four outcomes for one checkpoint. Findings therefore gather in a
// draft and become exactly one Review Outcome on submit.
test('findings gather in a draft and mint no Review Outcome until submitted', t => {
  const { root, worktree } = reviewReadyFixture(t);
  const common = { sliceId: 'S1', file: 'value.js', lineStart: 1, lineEnd: 1 };

  recordHumanFinding(worktree, { ...common, claim: 'The export is a bare literal with no lookup seam.' });
  recordHumanFinding(worktree, { ...common, claim: 'No timeout bounds the lookup.' });

  assert.equal(listReviewOutcomes(root, 'work-override').length, 0, 'a draft is not evidence yet');
  assert.equal(readState(root).slices[0].status, 'review-ready', 'the slice does not move while drafting');
  assert.equal(listHumanFindingDraft(worktree, 'work-override', 'S1').length, 2);
});

test('submitting a draft records exactly one Review Outcome carrying every finding', t => {
  const { root, worktree } = reviewReadyFixture(t);
  const common = { sliceId: 'S1', file: 'value.js', lineStart: 1, lineEnd: 1, passCondition: 'Two roots each observe their own value.' };
  recordHumanFinding(worktree, { ...common, claim: 'The export is a bare literal with no lookup seam.' });
  recordHumanFinding(worktree, { ...common, claim: 'No timeout bounds the lookup.' });

  const submitted = submitHumanFindings(worktree, { sliceId: 'S1' });

  const outcomes = listReviewOutcomes(root, 'work-override');
  assert.equal(outcomes.length, 1, 'one outcome, so the Review Inbox cannot show a stale duplicate');
  assert.equal(outcomes[0].findings.length, 2);
  assert.equal(outcomes[0].reviewer.human, true);
  const state = readState(root);
  assert.equal(state.slices[0].review_outcome_id, submitted.outcome.review_outcome_id);
  assert.equal(state.slices[0].status, 'awaiting-feedback');
  assert.equal(listHumanFindingDraft(worktree, 'work-override', 'S1').length, 0, 'the draft is cleared by submission');
});

test('a human review is not capped at the three findings a model review is bounded to', t => {
  const { root, worktree } = reviewReadyFixture(t);
  const common = { sliceId: 'S1', file: 'value.js', lineStart: 1, lineEnd: 1, passCondition: 'Two roots each observe their own value.' };
  for (const claim of ['First concern.', 'Second concern.', 'Third concern.', 'Fourth concern.', 'Fifth concern.']) {
    recordHumanFinding(worktree, { ...common, claim });
  }

  submitHumanFindings(worktree, { sliceId: 'S1' });

  const outcome = listReviewOutcomes(root, 'work-override')[0];
  assert.equal(outcome.findings.length, 5, 'the three-finding bound exists to keep a model review small');
});

test('submitting nothing is refused rather than recording an empty review', t => {
  const { worktree } = reviewReadyFixture(t);

  assert.throws(() => submitHumanFindings(worktree, { sliceId: 'S1' }), /no drafted finding/u);
});

// correctionPrompt tells the corrector to "make only the bounded correction that satisfies each pass
// condition", so for a human finding the pass condition is the ONLY statement of done-ness it receives.
// A fabricated placeholder — "the human who raised this confirms it is addressed" — is not falsifiable
// by the corrector, which removes the bound from a bounded correction. The user's first real finding was
// a performance one, where that placeholder named no number to hit.
test('a finding stating no pass condition is refused at submission instead of given a placeholder', t => {
  const { root, worktree } = reviewReadyFixture(t);

  recordHumanFinding(worktree, { sliceId: 'S1', file: 'value.js', lineStart: 1, lineEnd: 1, claim: 'The lookup is unbounded.' });

  assert.throws(() => submitHumanFindings(worktree, { sliceId: 'S1' }), error => {
    assert.match(error.message, /pass condition/u);
    // A refusal with no command to satisfy it is the dead end this loop has already been bitten by.
    assert.match(error.message, /--pass-condition/u, 'the refusal names the command that completes the draft');
    return true;
  });
  assert.equal(listReviewOutcomes(root, 'work-override').length, 0, 'nothing enters the record half-stated');
  assert.equal(readState(root).slices[0].status, 'review-ready', 'the slice does not move on a refused submission');
  assert.equal(listHumanFindingDraft(worktree, 'work-override', 'S1').length, 1, 'the draft survives so the human can complete it');
});

test('a pass condition is stated on a draft in place, so a refused submission is completed not duplicated', t => {
  const { worktree } = reviewReadyFixture(t);
  const common = { sliceId: 'S1', file: 'value.js', lineStart: 1, lineEnd: 1 };
  recordHumanFinding(worktree, { ...common, claim: 'The lookup is unbounded.' });
  recordHumanFinding(worktree, { ...common, claim: 'The index is rebuilt per request.' });

  setHumanFindingPassCondition(worktree, { sliceId: 'S1', index: 1, passCondition: 'A timeout bounds the lookup.' });
  setHumanFindingPassCondition(worktree, { sliceId: 'S1', passCondition: 'The index is built once per process.' });

  const submitted = submitHumanFindings(worktree, { sliceId: 'S1' });
  assert.equal(listHumanFindingDraft(worktree, 'work-override', 'S1').length, 0, 'completing a draft does not duplicate it');
  assert.deepEqual(
    submitted.outcome.findings.map(item => item.pass_condition),
    ['A timeout bounds the lookup.', 'The index is built once per process.'],
    'no index means the finding just drafted, which is the one the human is still looking at',
  );
});

// A slice holds at awaiting-feedback until EVERY finding has feedback, and adjudicateFinding returns
// early on the partial case without touching next_action — so status reported "adjudicate 3 finding(s)"
// after two were already adjudicated, and the human could not tell progress from no progress.
test('adjudicating some of the findings reports what still holds the Review Slice', t => {
  const { root, worktree } = reviewReadyFixture(t);
  const common = { sliceId: 'S1', file: 'value.js', lineStart: 1, lineEnd: 1, passCondition: 'Two roots each observe their own value.' };
  recordHumanFinding(worktree, { ...common, claim: 'First concern.' });
  recordHumanFinding(worktree, { ...common, claim: 'Second concern.' });
  recordHumanFinding(worktree, { ...common, claim: 'Third concern.' });
  const submitted = submitHumanFindings(worktree, { sliceId: 'S1' });
  assert.match(readState(root).next_action, /3 finding\(s\)/u);

  adjudicateFinding(worktree, { findingId: submitted.outcome.findings[0].finding_id, disposition: 'valid', reason: 'The lookup seam is genuinely missing.' });

  const state = readState(root);
  assert.equal(state.slices[0].status, 'awaiting-feedback', 'the slice still holds');
  assert.match(state.next_action, /2 of 3/u, 'the count reflects what remains, not what was submitted');
});

// pair-review's feedback operation called recordReviewFeedback — the raw evidence writer — while every
// other mutating operation in that file goes through the engine. So adjudicating from the editor wrote
// durable Review Feedback and never ran the reducer: the Review Slice stayed at awaiting-feedback, and
// because a second Review Feedback for the same finding is refused, the one command that would have
// advanced it could no longer be used. `pair-loop run` at awaiting-human returns the state unchanged, so
// the loop wedged silently. Observed live on S-03 with all three findings adjudicated valid.
test('adjudicating through pair-review advances the Review Slice, not just the evidence', t => {
  const { root, worktree } = reviewReadyFixture(t);
  const { operate } = require('../scripts/pair-review');
  recordHumanFinding(worktree, { sliceId: 'S1', file: 'value.js', lineStart: 1, lineEnd: 1, claim: 'The lookup is unbounded.', passCondition: 'A timeout bounds the lookup.' });
  const submitted = submitHumanFindings(worktree, { sliceId: 'S1' });

  operate(worktree, 'feedback', {
    work: 'work-override',
    finding: submitted.outcome.findings[0].finding_id,
    disposition: 'valid',
    reason: 'The seam is genuinely missing.',
  });

  const state = readState(root);
  assert.equal(state.slices[0].status, 'correction-ready', 'the editor path reaches the same status the shell path does');
  assert.equal(state.lifecycle, 'ready');
  assert.match(state.next_action, /correction/u);
});

test('a Review Slice whose projection fell behind its recorded feedback is reconciled, not wedged', t => {
  const { root, worktree } = reviewReadyFixture(t);
  const { reconcileAdjudication } = require('../scripts/lib/pair-engine');
  const { recordReviewFeedback } = require('../scripts/lib/review-evidence');
  recordHumanFinding(worktree, { sliceId: 'S1', file: 'value.js', lineStart: 1, lineEnd: 1, claim: 'The lookup is unbounded.', passCondition: 'A timeout bounds the lookup.' });
  const submitted = submitHumanFindings(worktree, { sliceId: 'S1' });
  // Exactly the wedge: durable feedback, untouched projection, and no second feedback possible.
  recordReviewFeedback(worktree, {
    workId: 'work-override',
    findingId: submitted.outcome.findings[0].finding_id,
    disposition: 'valid',
    reason: 'Recorded without the reducer, as the editor used to do.',
  });
  assert.equal(readState(root).slices[0].status, 'awaiting-feedback', 'the projection is stale');

  reconcileAdjudication(worktree, { sliceId: 'S1' });

  assert.equal(readState(root).slices[0].status, 'correction-ready', 'the reducer catches up from recorded evidence alone');
  // Not repeatable, and that is the safety property rather than a limitation: re-deriving a slice that
  // has since spent its correction would flip it to blocked on the same feedback it already answered.
  assert.throws(
    () => reconcileAdjudication(worktree, { sliceId: 'S1' }),
    /correction-ready/u,
    'a second repair says there is nothing left to repair, naming where the slice actually is',
  );
});

// Knowing a repair verb must never be a prerequisite for driving the loop. A stale projection is
// detectable and derivable from evidence already on disk, so the ordinary next transition repairs it
// rather than returning unchanged and leaving the human to discover `reconcile`.
test('the ordinary next transition repairs a stale projection instead of silently doing nothing', t => {
  const { root, worktree } = reviewReadyFixture(t);
  const { recordReviewFeedback } = require('../scripts/lib/review-evidence');
  recordHumanFinding(worktree, { sliceId: 'S1', file: 'value.js', lineStart: 1, lineEnd: 1, claim: 'The lookup is unbounded.', passCondition: 'A timeout bounds the lookup.' });
  const submitted = submitHumanFindings(worktree, { sliceId: 'S1' });
  recordReviewFeedback(worktree, {
    workId: 'work-override',
    findingId: submitted.outcome.findings[0].finding_id,
    disposition: 'valid',
    reason: 'Recorded without the reducer.',
  });

  let provider = 0;
  advanceWork(worktree, { runtime: 'codex' }, {
    runProvider() { provider += 1; return providerResult({ status: 'completed', architecture_risk: null, design_check: null, failure_proof: null, blocker: null }); },
    verify() { return { status: 0, stdout: '', stderr: '', durationMs: 1 }; },
  });

  const state = readState(root);
  assert.equal(state.slices[0].status, 'correction-ready', 'the projection is caught up by the command the human already knows');
  assert.equal(provider, 0, 'repairing a projection is one transition; it does not also spend the correction unseen');
  assert.match(state.next_action, /correction/u, 'and the next command is named from the repaired position');
});

// The correction is one-shot and irreversible, and the exact text the correcting session receives was
// invisible: correctionPrompt was internal, so nothing could show the brief before it was spent. A human
// deciding whether to steer with `direct` first had to infer the brief from `show` and trust the
// inference. Observed live on S-03, whose three valid findings carry placeholder pass conditions.
test('the correction brief can be read before the one correction is spent', t => {
  const { root, worktree } = reviewReadyFixture(t);
  const { correctionBrief } = require('../scripts/lib/pair-engine');
  recordHumanFinding(worktree, {
    sliceId: 'S1', file: 'value.js', lineStart: 1, lineEnd: 1,
    claim: 'The export is a bare literal.', passCondition: 'Two roots each observe their own value.',
  });
  const submitted = submitHumanFindings(worktree, { sliceId: 'S1' });
  adjudicateFinding(worktree, { findingId: submitted.outcome.findings[0].finding_id, disposition: 'valid', reason: 'The seam is missing.' });
  recordCorrectionDirection(worktree, { sliceId: 'S1', text: 'Bound the fix to the lookup seam only.' });

  const brief = correctionBrief(worktree, { sliceId: 'S1' });

  assert.equal(brief.review_slice_id, 'S1');
  assert.match(brief.prompt, /Two roots each observe their own value/u, 'the pass condition it must satisfy is visible');
  assert.match(brief.prompt, /The seam is missing/u, 'the adjudication reason that steers it is visible');
  assert.match(brief.prompt, /lookup seam only/u, 'so is the Correction Direction, before it is spent');
  assert.equal(readState(root).slices[0].status, 'correction-ready', 'reading the brief changes nothing');
});

// Every valid finding goes into the one correction and the corrector is told to satisfy all of them, but
// nothing afterwards said whether it did. With a placeholder pass condition there is nothing to check
// mechanically either — so the loop reports the one fact it can establish from evidence: whether the
// correction opened the file each finding is anchored to. A file the correction never touched cannot
// contain a fix, which is the half of this that is proof.
test('slice evidence reports whether the correction touched each valid finding', t => {
  const { root, worktree } = reviewReadyFixture(t);
  const { sliceEvidence } = require('../scripts/lib/pair-engine');
  fs.writeFileSync(path.join(worktree, 'other.js'), 'module.exports = 3;\n');
  recordHumanFinding(worktree, { sliceId: 'S1', file: 'value.js', lineStart: 1, lineEnd: 1, claim: 'The export is bare.', passCondition: 'Two roots observe their own value.' });
  const submitted = submitHumanFindings(worktree, { sliceId: 'S1' });
  adjudicateFinding(worktree, { findingId: submitted.outcome.findings[0].finding_id, disposition: 'valid', reason: 'The seam is missing.' });

  // The correction changes a different file than the one the finding is anchored to.
  advanceWork(worktree, { runtime: 'codex' }, {
    runProvider(input) {
      fs.writeFileSync(path.join(input.root, 'other.js'), 'module.exports = 4;\n');
      return providerResult({ status: 'completed', architecture_risk: null, design_check: null, failure_proof: { boundary: 'module export', method: 'unit', negative_control: 'Returning 3 fails.' }, blocker: null });
    },
    verify() { return { status: 0, stdout: '', stderr: '', durationMs: 1 }; },
  });

  const evidence = sliceEvidence(worktree, { sliceId: 'S1' });
  assert.equal(evidence.correction_count, 1, 'the correction was spent');
  assert.equal(evidence.findings[0].correction.file_changed, false, 'the anchored file was never opened, so the finding cannot have been fixed');
  assert.equal(evidence.findings[0].correction.overlapping_hunks.length, 0);
  assert.deepEqual(evidence.correction_unattributed.map(item => item.path), ['other.js'], 'the whole correction was scope nobody asked for');
  assert.ok(readState(root).slices[0].status, 'the slice moved on as usual');
});

// "changed this file" is too coarse to review a correction with: a file can change 24 lines and none of
// them near the anchored line, and the diff mixes what the findings asked for with what the corrector
// decided on its own. Findings carry exact line anchors and the diff carries exact hunk ranges, so the
// split is derivable: hunks overlapping an anchor belong to that finding, and everything else is scope
// nobody asked for and must be reviewed as such.
test('a correction is attributed hunk by hunk to the finding that asked for it', t => {
  const { worktree } = reviewReadyFixture(t);
  const { sliceEvidence } = require('../scripts/lib/pair-engine');
  recordHumanFinding(worktree, { sliceId: 'S1', file: 'value.js', lineStart: 1, lineEnd: 1, claim: 'The export is bare.', passCondition: 'Two roots observe their own value.' });
  const submitted = submitHumanFindings(worktree, { sliceId: 'S1' });
  adjudicateFinding(worktree, { findingId: submitted.outcome.findings[0].finding_id, disposition: 'valid', reason: 'The seam is missing.' });

  advanceWork(worktree, { runtime: 'codex' }, {
    runProvider(input) {
      // One change where the finding asked for it, and one whole file nobody asked for.
      const lines = ['module.exports = 2;', ...Array.from({ length: 39 }, (_item, index) => `// line ${index + 2}`)];
      lines[0] = 'module.exports = make();';
      fs.writeFileSync(path.join(input.root, 'value.js'), lines.join('\n') + '\n');
      fs.writeFileSync(path.join(input.root, 'extra.js'), 'module.exports = "unrequested";\n');
      return providerResult({ status: 'completed', architecture_risk: null, design_check: null, failure_proof: { boundary: 'module export', method: 'unit', negative_control: 'Returning a literal fails.' }, blocker: null });
    },
    verify() { return { status: 0, stdout: '', stderr: '', durationMs: 1 }; },
  });

  const evidence = sliceEvidence(worktree, { sliceId: 'S1' });
  const finding = evidence.findings[0];
  assert.equal(finding.correction.overlapping_hunks.length, 1, 'the hunk at the anchored line is attributed to the finding');
  assert.equal(finding.correction.overlapping_hunks[0].old_start, 1);
  const unrequested = evidence.correction_unattributed.map(item => item.path);
  assert.deepEqual(unrequested, ['extra.js'], 'a file no finding anchors to is named as scope nobody asked for');
});

// A bounded fix for a finding anchored at one line usually lands beside it, not on it — a guard inserted
// below, or the surrounding lines rewritten. Strict overlap called that "nothing at your lines" and then
// counted the same hunks as scope nobody asked for: wrong twice, in opposite directions. So proximity is
// attributed, and labelled as proximity.
test('a fix landing beside the anchored line is attributed to the finding, not to unrequested scope', t => {
  const { worktree } = reviewReadyFixture(t);
  const { sliceEvidence } = require('../scripts/lib/pair-engine');
  recordHumanFinding(worktree, { sliceId: 'S1', file: 'value.js', lineStart: 1, lineEnd: 1, claim: 'The export is bare.', passCondition: 'Two roots observe their own value.' });
  const submitted = submitHumanFindings(worktree, { sliceId: 'S1' });
  adjudicateFinding(worktree, { findingId: submitted.outcome.findings[0].finding_id, disposition: 'valid', reason: 'The seam is missing.' });

  advanceWork(worktree, { runtime: 'codex' }, {
    runProvider(input) {
      const lines = ['module.exports = 2;', ...Array.from({ length: 39 }, (_item, index) => `// line ${index + 2}`)];
      lines[3] = '// line 4 — the guard the finding asked for';  // 3 lines below the anchor
      lines[34] = '// line 35 — unrelated tidying nobody asked for';  // 34 lines below it
      fs.writeFileSync(path.join(input.root, 'value.js'), lines.join('\n') + '\n');
      return providerResult({ status: 'completed', architecture_risk: null, design_check: null, failure_proof: { boundary: 'module export', method: 'unit', negative_control: 'n/a.' }, blocker: null });
    },
    verify() { return { status: 0, stdout: '', stderr: '', durationMs: 1 }; },
  });

  const evidence = sliceEvidence(worktree, { sliceId: 'S1' });
  const finding = evidence.findings[0];
  assert.equal(finding.correction.file_changed, true);
  assert.equal(finding.correction.overlapping_hunks.length, 0, 'the exact anchored line was not edited');
  assert.equal(finding.correction.near_hunks.length, 1, 'but the change beside it is attributed to the finding');
  assert.equal(finding.correction.near_hunks[0].distance, 3);
  // The far change is the one that is genuinely unaccounted for, and it must not be hidden by the near one.
  assert.deepEqual(evidence.correction_unattributed.map(item => item.path), ['value.js']);
  assert.equal(evidence.correction_unattributed[0].hunks, 1, 'only the distant hunk is unaccounted for');
});

test('a correction brief exists only where a correction does', t => {
  const { worktree } = reviewReadyFixture(t);
  const { correctionBrief } = require('../scripts/lib/pair-engine');

  assert.throws(() => correctionBrief(worktree, { sliceId: 'S1' }), /review-ready|correction-ready/u);
});

// A run that only repaired bookkeeping printed the same status block as a run that dispatched a coding
// session, so it read as "the agent ran and changed nothing" instead of "nothing has run yet". That is
// the worse of the two beliefs: it sends a human looking for a diff that was never produced. The repair
// is therefore labelled on the returned state, and only there — the label is not durable state.
test('a run that only repairs bookkeeping says so, and does not persist saying it', t => {
  const { root, worktree } = reviewReadyFixture(t);
  const { recordReviewFeedback } = require('../scripts/lib/review-evidence');
  recordHumanFinding(worktree, { sliceId: 'S1', file: 'value.js', lineStart: 1, lineEnd: 1, claim: 'The lookup is unbounded.', passCondition: 'A timeout bounds the lookup.' });
  const submitted = submitHumanFindings(worktree, { sliceId: 'S1' });
  recordReviewFeedback(worktree, {
    workId: 'work-override',
    findingId: submitted.outcome.findings[0].finding_id,
    disposition: 'valid',
    reason: 'Recorded without the reducer.',
  });

  const returned = advanceWork(worktree, { runtime: 'codex' }, {
    runProvider() { throw new Error('no coding session may run for a bookkeeping repair'); },
    verify() { throw new Error('no verification may run for a bookkeeping repair'); },
  });

  assert.equal(returned.pair_transition, 'projection-repaired', 'the caller can tell this run did no work');
  assert.equal(readState(root).pair_transition, undefined, 'and the label never becomes durable state');
  assert.equal(readState(root).slices[0].status, 'correction-ready');
});

// A block wrote state.json and no event, so a state the loop genuinely entered left no trace in the
// journal. Observed live: the monitor watched S-04 go ready -> blocked on a dirty worktree, and afterwards
// the journal held neither the block nor either of its two recorded exits (block-cleared, human-override)
// — the transition could not be explained at all. Pair's invariant is that a checkpoint explains itself,
// which a state change absent from the journal defeats.
test('blocking on a dirty worktree is recorded in the journal, not only in state', t => {
  const { root, worktree } = reviewReadyFixture(t);
  const { writeState } = require('../scripts/lib/pair-store');
  const state = readState(root);
  state.slices[0].status = 'queued';
  state.slices[0].checkpoint_commit = null;
  state.lifecycle = 'ready';
  writeState(root, 'work-override', state);
  fs.writeFileSync(path.join(worktree, 'stray.js'), 'module.exports = "unreviewed";\n');

  advanceWork(worktree, { runtime: 'codex' }, {
    runProvider() { throw new Error('a dirty worktree must block before any provider runs'); },
    verify() { throw new Error('and before any verification'); },
  });

  const after = readState(root);
  assert.equal(after.lifecycle, 'blocked', 'the block still happens');
  const blocked = readEvents(root, 'work-override').findLast(event => event.event === 'dirty-worktree-block');
  assert.ok(blocked, 'and it is now explainable from the journal alone');
  assert.equal(blocked.review_slice_id, 'S1');
  assert.match(blocked.blocked_reason, /dirty/u);
  assert.equal(blocked.blocked_from, 'queued', 'the status it must resume into is recorded with it');
  assert.ok(blocked.dirty_path_count >= 1, 'and how much was in the way, since the paths themselves are not evidence');
});

// Two `pair-loop run` processes on one Work could interleave: state.json is written whole, so the loser's
// transition is erased silently, and both providers edit the same worktree so each sweeps the other's
// half-written files into its checkpoint. Observed live on S-04 — a block was written and then vanished
// with no exit event, which is what a state overwritten by another writer looks like. The mutation lock is
// too short for this (a dispatch runs for minutes) and the verification lease covers only the suite, so a
// dispatch needs its own lease. It refuses rather than queues: a second coding session on one worktree is
// never what the human wanted, and waiting silently for minutes is worse than being told.
function queuedFixture(t) {
  const { root, worktree } = reviewReadyFixture(t);
  const { writeState } = require('../scripts/lib/pair-store');
  const state = readState(root);
  state.slices[0].status = 'queued';
  state.slices[0].checkpoint_commit = null;
  state.lifecycle = 'ready';
  writeState(root, 'work-override', state);
  return { root, worktree };
}

test('a second dispatch on the same Work is refused while the first is running', t => {
  const { root, worktree } = queuedFixture(t);
  const { workPaths } = require('../scripts/lib/pair-store');
  // A live holder: this very process, so the liveness check cannot call it abandoned.
  const lease = workPaths(root, 'work-override').dispatchLease;
  fs.mkdirSync(lease, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(lease, 'owner.json'), `${JSON.stringify({ pid: process.pid, nonce: 'held', at: new Date().toISOString() })}\n`);

  assert.throws(
    () => advanceWork(worktree, { runtime: 'codex' }, {
      runProvider() { throw new Error('no second coding session may start on this worktree'); },
      verify() { throw new Error('and no verification'); },
    }),
    error => {
      assert.match(error.message, new RegExp(`${process.pid}`, 'u'), 'the holder is named so the human can act on it');
      assert.match(error.message, /dispatch/iu);
      return true;
    },
  );
});

test('a dispatch lease abandoned by a killed process does not wedge the Work', t => {
  const { root, worktree } = queuedFixture(t);
  const { workPaths } = require('../scripts/lib/pair-store');
  // A pid that has certainly exited: a process we ran to completion ourselves.
  const dead = childProcess.spawnSync('true', [], { encoding: 'utf8' }).pid;
  const lease = workPaths(root, 'work-override').dispatchLease;
  fs.mkdirSync(lease, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(lease, 'owner.json'), `${JSON.stringify({ pid: dead, nonce: 'stale', at: new Date().toISOString() })}\n`);

  let dispatched = 0;
  advanceWork(worktree, { runtime: 'codex' }, {
    runProvider(input) {
      dispatched += 1;
      fs.writeFileSync(path.join(input.root, 'value.js'), 'module.exports = 3;\n');
      return providerResult({ status: 'completed', architecture_risk: null, design_check: null, failure_proof: { boundary: 'module export', method: 'unit', negative_control: 'n/a.' }, blocker: null });
    },
    verify() { return { status: 0, stdout: '', stderr: '', durationMs: 1 }; },
  });

  assert.equal(dispatched, 1, 'the abandoned lease is reclaimed rather than refused forever');
  assert.equal(fs.existsSync(lease), false, 'and the lease is released when the dispatch returns');
});

// recordInvocation runs after the provider returns, so an exception skipped both the journal entry and the
// token totals. Observed live: an S-05 review spent 6m35s over 27 turns and 25,969 output tokens, exhausted
// its structured-output retries, and the Work's record showed the review had never been attempted. Cost that
// real cannot be invisible, and a phase that keeps failing has to be countable.
test('a provider call that fails is still recorded, with what it cost', t => {
  const { root, worktree } = queuedFixture(t);
  // The fixture already spent two successful calls, so the assertion is on the delta this failure adds.
  const before = readState(root).invocation_totals || { calls: 0, output_tokens: 0 };

  assert.throws(() => advanceWork(worktree, { runtime: 'codex' }, {
    runProvider() {
      const error = new Error('Claude ended with error_max_structured_output_retries after 27 turns');
      error.pair_invocation = {
        runtime: 'claude',
        mode: 'implementation',
        usage: { input_tokens: 48, cached_input_tokens: 0, output_tokens: 25969 },
        duration_ms: 395305,
        failure: 'error_max_structured_output_retries',
      };
      throw error;
    },
    verify() { throw new Error('verification must not run when the provider failed'); },
  }), /error_max_structured_output_retries/u);

  const failure = readEvents(root, 'work-override').findLast(event => event.event === 'provider-failed');
  assert.ok(failure, 'the attempt is in the journal');
  assert.equal(failure.review_slice_id, 'S1');
  assert.equal(failure.failure, 'error_max_structured_output_retries', 'named by its cause, not as a generic error');
  assert.equal(failure.output_tokens, 25969, 'and by what it spent');
  assert.equal(failure.duration_ms, 395305);
  const state = readState(root);
  assert.equal(state.invocation_totals.output_tokens - before.output_tokens, 25969,
    'the tokens reach the Work total, because they were really spent');
  assert.equal(state.invocation_totals.calls - before.calls, 1, 'and the attempt counts as a call');
  assert.equal(state.slices[0].status, 'queued', 'while the slice still refuses to advance, which was always correct');
});

test('reconciliation refuses a Review Slice that is not waiting on adjudication', t => {
  const { worktree } = reviewReadyFixture(t);
  const { reconcileAdjudication } = require('../scripts/lib/pair-engine');

  assert.throws(
    () => reconcileAdjudication(worktree, { sliceId: 'S1' }),
    /awaiting-feedback|nothing to reconcile/u,
    're-deriving an accepted or in-flight slice could regress it, so only the wedge state is repairable',
  );
});

test('a pass condition that names no observable state is refused', t => {
  const { worktree } = reviewReadyFixture(t);
  recordHumanFinding(worktree, { sliceId: 'S1', file: 'value.js', lineStart: 1, lineEnd: 1, claim: 'The lookup is unbounded.' });

  assert.throws(() => setHumanFindingPassCondition(worktree, { sliceId: 'S1', passCondition: '   ' }), /pass condition/u);
  assert.throws(() => setHumanFindingPassCondition(worktree, { sliceId: 'S1', index: 4, passCondition: 'Bounded.' }), /1-1/u);
});

// The Review Inbox listed every Review Outcome ever written for a Work, including ones superseded while
// a review was being built. Four blocks appeared for S-03 with overlapping findings, and staging a
// disposition on a superseded row recorded feedback against a finding id the current outcome does not
// contain — the adjudication gate could never complete and the slice would wedge. An outcome is shown
// only if its slice still references it, or if the slice is accepted (compactAcceptedSlice drops the
// reference, and that history is worth keeping).
test('the Review Inbox hides outcomes a slice has superseded and keeps accepted history', t => {
  const { root, worktree } = reviewReadyFixture(t);
  const { inbox } = require('../scripts/pair-review');
  const common = { sliceId: 'S1', file: 'value.js', lineStart: 1, lineEnd: 1, passCondition: 'Two roots each observe their own value.' };

  recordHumanFinding(worktree, { ...common, claim: 'First concern.' });
  const first = submitHumanFindings(worktree, { sliceId: 'S1' });
  // A second review of the same checkpoint supersedes the first.
  recordHumanFinding(worktree, { ...common, claim: 'Second concern.' });
  const second = submitHumanFindings(worktree, { sliceId: 'S1' });

  const listed = inbox(worktree, 'work-override').map(item => item.review_outcome_id);
  assert.deepEqual(listed, [second.outcome.review_outcome_id], 'only the referenced outcome is offered for staging');
  assert.equal(listReviewOutcomes(root, 'work-override').length, 2, 'nothing is deleted; the record keeps both');

  acceptHumanReview(worktree, { sliceId: 'S1', override: true, reason: 'Adjudicated by hand after reading the diff.' });
  const afterAccept = inbox(worktree, 'work-override').map(item => item.review_outcome_id);
  assert.ok(afterAccept.includes(second.outcome.review_outcome_id), 'an accepted slice keeps its outcome visible as history');
  assert.equal(afterAccept.includes(first.outcome.review_outcome_id), false, 'a superseded outcome stays hidden');
});

// unblock cleared the Work-level lifecycle but left the slice itself at 'blocked', a status no dispatch
// path reads as anything but "fresh implementation": the interrupted position was lost, the one-correction
// accounting was bypassed, and for a dirty-worktree block the very next run re-entered the block and
// overwrote blocked_from with 'blocked', destroying the real resume-into status for good.
test('unblocking a dirty-worktree block restores the interrupted slice and the recorded decision holds', t => {
  const scratch = process.env.CLAUDE_SCRATCH_DIR || path.join(os.homedir(), '.claude-scratch');
  const parent = path.join(scratch, 'my-claude-code', 'pair-override-tests');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'unblock-'));
  for (const args of [['init', '-q'], ['config', 'user.email', 'pair@test'], ['config', 'user.name', 'Pair Test']]) {
    childProcess.execFileSync('git', args, { cwd: root });
  }
  fs.writeFileSync(path.join(root, 'value.js'), 'module.exports = 1;\n');
  childProcess.execFileSync('git', ['add', '.'], { cwd: root });
  childProcess.execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
  const spec = path.join(parent, `${path.basename(root)}-spec.md`);
  const manifest = path.join(parent, `${path.basename(root)}-slices.json`);
  fs.writeFileSync(spec, '# Spec\n\n## Acceptance Criteria\n\n- [ ] AC-1: value becomes two\n');
  fs.writeFileSync(manifest, JSON.stringify({
    schema: 1,
    work_id: 'work-unblock',
    slices: [{ id: 'S1', acceptance_criteria: ['AC-1'], outcome: 'Existing value returns two.', depends_on: [], verify: 'node verify.js' }],
  }));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(spec, { force: true });
    fs.rmSync(manifest, { force: true });
  });
  const opened = openWork(root, { workId: 'work-unblock', specPath: spec, manifestPath: manifest });
  fs.writeFileSync(path.join(opened.worktree, 'stray.js'), 'module.exports = 9;\n');
  const calls = [];
  const dependencies = {
    runProvider(input) {
      calls.push('dispatch');
      fs.writeFileSync(path.join(input.root, 'value.js'), 'module.exports = 2;\n');
      return providerResult({
        status: 'completed', architecture_risk: null, design_check: null,
        failure_proof: { boundary: 'module export', method: 'unit', negative_control: 'Returning 1 fails the verification.' }, blocker: null,
      });
    },
    verify() { return { status: 0, stdout: '', stderr: '', durationMs: 1 }; },
  };

  advanceWork(opened.worktree, { runtime: 'codex' }, dependencies);
  let state = readState(root, 'work-unblock');
  assert.equal(state.lifecycle, 'blocked');
  assert.equal(state.slices[0].status, 'blocked', 'the slice itself carries the block');
  assert.equal(state.slices[0].blocked_from, 'queued');
  assert.equal(calls.length, 0, 'nothing was dispatched onto the dirty tree');

  unblockWork(opened.worktree, { workId: 'work-unblock', reason: 'The stray file is deliberate scaffolding for this slice.' });
  state = readState(root, 'work-unblock');
  assert.equal(state.slices[0].status, 'queued', 'the slice resumes where the block interrupted it');
  assert.equal(state.slices[0].blocked_from, undefined, 'the resume-into marker is spent, not left to go stale');

  advanceWork(opened.worktree, { workId: 'work-unblock', runtime: 'codex' }, dependencies);
  state = readState(root, 'work-unblock');
  assert.equal(calls.length, 1, 'the recorded decision lets the dispatch proceed on the accepted tree');
  assert.notEqual(state.slices[0].status, 'blocked', 'unblock followed by run must not re-enter the same block');
  assert.equal(state.slices[0].correction_count, 0, 'no correction was spent by the human decision');
});

test('unblocking an exhausted correction restores correction-ready so the human grants a bounded retry', t => {
  const { root, worktree } = reviewReadyFixture(t);
  const state = readState(root);
  state.lifecycle = 'blocked';
  state.blocked_reason = 'Review Slice S1 exhausted its one correction';
  state.next_action = 'human correction required';
  state.slices[0].status = 'blocked';
  state.slices[0].correction_count = 1;
  state.slices[0].review_outcome_id = 'f'.repeat(24);
  require('../scripts/lib/pair-store').writeState(root, 'work-override', state);

  unblockWork(worktree, { reason: 'The finding is real; I authorize one more bounded correction.' });

  const after = readState(root);
  assert.equal(after.lifecycle, 'ready');
  assert.equal(after.slices[0].status, 'correction-ready', 'the granted retry dispatches as a correction, not an uncounted fresh attempt');
  assert.match(after.next_action, /S1/u);
});

// Drafting printed the draft once, as transient output, and nothing read the draft directory afterwards —
// not status, not show, not the Review Inbox. So the human who skipped the pass condition could not see
// that they had, and the only signal was the refusal at submission, by which point re-drafting the finding
// looked like the only way forward. Observed live: one slice held two drafts of the same claim, the first
// with no pass condition and the second added because the first was invisible.
test('an unsubmitted draft is listed with what still blocks its submission', t => {
  const { worktree } = reviewReadyFixture(t);
  const common = { sliceId: 'S1', file: 'value.js', lineStart: 1, lineEnd: 1 };
  recordHumanFinding(worktree, { ...common, claim: 'The lookup is unbounded.' });
  recordHumanFinding(worktree, { ...common, claim: 'The index is rebuilt per request.', passCondition: 'The index is built once per process.' });

  const drafts = humanFindingDrafts(worktree, 'work-override');

  assert.equal(drafts.length, 1, 'one draft per Review Slice, not one per finding');
  assert.equal(drafts[0].review_slice_id, 'S1');
  assert.equal(drafts[0].findings.length, 2);
  assert.equal(drafts[0].unstated_count, 1, 'the count is what submission will refuse on');
  assert.equal(drafts[0].stale, false, 'the slice still carries the checkpoint the draft anchors to');
});

// A draft is deleted when it is submitted and never otherwise, so a slice accepted by any other route
// leaves its draft on disk forever. Observed live: a question drafted against an accepted slice was still
// sitting there a day later, unsubmittable and unmentioned, and the slice had been accepted without it.
test('a draft whose Review Slice is already accepted is reported stale rather than pending', t => {
  const { worktree } = reviewReadyFixture(t);
  recordHumanFinding(worktree, { sliceId: 'S1', file: 'value.js', lineStart: 1, lineEnd: 1, claim: 'What is this for?' });

  acceptHumanReview(worktree, { sliceId: 'S1', override: true, reason: 'Read the whole diff; the seam matches the Design Check.' });

  const [draft] = humanFindingDrafts(worktree, 'work-override');
  assert.equal(draft.stale, true, 'an accepted slice can no longer carry a submission, so the draft is not pending work');
  assert.match(draft.stale_reason, /accepted/u, 'the reason names why it can never be submitted');
});

// The submission gate refuses a MISSING pass condition, and that is the hole a typed placeholder walks
// straight through. Observed live: a human asked "what observable state makes it addressed?" with no
// example to hand answered "The human who raised this confirms it is addressed." — the exact sentence
// recordHumanFinding's own comment forbids fabricating, and it satisfies every check a null one fails.
test('a pass condition that defers back to the human is refused like a missing one', t => {
  const { worktree } = reviewReadyFixture(t);
  const common = { sliceId: 'S1', file: 'value.js', lineStart: 1, lineEnd: 1 };

  assert.throws(
    () => recordHumanFinding(worktree, { ...common, claim: 'The lookup is unbounded.', passCondition: 'The human who raised this confirms it is addressed.' }),
    error => {
      assert.match(error.message, /observable/u, 'the refusal names what a pass condition has to be');
      return true;
    },
  );

  recordHumanFinding(worktree, { ...common, claim: 'The lookup is unbounded.' });
  assert.throws(
    () => setHumanFindingPassCondition(worktree, { sliceId: 'S1', passCondition: 'I agree it is fixed' }),
    /observable/u,
    'amending a draft is the same seam and takes the same guard',
  );
  setHumanFindingPassCondition(worktree, { sliceId: 'S1', passCondition: 'A timeout bounds the lookup.' });
  assert.equal(listHumanFindingDraft(worktree, 'work-override', 'S1')[0].pass_condition, 'A timeout bounds the lookup.');
});

test('a human finding refuses a missing or inverted line anchor instead of storing unusable evidence', t => {
  const { worktree } = reviewReadyFixture(t);

  assert.throws(
    () => recordHumanFinding(worktree, { sliceId: 'S1', file: 'value.js', claim: 'No line anchor given.' }),
    /line/iu,
    'a NaN anchor silently disables correction attribution instead of failing at write time',
  );
  assert.throws(
    () => recordHumanFinding(worktree, { sliceId: 'S1', file: 'value.js', lineStart: 3, lineEnd: 1, claim: 'Inverted range.' }),
    /line/iu,
  );
});
