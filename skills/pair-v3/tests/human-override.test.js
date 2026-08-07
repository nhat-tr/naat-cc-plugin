// Per-process machine scope: the real machine lease is global, and parallel test files would refuse
// each other's verifications. Required before the engine, so the env var is set when pair-store reads it.
require('./helpers/isolate-machine-lease');

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

// Every Work here opens with `humanLoop: true`: these tests ARE the human gates — a fresh review before
// acceptance, a finding waiting for a verdict, a checkpoint a person accepts — and the shipped default
// (an autonomous loop) drives straight past them. The default itself is asserted in autonomous-loop.test.js.

const {
  acceptHumanReview,
  adjudicateFinding,
  advanceWork,
  amendHumanFinding,
  correctionShape,
  dropHumanFindingDraft,
  humanFindingDrafts,
  openWork,
  recordCorrectionDirection,
  listHumanFindingDraft,
  recordHumanFinding,
  setHumanFindingPassCondition,
  submitHumanFindings,
  unblockWork,
} = require('../scripts/lib/pair-engine');
const { blobAtCommit, readEvents, readState } = require('../scripts/lib/pair-store');
const { feedbackForFinding, listReviewOutcomes } = require('../scripts/lib/review-evidence');

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

// A model finding anchored to the fixture's own checkpoint, for the cases that must keep telling a claim
// awaiting a verdict apart from one that arrived with it.
function modelFinding(root, overrides = {}) {
  const state = readState(root);
  const projected = state.slices[0];
  const lineStart = overrides.lineStart || 1;
  return {
    severity: 'MAJOR',
    claim: overrides.claim || 'The export is a bare literal with no lookup seam.',
    scenario: 'A second composition root cannot obtain its own value.',
    impact: 'Callers share one module-global value.',
    pass_condition: overrides.passCondition || 'Two independent roots each observe their own value.',
    evidence: {
      commit: projected.checkpoint_commit,
      path: 'value.js',
      blob: blobAtCommit(state.worktree, projected.checkpoint_commit, 'value.js'),
      line_start: lineStart,
      line_end: overrides.lineEnd || lineStart,
    },
  };
}

// Adjudication is the question "is this claim real?", and only a model finding leaves it open — a human
// finding arrives with the answer. So every case exercising adjudication mechanics, reconciliation, or the
// correction a valid finding earns is staged from a model review rather than from a human draft.
function awaitingFeedbackFixture(t, overrides = [{}]) {
  const { root, worktree } = reviewReadyFixture(t);
  advanceWork(worktree, { runtime: 'codex' }, {
    runProvider: () => providerResult({ verdict: 'findings', findings: overrides.map(item => modelFinding(root, item)) }),
  });
  const state = readState(root);
  const outcome = listReviewOutcomes(root, 'work-override').find(item => item.review_outcome_id === state.slices[0].review_outcome_id);
  return { root, worktree, outcome, findings: outcome.findings };
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
  const opened = openWork(root, { workId: 'work-override', specPath: spec, manifestPath: manifest, humanLoop: true });
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
  assert.equal(readState(root).slices[0].status, 'correction-ready', 'it reaches the same one correction a model finding does');
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
  // The fixture repo is one line long, so every finding here anchors it. These are separate concerns about
  // that line rather than re-drafts of one, which is exactly what allowSameAnchor declares.
  const common = { sliceId: 'S1', file: 'value.js', lineStart: 1, lineEnd: 1, allowSameAnchor: true };

  recordHumanFinding(worktree, { ...common, claim: 'The export is a bare literal with no lookup seam.' });
  recordHumanFinding(worktree, { ...common, claim: 'No timeout bounds the lookup.' });

  assert.equal(listReviewOutcomes(root, 'work-override').length, 0, 'a draft is not evidence yet');
  assert.equal(readState(root).slices[0].status, 'review-ready', 'the slice does not move while drafting');
  assert.equal(listHumanFindingDraft(worktree, 'work-override', 'S1').length, 2);
});

test('submitting a draft records exactly one Review Outcome carrying every finding', t => {
  const { root, worktree } = reviewReadyFixture(t);
  const common = { sliceId: 'S1', file: 'value.js', lineStart: 1, lineEnd: 1, allowSameAnchor: true, passCondition: 'Two roots each observe their own value.' };
  recordHumanFinding(worktree, { ...common, claim: 'The export is a bare literal with no lookup seam.' });
  recordHumanFinding(worktree, { ...common, claim: 'No timeout bounds the lookup.' });

  const submitted = submitHumanFindings(worktree, { sliceId: 'S1' });

  const outcomes = listReviewOutcomes(root, 'work-override');
  assert.equal(outcomes.length, 1, 'one outcome, so the Review Inbox cannot show a stale duplicate');
  assert.equal(outcomes[0].findings.length, 2);
  assert.equal(outcomes[0].reviewer.human, true);
  const state = readState(root);
  assert.equal(state.slices[0].review_outcome_id, submitted.outcome.review_outcome_id);
  assert.equal(state.slices[0].status, 'correction-ready');
  assert.equal(listHumanFindingDraft(worktree, 'work-override', 'S1').length, 0, 'the draft is cleared by submission');
});

test('a human review is not capped at the three findings a model review is bounded to', t => {
  const { root, worktree } = reviewReadyFixture(t);
  const common = { sliceId: 'S1', file: 'value.js', lineStart: 1, lineEnd: 1, allowSameAnchor: true, passCondition: 'Two roots each observe their own value.' };
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

// A pass condition was first a second prompt, then a copy of the claim. Both were the loop asking the human
// to restate what they had already written: the copy printed every finding twice under two headings, once as
// the claim and once as "passes when". A human raises the issue; working out what "addressed" looks like is
// the correcting session's job, and the claim is what it has to go on. So a pass condition is optional, and
// an unstated one is absent rather than an echo — stating one stays available for the finding that earns it.
test('a finding with no stated pass condition records none rather than an echo of its claim', t => {
  const { root, worktree } = reviewReadyFixture(t);

  recordHumanFinding(worktree, { sliceId: 'S1', file: 'value.js', lineStart: 1, lineEnd: 1, claim: 'The lookup is unbounded.' });
  const submitted = submitHumanFindings(worktree, { sliceId: 'S1' });

  assert.equal(submitted.outcome.findings[0].pass_condition, undefined, 'the claim is not repeated under a second heading');
  assert.equal(listReviewOutcomes(root, 'work-override').length, 1, 'one prompt is enough to reach the record');
  assert.equal(listHumanFindingDraft(worktree, 'work-override', 'S1').length, 0, 'the draft is cleared by submission');
});

// Every draft written while the claim WAS the default pass condition carries a copy of its own claim, and
// those drafts are still on disk in live Work. Reading one back must not resurrect the echo the surfaces
// above just stopped producing.
test('a draft carrying a pass condition identical to its claim reads back with the echo gone', t => {
  const { worktree } = reviewReadyFixture(t);

  recordHumanFinding(worktree, {
    sliceId: 'S1', file: 'value.js', lineStart: 1, lineEnd: 1,
    claim: 'The lookup is unbounded.', passCondition: 'The lookup is unbounded.',
  });

  assert.equal(listHumanFindingDraft(worktree, 'work-override', 'S1')[0].pass_condition, undefined);
  assert.equal(humanFindingDrafts(worktree)[0].findings[0].pass_condition, undefined);
});

// The 180-character claim bound is a token budget on what a MODEL review may emit — the same budget
// MODEL_FINDING_CAP bounds the count with, and the same carve-out a human count already has. A human typing
// into their editor is not spending it. Observed live: the fourth finding of a human review was 202
// characters of domain reasoning about when catalog data is synced, and the bound refused the WHOLE
// submission for it, after three other findings had already been drafted against the same checkpoint.
test('a human finding carries a claim longer than the budget a model review is held to', t => {
  const { worktree } = reviewReadyFixture(t);
  const claim = 'This does not seem correct, we deploy and start only when all needed data is synced. '
    + 'The assumption is that all cutting tools and metrology devices are synced and ready in the database '
    + 'before any Catalog Search can perform.';
  assert.ok(claim.length > 180 && claim.length <= 400, 'the live claim that was refused sits in this band');

  recordHumanFinding(worktree, { sliceId: 'S1', file: 'value.js', lineStart: 1, lineEnd: 1, claim });
  const submitted = submitHumanFindings(worktree, { sliceId: 'S1' });

  assert.equal(submitted.outcome.findings[0].claim, claim);
  // scenario and impact default to the claim, and each carried its own model-sized bound — so the same
  // finding failed three separate limits and the refusal only ever named the first.
  assert.equal(submitted.outcome.findings[0].impact, claim);
});

// Past even the human bound the refusal still stands, but it arrives at the gesture still holding the text
// and it names the length. Refusing at submission instead made a batch of four findings unsubmittable for
// one of them, at the one gesture that cannot edit anything.
test('an over-long claim is refused while it is drafted rather than when the review is submitted', t => {
  const { worktree } = reviewReadyFixture(t);

  assert.throws(
    () => recordHumanFinding(worktree, { sliceId: 'S1', file: 'value.js', lineStart: 1, lineEnd: 1, claim: 'x'.repeat(420) }),
    /420 characters.*400/su,
  );
  assert.equal(listHumanFindingDraft(worktree, 'work-override', 'S1').length, 0, 'nothing half-written is left behind');
});

// A draft was mutable for its pass condition and for nothing else, so a claim that was too long — or simply
// mistyped — could only be dropped and retyped from memory. Amending takes the same shape stating a pass
// condition does: an --index with no --file names a finding already drafted.
test('a drafted claim is amended in place, so fixing one never costs the finding', t => {
  const { worktree } = reviewReadyFixture(t);
  const common = { sliceId: 'S1', file: 'value.js', lineStart: 1, lineEnd: 1, allowSameAnchor: true };
  recordHumanFinding(worktree, { ...common, claim: 'The lookup is unbounded.' });
  recordHumanFinding(worktree, { ...common, claim: 'The index is rebuit per reqest.' });

  amendHumanFinding(worktree, { sliceId: 'S1', claim: 'The index is rebuilt per request.' });

  const findings = listHumanFindingDraft(worktree, 'work-override', 'S1');
  assert.equal(findings.length, 2, 'amending replaces a finding rather than adding a second copy');
  assert.equal(findings[0].claim, 'The lookup is unbounded.', 'no index means the finding just drafted');
  assert.equal(findings[1].claim, 'The index is rebuilt per request.');
  // scenario and impact defaulted to the old claim, so leaving them behind would record the typo anyway.
  assert.equal(findings[1].scenario, 'The index is rebuilt per request.');
  assert.equal(findings[1].impact, 'The index is rebuilt per request.');
});

// The engine gesture is only half of it: what a human types is `--index <n> --text`, and a --text with no
// --file used to fall through to "finding requires --file and --line" — the refusal for a gesture nobody
// made. Driven through the CLI's own dispatch, because that is the surface the keymap and the shell reach.
test('the CLI routes an --index with no --file to rewording, not to drafting', t => {
  const { worktree } = reviewReadyFixture(t);
  const { main } = require('../scripts/pair-cli');
  recordHumanFinding(worktree, { sliceId: 'S1', file: 'value.js', lineStart: 1, lineEnd: 1, claim: 'The lookup is unbouned.' });
  const previous = process.cwd();
  t.after(() => { process.chdir(previous); process.exitCode = 0; });
  process.chdir(worktree);

  main(['finding', '--slice', 'S1', '--index', '1', '--text', 'The lookup is unbounded.']);

  assert.ok(!process.exitCode, 'the route exists, so nothing is refused');
  const findings = listHumanFindingDraft(worktree, 'work-override', 'S1');
  assert.equal(findings.length, 1, 'the reworded claim replaces the finding rather than drafting a second');
  assert.equal(findings[0].claim, 'The lookup is unbounded.');
});

// The human wrote the finding. Asking them to then declare it valid — with a reason, once per finding, in
// a different buffer — is the reducer asking a person to adjudicate themselves, which acceptHumanReview
// already refuses to do for an override ("the reducer second-guessing the decision it was just told to
// yield"). Observed live: five gestures and two buffers stood between typing a finding and spending the
// correction on it. Submission is the human's verdict, so it records the verdict.
test('submitting a human draft is itself the verdict and lands the slice on the one correction', t => {
  const { root, worktree } = reviewReadyFixture(t);
  const common = { sliceId: 'S1', file: 'value.js', lineStart: 1, lineEnd: 1, allowSameAnchor: true };
  recordHumanFinding(worktree, { ...common, claim: 'The export is a bare literal with no lookup seam.' });
  recordHumanFinding(worktree, { ...common, claim: 'No timeout bounds the lookup.' });

  const submitted = submitHumanFindings(worktree, { sliceId: 'S1' });

  const state = readState(root);
  assert.equal(state.slices[0].status, 'correction-ready', 'no second pass over the same findings');
  assert.equal(state.lifecycle, 'ready');
  assert.match(state.next_action, /correction/u);
  // The audit trail is not skipped, only authored: every finding carries real Review Feedback, so
  // acceptHumanReview's per-finding gate and the Review Guidance bank both still see a disposition.
  for (const finding of submitted.outcome.findings) {
    const feedback = feedbackForFinding(root, 'work-override', finding.finding_id);
    assert.equal(feedback.length, 1, 'each finding is adjudicated exactly once');
    assert.equal(feedback[0].disposition, 'valid');
    assert.match(feedback[0].reason, /human/iu, 'the record says whose verdict this is');
  }
});

// A model finding is a claim awaiting a verdict; a human finding arrives with one. Auto-adjudication must
// not leak across that line, or the human loses the only gesture that can call a model wrong.
test('a model finding still waits for the human verdict that a human finding arrives with', t => {
  const { root, worktree } = reviewReadyFixture(t);

  advanceWork(worktree, {}, { runProvider: () => providerResult({ verdict: 'findings', findings: [modelFinding(root)] }) });

  const state = readState(root);
  assert.equal(state.slices[0].status, 'awaiting-feedback');
  assert.match(state.next_action, /adjudicate/u);
});

// A correcting provider that produces a fresh green checkpoint, so a round of review can be followed by
// another round reading the checkpoint the correction produced.
function correctionRun(value) {
  return {
    runProvider(input) {
      fs.writeFileSync(path.join(input.root, 'value.js'), [`module.exports = ${value};`, ...Array.from({ length: 39 }, (_item, index) => `// line ${index + 2}`)].join('\n') + '\n');
      return providerResult({
        status: 'completed', architecture_risk: null, design_check: null,
        failure_proof: { boundary: 'module export', method: 'unit', negative_control: 'Returning 1 fails the verification.' }, blocker: null,
      });
    },
    verify() { return { status: 0, stdout: '', stderr: '', durationMs: 1 }; },
  };
}

// The one-correction budget bounds a MODEL loop: a fresh reviewer can always find something, so
// find → correct → find → correct never terminates on its own. A human review is not that loop. Observed
// live on S-08: round one's finding was corrected, the human read the checkpoint the correction produced,
// raised one more finding against it, and the submission blocked on "exhausted its one correction" —
// asking them to justify a second correction with `unblock --reason` one gesture after they had typed the
// finding that says why. Writing and submitting a finding against a new checkpoint IS that deliberation.
test('a second round of human findings on the corrected checkpoint earns its correction without an unblock', t => {
  const { root, worktree } = reviewReadyFixture(t);
  recordHumanFinding(worktree, { sliceId: 'S1', file: 'value.js', lineStart: 1, lineEnd: 1, claim: 'The lookup is unbounded.' });
  submitHumanFindings(worktree, { sliceId: 'S1' });
  advanceWork(worktree, { runtime: 'codex' }, correctionRun(3));
  const corrected = readState(root).slices[0];
  assert.equal(corrected.correction_count, 1, 'round one spent the budget');
  assert.equal(corrected.status, 'awaiting-human-review', 'a corrected checkpoint comes back to the human, which is where round two starts');

  recordHumanFinding(worktree, { sliceId: 'S1', file: 'value.js', lineStart: 2, lineEnd: 2, claim: 'What about multi-language? The app ships English and German.' });
  submitHumanFindings(worktree, { sliceId: 'S1' });

  const state = readState(root);
  assert.equal(state.slices[0].status, 'correction-ready', 'the human writing the finding is the grant unblock would have asked for');
  assert.equal(state.lifecycle, 'ready');
  assert.ok(!state.blocked_reason, 'nothing is blocked, so nothing has to be justified twice');
  assert.match(state.next_action, /correction/u);
});

// The other half of the same rule: nothing here loosens the bound on a MODEL finding once the correction is
// spent. A corrected checkpoint returns to awaiting-human-review rather than to a second model review, so
// the spent budget is written directly — what is pinned is the rule, not a route the reducer walks today.
test('a model finding still blocks once the correction is spent, because that loop has no human in it', t => {
  const { root, worktree, findings } = awaitingFeedbackFixture(t);
  const state = readState(root);
  state.slices[0].correction_count = 1;
  require('../scripts/lib/pair-store').writeState(root, 'work-override', state);

  adjudicateFinding(worktree, { findingId: findings[0].finding_id, disposition: 'valid', reason: 'The seam is missing.' });

  const after = readState(root);
  assert.equal(after.slices[0].status, 'blocked');
  assert.match(after.blocked_reason, /exhausted its one correction/u);
});

// A correction that fails its OWN verification is the case the budget was written for, and it is untouched:
// the model could not do it, and a second automatic attempt at the same thing is the runaway the bound exists
// to stop — whoever raised the finding.
test('a human-raised correction that fails verification still blocks rather than retrying itself', t => {
  const { root, worktree } = reviewReadyFixture(t);
  recordHumanFinding(worktree, { sliceId: 'S1', file: 'value.js', lineStart: 1, lineEnd: 1, claim: 'The lookup is unbounded.' });
  submitHumanFindings(worktree, { sliceId: 'S1' });

  advanceWork(worktree, { runtime: 'codex' }, {
    runProvider: () => providerResult({
      status: 'completed', architecture_risk: null, design_check: null,
      failure_proof: { boundary: 'module export', method: 'unit', negative_control: 'Returning 1 fails.' }, blocker: null,
    }),
    verify() { return { status: 1, stdout: '', stderr: 'Expected: 2 But was: 1', durationMs: 1 }; },
  });

  const state = readState(root);
  assert.equal(state.slices[0].status, 'blocked');
  assert.match(state.blocked_reason, /failed after its one bounded correction/u);
});

test('a pass condition is stated on a draft in place, so a refused submission is completed not duplicated', t => {
  const { worktree } = reviewReadyFixture(t);
  const common = { sliceId: 'S1', file: 'value.js', lineStart: 1, lineEnd: 1, allowSameAnchor: true };
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
  const { root, worktree, findings } = awaitingFeedbackFixture(t, [
    { claim: 'First concern.' },
    { claim: 'Second concern.', lineStart: 2 },
    { claim: 'Third concern.', lineStart: 3 },
  ]);
  assert.match(readState(root).next_action, /3 finding\(s\)/u);

  adjudicateFinding(worktree, { findingId: findings[0].finding_id, disposition: 'valid', reason: 'The lookup seam is genuinely missing.' });

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
  const { root, worktree, findings } = awaitingFeedbackFixture(t);
  const { operate } = require('../scripts/pair-review');

  operate(worktree, 'feedback', {
    work: 'work-override',
    finding: findings[0].finding_id,
    disposition: 'valid',
    reason: 'The seam is genuinely missing.',
  });

  const state = readState(root);
  assert.equal(state.slices[0].status, 'correction-ready', 'the editor path reaches the same status the shell path does');
  assert.equal(state.lifecycle, 'ready');
  assert.match(state.next_action, /correction/u);
});

test('a Review Slice whose projection fell behind its recorded feedback is reconciled, not wedged', t => {
  const { root, worktree, findings } = awaitingFeedbackFixture(t);
  const { reconcileAdjudication } = require('../scripts/lib/pair-engine');
  const { recordReviewFeedback } = require('../scripts/lib/review-evidence');
  // Exactly the wedge: durable feedback, untouched projection, and no second feedback possible.
  recordReviewFeedback(worktree, {
    workId: 'work-override',
    findingId: findings[0].finding_id,
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
  const { root, worktree, findings } = awaitingFeedbackFixture(t);
  const { recordReviewFeedback } = require('../scripts/lib/review-evidence');
  recordReviewFeedback(worktree, {
    workId: 'work-override',
    findingId: findings[0].finding_id,
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
  const { root, worktree, findings } = awaitingFeedbackFixture(t, [{ passCondition: 'Two roots each observe their own value.' }]);
  const { correctionBrief } = require('../scripts/lib/pair-engine');
  adjudicateFinding(worktree, { findingId: findings[0].finding_id, disposition: 'valid', reason: 'The seam is missing.' });
  recordCorrectionDirection(worktree, { sliceId: 'S1', text: 'Bound the fix to the lookup seam only.' });

  const brief = correctionBrief(worktree, { sliceId: 'S1' });

  assert.equal(brief.review_slice_id, 'S1');
  assert.match(brief.prompt, /Two roots each observe their own value/u, 'the pass condition it must satisfy is visible');
  assert.match(brief.prompt, /The seam is missing/u, 'the adjudication reason that steers it is visible');
  assert.match(brief.prompt, /lookup seam only/u, 'so is the Correction Direction, before it is spent');
  assert.equal(readState(root).slices[0].status, 'correction-ready', 'reading the brief changes nothing');
});

// With no pass condition stated the corrector still has to be told what "addressed" means, and the claim is
// what it has. The instruction said "satisfies each pass condition", which now points at an absent field.
test('the correction brief falls back to the claim as done-ness when no pass condition is stated', t => {
  const { worktree } = reviewReadyFixture(t);
  const { correctionBrief } = require('../scripts/lib/pair-engine');
  recordHumanFinding(worktree, { sliceId: 'S1', file: 'value.js', lineStart: 1, lineEnd: 1, claim: 'The lookup is unbounded.' });
  submitHumanFindings(worktree, { sliceId: 'S1' });

  const brief = correctionBrief(worktree, { sliceId: 'S1' });

  assert.match(brief.prompt, /The lookup is unbounded/u, 'the claim travels as the statement of done-ness');
  assert.match(brief.prompt, /satisfies each finding's claim/u, 'and the instruction points at it');
});

// Every valid finding goes into the one correction and the corrector is told to satisfy all of them, but
// nothing afterwards said whether it did. With a placeholder pass condition there is nothing to check
// mechanically either — so the loop reports the one fact it can establish from evidence: whether the
// correction opened the file each finding is anchored to. A file the correction never touched cannot
// contain a fix, which is the half of this that is proof.
test('slice evidence reports whether the correction touched each valid finding', t => {
  const { root, worktree, findings } = awaitingFeedbackFixture(t);
  const { sliceEvidence } = require('../scripts/lib/pair-engine');
  fs.writeFileSync(path.join(worktree, 'other.js'), 'module.exports = 3;\n');
  adjudicateFinding(worktree, { findingId: findings[0].finding_id, disposition: 'valid', reason: 'The seam is missing.' });

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

// A finding raised AFTER the last correction ran has not been attempted by anything, and comparing it to
// that correction's diff answers a question nobody asked. Observed live: a human finding submitted while the
// correction carrying it was still in flight was reported "cannot have been addressed" against the PREVIOUS
// correction — and that next correction did change the exact file the finding anchors. Attribution is a fact
// about hunks; whether a correction has even been attempted is a fact about order, and it comes first.
test('a finding raised after the last correction is reported as awaiting one, not as unaddressed', t => {
  const { worktree, findings } = awaitingFeedbackFixture(t);
  const { sliceEvidence } = require('../scripts/lib/pair-engine');
  adjudicateFinding(worktree, { findingId: findings[0].finding_id, disposition: 'valid', reason: 'The seam is missing.' });
  advanceWork(worktree, { runtime: 'codex' }, {
    runProvider(input) {
      fs.writeFileSync(path.join(input.root, 'other.js'), 'module.exports = 4;\n');
      return providerResult({ status: 'completed', architecture_risk: null, design_check: null, failure_proof: { boundary: 'module export', method: 'unit', negative_control: 'Returning 3 fails.' }, blocker: null });
    },
    verify() { return { status: 0, stdout: '', stderr: '', durationMs: 1 }; },
  });

  // The human reads the corrected checkpoint and raises something new against it.
  recordHumanFinding(worktree, { sliceId: 'S1', file: 'value.js', lineStart: 1, lineEnd: 1, claim: 'A tool can reference the same service many times.' });
  submitHumanFindings(worktree, { sliceId: 'S1' });
  const evidence = sliceEvidence(worktree, { sliceId: 'S1' });

  assert.equal(evidence.findings[0].awaiting_correction, true);
  assert.equal(evidence.findings[0].correction, null, 'no correction is attributed to a finding no correction has seen');
});

// "changed this file" is too coarse to review a correction with: a file can change 24 lines and none of
// them near the anchored line, and the diff mixes what the findings asked for with what the corrector
// decided on its own. Findings carry exact line anchors and the diff carries exact hunk ranges, so the
// split is derivable: hunks overlapping an anchor belong to that finding, and everything else is scope
// nobody asked for and must be reviewed as such.
test('a correction is attributed hunk by hunk to the finding that asked for it', t => {
  const { worktree, findings } = awaitingFeedbackFixture(t);
  const { sliceEvidence } = require('../scripts/lib/pair-engine');
  adjudicateFinding(worktree, { findingId: findings[0].finding_id, disposition: 'valid', reason: 'The seam is missing.' });

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
  const { worktree, findings } = awaitingFeedbackFixture(t);
  const { sliceEvidence } = require('../scripts/lib/pair-engine');
  adjudicateFinding(worktree, { findingId: findings[0].finding_id, disposition: 'valid', reason: 'The seam is missing.' });

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
  const { root, worktree, findings } = awaitingFeedbackFixture(t);
  const { recordReviewFeedback } = require('../scripts/lib/review-evidence');
  recordReviewFeedback(worktree, {
    workId: 'work-override',
    findingId: findings[0].finding_id,
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
  const opened = openWork(root, { workId: 'work-unblock', specPath: spec, manifestPath: manifest, humanLoop: true });
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

// Granting a retry is one of two ways out of an exhausted correction; accepting the checkpoint with the
// finding left open is the other, and it is the right one when the finding is hygiene on a green checkpoint.
// acceptSlice sets lifecycle straight to ready without clearing what made the Work blocked, so the accepted
// state kept a blocked_reason naming a slice that had already moved on — invisible in status, which renders
// that reason only while the lifecycle is blocked, and misleading to anything that reads state.json since
// (a handover, a later session).
test('accepting a blocked checkpoint by override leaves no block recorded behind it', t => {
  const { root, worktree } = reviewReadyFixture(t);
  const state = readState(root);
  state.lifecycle = 'blocked';
  state.blocked_reason = 'Review Slice S1 exhausted its one correction';
  state.next_action = 'human correction required';
  state.slices[0].status = 'blocked';
  state.slices[0].correction_count = 1;
  require('../scripts/lib/pair-store').writeState(root, 'work-override', state);

  // Verification is injected so the fixture's only slice can complete: a real cumulative failure blocks
  // again with its own accurate reason, which would hide whether the old one was ever cleared.
  acceptHumanReview(
    worktree,
    { sliceId: 'S1', override: true, reason: 'Naming and lint hygiene on a green checkpoint; not worth a second correction.' },
    { verify: () => ({ status: 0, duration_ms: 1 }) },
  );

  const after = readState(root);
  assert.equal(after.slices[0].status, 'accepted');
  assert.notEqual(after.lifecycle, 'blocked', 'accepting clears the Work-level block');
  assert.ok(!after.blocked_reason, 'and the reason it was blocked, which no longer describes anything');
  assert.ok(!after.blocked_precondition);
});

// Drafting printed the draft once, as transient output, and nothing read the draft directory afterwards —
// not status, not show, not the Review Inbox. So a human gathering findings while reading could not see
// what they had gathered, and re-drafting the same claim looked like the only way forward. Observed live:
// one slice held two drafts of the same claim because the first was invisible.
test('an unsubmitted draft is listed so it is read back before a submission is spent on it', t => {
  const { worktree } = reviewReadyFixture(t);
  const common = { sliceId: 'S1', file: 'value.js', lineStart: 1, lineEnd: 1, allowSameAnchor: true };
  recordHumanFinding(worktree, { ...common, claim: 'The lookup is unbounded.' });
  recordHumanFinding(worktree, { ...common, claim: 'The index is rebuilt per request.', passCondition: 'The index is built once per process.' });

  const drafts = humanFindingDrafts(worktree, 'work-override');

  assert.equal(drafts.length, 1, 'one draft per Review Slice, not one per finding');
  assert.equal(drafts[0].review_slice_id, 'S1');
  assert.equal(drafts[0].findings.length, 2);
  assert.deepEqual(
    drafts[0].findings.map(finding => finding.pass_condition),
    [undefined, 'The index is built once per process.'],
    'a pass condition appears only where one was worth typing — an unstated one is absent, not an echo',
  );
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

// Making the duplicate visible was not enough to stop it. Observed live: the same anchor was drafted three
// times — file and line identical, claim reworded each time — because every refusal named a problem and
// handed back a shell command, so the next gesture the human made was the only one bound to a key. A second
// finding at an anchor that already has one is a re-draft far more often than it is a second concern, so it
// is refused where it is made, and the refusal names both ways forward instead of just the problem.
test('a second drafted finding at an anchor that already has one is refused as a re-draft', t => {
  const { worktree } = reviewReadyFixture(t);
  const common = { sliceId: 'S1', file: 'value.js', lineStart: 1, lineEnd: 1 };
  recordHumanFinding(worktree, { ...common, claim: 'The lookup is unbounded.' });

  assert.throws(
    () => recordHumanFinding(worktree, { ...common, claim: 'Reworded: the lookup has no timeout.' }),
    error => {
      assert.match(error.message, /already/u);
      assert.match(error.message, /--index 1 --text/u, 'the refusal names how to reword the finding already there');
      assert.match(error.message, /--drop/u, 'and how to discard it, since a draft is the mutable half');
      assert.match(error.message, /--allow-same-anchor/u, 'and how to say this really is a second concern');
      return true;
    },
  );
  assert.equal(listHumanFindingDraft(worktree, 'work-override', 'S1').length, 1, 'the re-draft is not appended');
});

test('a genuinely separate concern at the same anchor is drafted when it is declared as one', t => {
  const { worktree } = reviewReadyFixture(t);
  const common = { sliceId: 'S1', file: 'value.js', lineStart: 1, lineEnd: 1 };
  recordHumanFinding(worktree, { ...common, claim: 'The lookup is unbounded.' });

  recordHumanFinding(worktree, { ...common, claim: 'The export is a bare literal.', allowSameAnchor: true });

  assert.equal(listHumanFindingDraft(worktree, 'work-override', 'S1').length, 2);
});

// A draft is the mutable half of review by design — "a draft may be half-written; a Review Outcome may not"
// — but it had no way to retract anything, so the only route out of three duplicates was to submit all
// three and disposition two away. That writes the duplicates into the immutable record and into the Review
// Guidance bank, which is exactly what keeping the draft separate exists to prevent.
test('a drafted finding is dropped so duplicates never reach the immutable record', t => {
  const { worktree } = reviewReadyFixture(t);
  const common = { sliceId: 'S1', file: 'value.js', lineStart: 1, lineEnd: 1 };
  recordHumanFinding(worktree, { ...common, claim: 'Keep this one.' });
  recordHumanFinding(worktree, { ...common, claim: 'Drop this one.', allowSameAnchor: true });

  const result = dropHumanFindingDraft(worktree, { sliceId: 'S1', index: 2 });

  assert.equal(result.dropped.claim, 'Drop this one.', 'the refusal-free path names what it discarded');
  assert.deepEqual(listHumanFindingDraft(worktree, 'work-override', 'S1').map(item => item.claim), ['Keep this one.']);
  assert.throws(() => dropHumanFindingDraft(worktree, { sliceId: 'S1', index: 4 }), /1-1/u);

  dropHumanFindingDraft(worktree, { sliceId: 'S1', index: 1 });
  assert.equal(listHumanFindingDraft(worktree, 'work-override', 'S1').length, 0, 'dropping the last one leaves no empty draft behind');
  assert.equal(humanFindingDrafts(worktree, 'work-override').length, 0, 'and status stops reporting a draft that holds nothing');
});

// Observed live on S-05: a correction renamed 9 tests, and the human opened the whole-slice diff to check it
// and reported "no new changes". They were right about what they saw — the slice CREATED that test file, so
// in base..checkpoint it is one +110 block and a rename inside it is not a delta at all. The whole-slice diff
// structurally cannot show a correction to a file the slice introduced. The shape of the correction answers
// "did it do anything" without opening any diff, and it comes free from hunks already parsed.
test('the shape of a correction is reported so it never has to be hunted for in the cumulative diff', () => {
  const files = new Map([
    ['tests/Fitness.cs', [
      { old_start: 26, old_lines: 1, new_start: 26, new_lines: 1 },
      { old_start: 32, old_lines: 1, new_start: 32, new_lines: 2 },
    ]],
    ['src/Router.cs', [{ old_start: 10, old_lines: 0, new_start: 11, new_lines: 4 }]],
  ]);

  const shape = correctionShape(files);

  assert.equal(shape.file_count, 2);
  assert.equal(shape.hunk_count, 3);
  assert.equal(shape.lines_added, 7, 'new_lines summed, so a pure insertion counts');
  assert.equal(shape.lines_removed, 2, 'old_lines summed, and a 0 does not become 1 here');
});

test('a checkpoint with no prior checkpoint reports no correction shape rather than an empty one', () => {
  assert.equal(correctionShape(null), null, 'a first implementation checkpoint corrected nothing');
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
