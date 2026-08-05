require('./helpers/isolate-machine-lease');

const assert = require('node:assert/strict');
const test = require('node:test');

const { adjudicationLines, blockedLines, orientationLines } = require('../scripts/pair-cli');

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

test('a block that is not about the worktree still gets its reason and no invented command', () => {
  const other = { ...blockedState(), blocked_precondition: null, blocked_reason: 'Review Slice S-02 exhausted its one correction' };

  const text = blockedLines(other, []).join('\n');

  assert.match(text, /exhausted its one correction/u);
  assert.doesNotMatch(text, /git stash/u, 'worktree advice would be noise here');
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
