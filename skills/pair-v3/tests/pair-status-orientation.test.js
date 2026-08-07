require('./helpers/isolate-machine-lease');

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  SLICE_ARC,
  adjudicationLines,
  blockedLines,
  dispatchLines,
  evidenceClosingLines,
  evidenceDiffLines,
  explainLines,
  failedRunLines,
  nextCommand,
  orientationLines,
  verificationLines,
} = require('../scripts/pair-cli');

// pair-cli already refuses to make a human translate a state name into a command (see its nextCommand
// comment). The other half was never built: status named the next command but never the position, so
// there was no way to answer "how far along is this slice, and what comes after" without reading the
// engine. A human driving nine slices asked that question repeatedly.
function state(overrides = {}) {
  return {
    lifecycle: 'ready',
    work_id: 'work-orientation',
    slices: [
      { id: 'S-01', status: 'accepted' },
      { id: 'S-02', status: 'review-ready' },
      { id: 'S-03', status: 'queued' },
    ],
    ...overrides,
  };
}

test('orientation marks the current step of the Review Slice arc and keeps the steps after it visible', () => {
  const next = { id: 'S-02', status: 'review-ready' };

  const lines = orientationLines(state(), next);
  const text = lines.join('\n');

  const marked = lines.filter(line => line.startsWith('  ►'));
  assert.equal(marked.length, 1, 'exactly one step is current');
  assert.match(marked[0], /review-ready/u);
  for (const step of ['queued', 'design-ready', 'awaiting-feedback', 'correction-ready', 'awaiting-human-review']) {
    assert.match(text, new RegExp(step, 'u'), `the arc names ${step}`);
  }
});

test('orientation reports how many Review Slices are done, in flight, and still queued', () => {
  const text = orientationLines(state(), { id: 'S-02', status: 'review-ready' }).join('\n');

  assert.match(text, /1 of 3 accepted/u);
  assert.match(text, /S-02 in flight/u);
  assert.match(text, /1 queued/u);
});

// post-diff-design is a named engine state reached by an ordinary Routine Path checkpoint whose diff
// escalated, so it must read as a step with a command, not as an anomaly. It was labelled "off the
// usual arc" the first time it occurred live, which is the dead end this view exists to prevent.
test('orientation names post-diff-design as a step between implementation and review', () => {
  const lines = orientationLines(state(), { id: 'S-02', status: 'post-diff-design' });

  const marked = lines.filter(line => line.startsWith('  ►'));
  assert.equal(marked.length, 1);
  assert.match(marked[0], /post-diff-design/u);
  assert.doesNotMatch(marked[0], /off the usual arc/u);
  // Order matters: the escalation is recorded before a fresh review can run, and runPostDiffDesign
  // moves the slice to review-ready afterwards.
  const text = lines.join('\n');
  assert.ok(text.indexOf('post-diff-design') < text.indexOf('review-ready'), 'it precedes review');
});

test('a status the arc does not know is appended rather than dropped', () => {
  const lines = orientationLines(state(), { id: 'S-02', status: 'blocked' });

  const marked = lines.filter(line => line.startsWith('  ►'));
  assert.equal(marked.length, 1, 'blocked is still marked as where you are');
  assert.match(marked[0], /blocked/u);
  assert.match(marked[0], /off the usual arc/u);
});

// Every other branch of nextCommand interpolates the operand it needs (`--slice ${next.id}`); the
// awaiting-feedback branch alone returned `--finding <id>`, and a finding id is a 24-hex content address
// that cannot be typed from memory or guessed. So a human holding their verdicts had to leave status and
// dig the ids out of the outcome JSON — they asked out loud how to send feedback in. pair-cli already
// states the opposite principle for the baseline flow: a test identity is printed verbatim because it is
// what the next command consumes, and a summarised one cannot be copied.
function adjudicationFixture(overrides = []) {
  const findings = [
    { finding_id: 'review-finding-723bffc0235b9211defc5259', severity: 'MAJOR', claim: 'what happens without this?', evidence: { path: 'src/Catalog/CatalogIndexSynchronizer.cs', line_start: 73, line_end: 73 } },
    { finding_id: 'review-finding-3a7b8375d4617212ffd9e843', severity: 'MAJOR', claim: 'FamilyKey2 is like product group, but 3 head digits has no meaning', evidence: { path: 'src/Catalog/CatalogProduct.cs', line_start: 47, line_end: 47 } },
    { finding_id: 'review-finding-0100205cb677ec2ca2e8f8f2', severity: 'MAJOR', claim: 'ca 100k products, any confidences about performance or timeout here', evidence: { path: 'src/Catalog/CatalogFacetProjection.cs', line_start: 28, line_end: 28 } },
  ];
  return findings.map((finding, index) => ({ ...finding, disposition: overrides[index] || null }));
}

test('adjudication prints a paste-ready command carrying the verbatim id of every unadjudicated finding', () => {
  const text = adjudicationLines('S-03', adjudicationFixture()).join('\n');

  for (const finding of adjudicationFixture()) {
    assert.match(text, new RegExp(`--finding ${finding.finding_id}`, 'u'), `${finding.finding_id} is offered verbatim`);
  }
  assert.doesNotMatch(text, /--finding <id>/u, 'a placeholder operand is what sent the human to the JSON');
  assert.match(text, /--disposition valid\|false-positive\|not-worth-fixing\|missing-context/u, 'the vocabulary stays on the line being pasted');
  // recordReviewFeedback refuses a second adjudication of the same finding and bounds the reason at 500
  // characters, so pasting a hasty reason is irreversible. A surface that invites the paste says so.
  assert.match(text, /final|refused/u, 'the one-shot nature of Review Feedback is stated where it is spent');
  assert.match(text, /500/u, 'the reason bound is stated before the reason is written');
});

test('adjudication names the anchor and claim of each finding, so the ids are distinguishable', () => {
  const text = adjudicationLines('S-03', adjudicationFixture()).join('\n');

  assert.match(text, /CatalogProduct\.cs:47/u);
  assert.match(text, /CatalogFacetProjection\.cs:28/u);
  assert.match(text, /100k products/u);
});

// adjudicateFinding returns early when findings remain (pair-engine.js), so a slice with 1 of 3 done
// looks identical to one with 0 of 3 — and the gate that holds the slice is invisible.
test('adjudication reports what remains and that the slice moves only when nothing does', () => {
  const lines = adjudicationLines('S-03', adjudicationFixture(['valid']));
  const text = lines.join('\n');

  assert.match(text, /2 of 3/u, 'partial progress is counted');
  assert.match(text, /valid/u, 'the disposition already recorded is shown');
  assert.doesNotMatch(text, /--finding review-finding-723bffc0235b9211defc5259/u, 'an adjudicated finding is not offered again — feedback is append-only and refuses a second');
  assert.match(text, /does not move|until every/u, 'the all-or-nothing gate is stated');
});

// This block renders only for a slice at awaiting-feedback, so "every finding is adjudicated" is not a
// normal resting state — the reducer moves the slice off awaiting-feedback the moment the last finding is
// adjudicated. Reaching it means the projection fell behind its own recorded evidence. advanceWork now
// repairs that, so the command named here is the ordinary transition the human already knows (and
// <leader>pn in nvim) rather than a repair verb they would have to discover.
test('a slice adjudicated in full but still awaiting feedback is named as a stale projection', () => {
  const text = adjudicationLines('S-03', adjudicationFixture(['valid', 'missing-context', 'not-worth-fixing'])).join('\n');

  assert.doesNotMatch(text, /--finding review-finding-/u, 'nothing is left to adjudicate');
  assert.match(text, /pair-loop run/u, 'the ordinary next transition repairs it');
  assert.match(text, /spends no correction|records nothing/u, 'and says that this particular run costs nothing');
  assert.match(text, /reconcile/u, 'the explicit repair stays discoverable for anyone who wants only that');
});

// A dirty-worktree block said "Next: inspect preserved worktree changes" and nothing else: nextCommand
// returns null for a blocked lifecycle, so the state that most needs instructions was the one state with
// none. It also does not say the thing that matters most — the block clears itself once the tree is clean,
// which no one can guess — nor which files are dirty, nor that an interrupted run is what usually leaves
// them. Observed live on S-04: an implementation session was killed after writing 11 files including an EF
// migration, leaving real work uncommitted, unattributed, and blocking the loop.
function blockedState() {
  return {
    lifecycle: 'blocked',
    work_id: 'work-blocked',
    blocked_reason: 'Pair worktree is dirty before Review Slice S-04-facet-names',
    // From the engine, never restated: this fixture first carried an invented value, so the test passed
    // against a precondition no real state ever sets and the guidance never rendered for a real block.
    blocked_precondition: require('../scripts/lib/pair-engine').DIRTY_WORKTREE_PRECONDITION,
    next_action: 'inspect preserved worktree changes',
    slices: [{ id: 'S-04-facet-names', status: 'blocked', blocked_from: 'design-ready' }],
  };
}

test('a dirty-worktree block names the files, the way back, and that it clears itself', () => {
  const dirty = [' M src/Catalog/CatalogFacet.cs', '?? src/Catalog/CatalogFacetNames.cs'];

  const text = blockedLines(blockedState(), dirty).join('\n');

  assert.match(text, /CatalogFacetNames\.cs/u, 'the human is told what is actually in the way');
  assert.match(text, /2 /u, 'and how much of it there is');
  assert.match(text, /clears itself|self-clear/u, 'the self-heal is stated, because it is not guessable');
  assert.match(text, /pair-loop run/u, 'the command that resumes once the tree is clean');
  assert.match(text, /pair-loop unblock --reason/u, 'and the recorded override for keeping the tree as it is');
  assert.match(text, /design-ready/u, 'the status it will resume into, so the human knows what run comes next');
});

// The work was real and uncommitted: an instruction that reads as "clean the tree" invites `git checkout .`
// and destroys a session's output. The commands offered must preserve it by default.
test('a dirty-worktree block never suggests discarding the changes as the first move', () => {
  const text = blockedLines(blockedState(), [' M src/Catalog/CatalogFacet.cs']).join('\n');

  assert.doesNotMatch(text, /checkout \.|reset --hard|clean -fd/u, 'no destructive command is offered');
  assert.match(text, /git stash|commit/u, 'the non-destructive ways to get a clean tree are named');
});

// This used to assert only that the reason rendered, on the view that naming a command here would be
// inventing one. It would not be: unblock restores an exhausted slice to correction-ready (engine-tested),
// and override-accept takes a checkpoint with the finding left open. So the single most likely block in the
// loop — the correction budget is one deep, and a second valid finding lands here — was also the only state
// that named nothing, and nextCommand returns null for a blocked lifecycle. Observed live on S-05.
function exhaustedState() {
  return {
    ...blockedState(),
    blocked_precondition: null,
    blocked_reason: 'Review Slice S-05-search-without-datahub exhausted its one correction',
    next_action: 'human correction required',
    slices: [{
      id: 'S-05-search-without-datahub',
      status: 'blocked',
      correction_count: 1,
      review_outcome_id: 'f'.repeat(24),
      checkpoint_commit: 'e'.repeat(40),
    }],
  };
}

test('an exhausted-correction block names both ways out instead of ending the arc', () => {
  const text = blockedLines(exhaustedState(), []).join('\n');

  assert.match(text, /exhausted its one correction/u);
  assert.match(text, /pair-loop show --slice S-05-search-without-datahub/u, 'reading the evidence again comes before choosing');
  assert.match(text, /pair-loop unblock --reason/u, 'granting one more bounded correction is a recorded decision');
  assert.match(text, /correction-ready/u, 'and it says what unblocking resumes into, which is not guessable');
  assert.match(text, /pair-loop accept --slice S-05-search-without-datahub --override --reason/u,
    'accepting with the finding left open is the other real way out');
  assert.doesNotMatch(text, /git stash/u, 'worktree advice would be noise here');
});

// The run that mattered most was the one status said nothing about. Observed live on S-05: a granted retry
// died on a transient API 529, the slice stayed correction-ready, and status answered "pair-loop run" as if
// nothing had happened. Having done exactly what they were told, the human saw no change in their findings
// and concluded the loop was broken. The failure was already in state.recent_invocations the whole time.
test('a failed run is reported by status instead of leaving the state looking untouched', () => {
  const failed = {
    lifecycle: 'ready',
    work_id: 'work-failed',
    slices: [{ id: 'S-05', status: 'correction-ready', review_outcome_id: 'f'.repeat(24), correction_count: 1 }],
    recent_invocations: [
      { kind: 'review', review_slice_id: 'S-05', output_tokens: 25861 },
      { kind: 'correction', review_slice_id: 'S-05', output_tokens: 0, failed: true, error: 'claude implementation invocation failed with status 1: API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment.' },
    ],
  };

  const text = failedRunLines(failed).join('\n');

  assert.match(text, /529 Overloaded/u, 'the reason the run failed is what the human needs first');
  assert.match(text, /correction/u, 'and which kind of run it was');
  assert.match(text, /spent no correction|no correction was spent/u, 'a failed run costs no budget, which is not guessable');
});

test('status stays quiet about invocations when the most recent one succeeded', () => {
  const fine = {
    lifecycle: 'ready',
    work_id: 'work-fine',
    slices: [{ id: 'S-05', status: 'review-ready' }],
    recent_invocations: [
      { kind: 'correction', review_slice_id: 'S-05', output_tokens: 0, failed: true, error: 'an older failure' },
      { kind: 'review', review_slice_id: 'S-05', output_tokens: 25861 },
    ],
  };

  assert.deepEqual(failedRunLines(fine), [], 'a failure the next run already recovered from is history, not a warning');
});

test('a block with no recognised shape still names the recorded way to clear it', () => {
  const other = { ...blockedState(), blocked_precondition: null, blocked_reason: 'Something no reducer anticipated', slices: [] };

  const text = blockedLines(other, []).join('\n');

  assert.match(text, /Something no reducer anticipated/u);
  assert.match(text, /pair-loop unblock --reason/u, 'every block has at least one way out, and it is never silence');
  assert.doesNotMatch(text, /git stash/u);
});

// Observed live: `dispatch pause` stopped a correction's verification tree, and because state.json is
// only written at the end of a run, status kept printing "Pair ready" and "Next: run one human-valid
// correction" for forty minutes. The human read that as a broken loop and went looking for a checkpoint
// diff that no paused run could ever have written.
test('status names a dispatch that is still in flight instead of reading as idle', () => {
  const lines = dispatchLines({ at: '2026-08-05T13:09:22.034Z', pid: 83671, paused: false });

  const text = lines.join('\n');
  assert.match(text, /83671/u, 'the process to look at is named');
  assert.match(text, /2026-08-05T13:09:22.034Z/u, 'how long it has been running is answerable');
  assert.match(text, /pair-loop dispatch status/u, 'there is a way to inspect it');
});

test('status says a paused dispatch is paused and names the one command that continues it', () => {
  const text = dispatchLines({ at: '2026-08-05T13:09:22.034Z', pid: 83671, paused: true }).join('\n');

  assert.match(text, /paused/iu);
  assert.match(text, /pair-loop dispatch continue/u, 'the way out is named, not left to be discovered');
  // The state on disk predates the paused run, so every "Next"/"Command" line below it is stale advice.
  assert.match(text, /state.*(?:predates|before|stale)/iu, 'it says why the lines below cannot be trusted');
});

test('status stays quiet about dispatch when no run is in flight', () => {
  assert.deepEqual(dispatchLines(null), []);
});

// The arc names seven states and one command each, which answers "what do I type" and never "what is
// this state, how did I land in it, and what ends it". Read live, in these words: "i dont understand the
// purpose of each state". A name plus an imperative is not an explanation, and the states most worth
// explaining are exactly the ones a human meets rarely — post-diff-design, and the two different problems
// that both present as correction-ready.
test('every state on the arc can be explained, not just commanded', () => {
  const text = explainLines().join('\n');

  for (const [status] of SLICE_ARC) {
    assert.match(text, new RegExp(status, 'u'), `${status} is explained`);
  }
  // A state is three questions, and the one that a terse arc can never answer is the middle one.
  assert.match(text, /How you get here/iu);
  assert.match(text, /What ends it/iu);
});

// The arc reads as a queue and is not one: a Routine Path checkpoint whose diff escalates nothing is
// accepted straight out of the implementation run and never visits review-ready at all. Someone counting
// seven steps and seeing three go by has to be told that is the design, not a skipped step.
test('the explanation says the arc is a map rather than a queue every slice walks', () => {
  const text = explainLines().join('\n');

  assert.match(text, /not a queue|does not walk|skip/iu);
  assert.match(text, /[Rr]outine/u, 'the route that skips review is named');
  assert.match(text, /architecture-sensitive/u, 'so is the one that does not');
});

// Two roads reach correction-ready and they are different problems: a deterministic verification failure
// (re-verification is free and may clear it outright) and a finding a human called valid. Spending the one
// correction on the first when `pair-loop verify` would have cleared it is the mistake this must prevent.
test('a state reached by more than one road explains each of them', () => {
  const text = explainLines('correction-ready').join('\n');

  assert.match(text, /verif/iu, 'the deterministic-failure road');
  assert.match(text, /valid/u, 'and the adjudicated-finding road');
  assert.match(text, /one/u, 'the budget is one deep and the explanation says so');
  assert.doesNotMatch(text, /queued/u, 'asking about one state answers about that state');
});

test('asking about a state that is not on the arc says so instead of printing nothing', () => {
  assert.throws(() => explainLines('not-a-state'), /not-a-state/u);
});

// Explaining every state at once is a wall; the human is standing in exactly one of them. Status carries
// the depth for where they are and points at the command for the rest.
test('orientation explains the state the Review Slice is actually in', () => {
  const text = orientationLines(state(), { id: 'S-02', status: 'review-ready' }).join('\n');

  assert.match(text, /spends no correction/u, 'the terse arc line stays');
  assert.match(text, /free/iu, 'and the current state gains what the arc line cannot say');
  assert.match(text, /pair-loop explain/u, 'the rest of the arc is one command away');
});

// `pair-loop show` is where a Design Check is read, and at design-ready the slice that owns one has no
// checkpoint. The view assumed it did: observed live on S-08, it printed `git ... diff fac593e7ec null`
// and closed with `pair-loop accept --slice S-08`, which answers "Review Slice is not awaiting human
// acceptance". A human who came to read a document was handed two commands that cannot run.
const SHORT = commit => (commit ? commit.slice(0, 10) : null);

test('evidence names no diff for a Review Slice that has neither committed nor attempted anything', () => {
  const text = evidenceDiffLines(
    { read_root: '/w', base_commit: 'fac593e7ec874e', checkpoint_commit: null, attempt_commit: null }, SHORT).join('\n');

  assert.doesNotMatch(text, /null/u, 'a missing commit is absence, not the string "null" inside a git command');
  assert.doesNotMatch(text, /git .*diff/u, 'and no diff is offered where none can be produced');
  assert.match(text, /nothing attempted/iu, 'it says why instead of going quiet');
});

test('evidence offers a diff as soon as there is a checkpoint to diff', () => {
  const text = evidenceDiffLines(
    { read_root: '/w', base_commit: 'aaaaaaaaaaaa', checkpoint_commit: 'bbbbbbbbbbbb' }, SHORT).join('\n');

  assert.match(text, /git -C \/w diff aaaaaaaaaa bbbbbbbbbb/u);
});

// A red Review Slice used to report "no diff to read" while the session's work sat uncommitted in the
// worktree, which is how a human ended up hunting a clean tree for a diff that was never going to be there.
test('evidence offers the unverified attempt when verification left no checkpoint', () => {
  const text = evidenceDiffLines(
    { read_root: '/w', base_commit: 'aaaaaaaaaaaa', checkpoint_commit: null, attempt_commit: 'cccccccccccc' }, SHORT).join('\n');

  assert.match(text, /git -C \/w diff aaaaaaaaaa cccccccccc/u, 'the attempt is a real commit and diffs like one');
  assert.match(text, /unverified attempt/iu, 'and it never passes for a checkpoint');
  assert.match(text, /cannot be accepted/iu);
});

test('evidence isolates what the last session changed once a second attempt exists', () => {
  const text = evidenceDiffLines({
    read_root: '/w',
    base_commit: 'aaaaaaaaaaaa',
    checkpoint_commit: null,
    attempt_commit: 'cccccccccccc',
    prior_attempt_commit: 'bbbbbbbbbbbb',
  }, SHORT).join('\n');

  assert.match(text, /Attempt only:\s+git -C \/w diff bbbbbbbbbb cccccccccc/u);
});

// Three roads leave a red correction-ready, and the surface named two. Asked live, twice, in these words:
// "how to move back one step/state, so that the pair-loop can do review again … currently in correction state
// but nothing to correct, and cant transition to next state as well". There is no backward transition — review
// needs a checkpoint and a checkpoint needs a green gate — so the road that fits is declaring the failures as
// not this Work's. Never naming it is what made the state read as a dead end.
test('a red correction-ready names the baseline as well as re-verify and correct', () => {
  const command = nextCommand(
    { lifecycle: 'ready' },
    { id: 'S-01', status: 'correction-ready', verification_failure: 'Failed EntityBoundAnswer' });

  assert.match(command, /pair-loop verify --slice S-01/u, 're-verification is still first: it spends no correction');
  assert.match(command, /pair-loop baseline/u, 'and the road for a failure this Work did not cause is named too');
});

test('a correction-ready held by a valid finding does not offer the baseline', () => {
  const command = nextCommand({ lifecycle: 'ready' }, { id: 'S-02', status: 'correction-ready' });

  assert.doesNotMatch(command, /baseline/u, 'no verification failed here, so there is nothing to declare pre-existing');
  assert.match(command, /pair-loop run/u);
});

function redReport(overrides = {}) {
  return {
    review_slice_id: 'S-01',
    command: 'dotnet test',
    status: 1,
    observed_status: 1,
    failing_tests: ['EntityBoundAnswer', 'Bundle_returns_a_zip_when_permitted'],
    baselined_failing_tests: [],
    introduced_failing_tests: ['EntityBoundAnswer', 'Bundle_returns_a_zip_when_permitted'],
    introduced_warnings: [],
    checkpoint_created: false,
    ...overrides,
  };
}

// A test identity is what `baseline add` consumes, and pair-cli already holds the principle that an operand
// the next command needs is printed verbatim rather than summarised. The identities were printed; the command
// that eats them was not, so the list read as a verdict instead of as the input to the way out.
test('a failed verification prints a paste-ready baseline command for each failure it owns', () => {
  const text = verificationLines(redReport()).join('\n');

  assert.match(text, /pair-loop baseline add --test EntityBoundAnswer --reason/u);
  assert.match(text, /pair-loop baseline add --test Bundle_returns_a_zip_when_permitted --reason/u);
});

// pair-engine only flips the gate when EVERY observed failure is baselined (applyKnownFailureBaseline). So
// baselining 20 of 23 changes nothing at all, and a human who did that would see an unchanged red gate with
// no explanation anywhere for why their declaration did not count.
test('a failed verification states that every failure must be declared before the gate turns', () => {
  const text = verificationLines(redReport()).join('\n');

  assert.match(text, /all|every/iu, 'the all-or-nothing rule is stated where the declaration is invited');
  assert.match(text, /2/u, 'and the count that has to be reached is visible');
});

test('a clean verification invites no baselining', () => {
  const text = verificationLines(redReport({
    status: 0, failing_tests: [], introduced_failing_tests: [],
  })).join('\n');

  assert.doesNotMatch(text, /baseline add/u, 'nothing failed, so there is nothing to declare');
});

test('evidence offers plain accept only where the engine actually admits it', () => {
  const text = evidenceClosingLines({ review_slice_id: 'S-07', status: 'awaiting-human-review', checkpoint_commit: 'abc' }).join('\n');

  assert.match(text, /pair-loop accept --slice S-07/u);
  assert.doesNotMatch(text, /--override/u, 'the state that admits acceptance needs no override');
});

test('evidence names the override form where plain accept would be refused', () => {
  const text = evidenceClosingLines({ review_slice_id: 'S-07', status: 'review-ready', checkpoint_commit: 'abc' }).join('\n');

  assert.match(text, /--override/u);
  assert.match(text, /--reason/u, 'an override without a reason is refused, so the reason is in the command offered');
  assert.match(text, /refused/u, 'and it says why the plain form is not on offer');
});

test('evidence offers no acceptance at all with no checkpoint behind it', () => {
  const text = evidenceClosingLines({ review_slice_id: 'S-08', status: 'design-ready', checkpoint_commit: null }).join('\n');

  assert.doesNotMatch(text, /pair-loop accept/u, 'accepting a slice with no checkpoint is structurally refused');
  assert.match(text, /pair-loop run/u, 'the command that produces one is named instead');
});

test('orientation reports the Work-level arc once every Review Slice is accepted', () => {
  const completing = state({
    lifecycle: 'completion-review-ready',
    slices: [{ id: 'S-01', status: 'accepted' }, { id: 'S-02', status: 'accepted' }],
  });

  const text = orientationLines(completing, null).join('\n');

  assert.match(text, /2 of 2 accepted/u);
  assert.match(text, /combined/iu, 'the remaining Work-level step is named');
});

// The self-drive hint exists because a human had to say "run it yourself" three times in one
// conversation: the assistant kept handing the printed command back instead of executing it.
test('orientation names this conversation as the loop driver when it runs inside an agent session', () => {
  const next = { id: 'S-02', status: 'review-ready' };

  const driving = orientationLines(state(), next, { agentSession: true }).join('\n');
  assert.match(driving, /drives the loop itself/u);

  const observing = orientationLines(state(), next, { agentSession: false }).join('\n');
  assert.doesNotMatch(observing, /drives the loop itself/u);
});
