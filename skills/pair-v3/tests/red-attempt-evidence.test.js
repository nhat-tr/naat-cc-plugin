// A Review Slice whose verification is red has produced real code and, until now, no way to read it: the
// checkpoint commit is the only reviewable anchor and it is only ever written on green. These tests pin the
// three ways that stranded a human mid-loop — a diagnostic that named a build warning instead of the
// failing tests, an output cap that discarded a schema-compliant session, and an attempt with no diff.

// Per-process machine scope: the real machine lease is global, and parallel test files would refuse
// each other's verifications. Required before the engine, so the env var is set when pair-store reads it.
require('./helpers/isolate-machine-lease');

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  REVIEW_OUTPUT_LIMIT_BYTES,
  SLICE_OUTPUT_LIMIT_BYTES,
  acceptHumanReview,
  advanceWork,
  sliceEvidence,
  verificationCommand,
} = require('../scripts/lib/pair-engine');
const { readEvents, readState } = require('../scripts/lib/pair-store');
const { completedSlice, openTestWork, providerResult } = require('./helpers/warm-work');

// The line NuGet emitted on the run that exposed this: it is a warning, and it contains the word "Error"
// in its own message text, which is what let it pass for the failure.
const NUGET_WARNING = '/src/Paragon.Core/Paragon.Core.csproj : warning NU1900: '
  + 'Error occurred while getting package vulnerability data: Permission denied (localhost:58969)';

function shell(lines) {
  return lines.join('\n');
}

// Observed live on S-01-one-article-purpose-bounded: 23 tests failed, and the diagnostic recorded into
// state.json was the NuGet warning above. The correcting session was then handed that warning as the claim
// of what to fix, could not fix it, and the slice blocked — twice.
test('Verification diagnostic names the failing tests when the build tool warns on stderr', () => {
  const result = verificationCommand(shell([
    `echo '${NUGET_WARNING}' 1>&2`,
    "echo '  Failed GetArticle_asks_for_every_section_when_the_purpose_is_full [181 ms]'",
    "echo '  Failed AttributeEmphasis_highlights_the_named_attribute_on_the_glance_card [171 ms]'",
    "echo 'Failed!  - Failed:    23, Passed:   422, Skipped:     0, Total:   445'",
    'exit 1',
  ]), process.cwd());

  assert.equal(result.status, 1);
  assert.match(result.diagnostic, /GetArticle_asks_for_every_section_when_the_purpose_is_full/,
    'the failing tests are on stdout, and stdout is where a test runner always speaks');
  assert.doesNotMatch(result.diagnostic, /NU1900/,
    'a warning is by definition not the failure, so it can never be the reported one');
});

test('Verification diagnostic keeps a real stderr error above the stdout tail', () => {
  const result = verificationCommand(shell([
    `echo '${NUGET_WARNING}' 1>&2`,
    "echo '/src/Article/ArticleTools.cs(31,9): error CS1002: ; expected' 1>&2",
    "echo 'Build FAILED.'",
    'exit 1',
  ]), process.cwd());

  assert.match(result.diagnostic, /error CS1002/, 'a coded error still outranks everything around it');
  assert.doesNotMatch(result.diagnostic, /NU1900/);
});

// The diagnostic's only consumer is a correcting session's prompt, and colour codes spend its 500-byte
// budget without carrying meaning. Observed on the same run: `[39;49m[38;5;9m  Failed [39;49mEntityBoundAnswer`.
test('Verification diagnostic carries no terminal colour codes into the prompt', () => {
  const result = verificationCommand(shell([
    "printf '\\033[31m  Failed EntityBoundAnswer [25 ms]\\033[0m\\n'",
    'exit 1',
  ]), process.cwd());

  assert.match(result.diagnostic, /Failed EntityBoundAnswer/u);
  assert.doesNotMatch(result.diagnostic, /\[/u, 'an escape sequence is budget spent on nothing');
});

test('Verification diagnostic falls back to the output tail when nothing announces a failure', () => {
  const result = verificationCommand(shell(["echo 'silent stop'", 'exit 3']), process.cwd());

  assert.equal(result.status, 3);
  assert.match(result.diagnostic, /silent stop/, 'the tail is the best remaining evidence');
});

// The widest instance each schema admits, written out by hand so the assertion is independent of however
// the cap is derived. A cap below this number discards a session for obeying its own instructions —
// observed live: a correction returned 2202 bytes against a 2048-byte cap and its work was thrown away.
test('Structured-output cap admits the widest slice result its schema permits', () => {
  const widest = {
    status: 'design-required',
    architecture_risk: 'r'.repeat(240),
    design_check: {
      seam: 's'.repeat(180),
      ownership: 'o'.repeat(180),
      runtime: 'u'.repeat(180),
      contract: 'c'.repeat(180),
      alternative: 'a'.repeat(180),
      proof: 'p'.repeat(180),
    },
    failure_proof: { boundary: 'b'.repeat(300), method: 'base-reproduction', negative_control: 'n'.repeat(400) },
    blocker: 'k'.repeat(500),
  };
  const bytes = Buffer.byteLength(JSON.stringify(widest), 'utf8');

  assert.ok(bytes <= SLICE_OUTPUT_LIMIT_BYTES,
    `a schema-compliant slice result of ${bytes} bytes must survive a ${SLICE_OUTPUT_LIMIT_BYTES}-byte cap`);
});

test('Structured-output cap admits the widest review result its schema permits', () => {
  const finding = () => ({
    severity: 'BLOCKER',
    claim: 'c'.repeat(180),
    scenario: 's'.repeat(240),
    evidence: { commit: 'a'.repeat(64), path: 'p'.repeat(240), blob: 'b'.repeat(64), line_start: 1, line_end: 40 },
    impact: 'i'.repeat(180),
    pass_condition: 'q'.repeat(240),
  });
  const widest = { verdict: 'findings', findings: [finding(), finding(), finding()] };
  const bytes = Buffer.byteLength(JSON.stringify(widest), 'utf8');

  assert.ok(bytes <= REVIEW_OUTPUT_LIMIT_BYTES,
    `a schema-compliant review of ${bytes} bytes must survive a ${REVIEW_OUTPUT_LIMIT_BYTES}-byte cap`);
});

// A session that edits the worktree and then fails its verification: the shape that used to leave a human
// with work they could not read. `edit` receives the worktree so a test can say exactly what changed.
function redRun(edit) {
  return {
    runProvider(input) {
      edit(input.root);
      return providerResult(completedSlice());
    },
    verify: () => ({ status: 1, duration_ms: 2, diagnostic: 'value is still 1' }),
    hydrate: () => ({ hydrated: false }),
  };
}

function writesValue(value) {
  return root => fs.writeFileSync(path.join(root, 'value.js'), `module.exports = ${value};\n`);
}

function headOf(worktree) {
  return childProcess.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8' }).trim();
}

function changedBetween(worktree, from, to) {
  return childProcess
    .execFileSync('git', ['diff', '--name-only', `${from}..${to}`], { cwd: worktree, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

test('Red attempt is readable as a diff without earning a checkpoint', t => {
  const opened = openTestWork(t, { prefix: 'attempt', workId: 'work-red-attempt' });

  advanceWork(opened.worktree, { runtime: 'claude' }, redRun(writesValue(2)));

  const state = readState(opened.worktree, opened.workId);
  const slice = state.slices[0];
  assert.equal(slice.status, 'correction-ready');
  assert.equal(slice.checkpoint_commit, undefined, 'a red Review Slice earns no checkpoint');
  assert.match(slice.attempt_commit || '', /^[0-9a-f]{40}$/, 'the attempt it did produce is still readable');
  assert.deepEqual(changedBetween(opened.worktree, slice.base_commit, slice.attempt_commit), ['value.js']);
});

// The snapshot exists to be read, not to advance the Work: the product branch still receives code only when
// verification is green, so nothing downstream can mistake an attempt for an accepted change.
test('Attempt snapshot moves neither the branch nor the working tree', t => {
  const opened = openTestWork(t, { prefix: 'attempt-branch', workId: 'work-attempt-branch' });
  const base = headOf(opened.worktree);

  advanceWork(opened.worktree, { runtime: 'claude' }, redRun(writesValue(2)));

  const state = readState(opened.worktree, opened.workId);
  assert.equal(headOf(opened.worktree), base, 'the Pair branch never moves for an attempt');
  assert.equal(state.head_commit, state.base_commit);
  assert.equal(fs.readFileSync(path.join(opened.worktree, 'value.js'), 'utf8'), 'module.exports = 2;\n',
    'the work stays in the worktree exactly as the session left it');
  const status = childProcess.execFileSync('git', ['status', '--porcelain'], { cwd: opened.worktree, encoding: 'utf8' });
  assert.match(status, /^ M value\.js$/mu, 'the snapshot leaves the real index alone, so the change is still unstaged');
});

// The whole-slice diff cannot answer "what did the correction change" — this is the reason a human asked for
// both. Two consecutive attempts give the correction-only diff an anchor before any commit exists.
test('Correction attempt is diffable against the attempt before it', t => {
  const opened = openTestWork(t, { prefix: 'attempt-correction', workId: 'work-attempt-correction' });

  advanceWork(opened.worktree, { runtime: 'claude' }, redRun(writesValue(2)));
  const first = readState(opened.worktree, opened.workId).slices[0].attempt_commit;
  // The correction leaves value.js as the implementation wrote it and adds one file, so "what the
  // correction changed" is a fact the whole-slice diff genuinely cannot isolate.
  advanceWork(opened.worktree, { runtime: 'claude' },
    redRun(root => fs.writeFileSync(path.join(root, 'extra.js'), 'module.exports = 3;\n')));

  const slice = readState(opened.worktree, opened.workId).slices[0];
  assert.equal(slice.prior_attempt_commit, first, 'the attempt before this one is what the correction is read against');
  assert.notEqual(slice.attempt_commit, first);
  assert.deepEqual(changedBetween(opened.worktree, slice.prior_attempt_commit, slice.attempt_commit), ['extra.js'],
    'only what the correction touched, which the whole-slice diff cannot isolate');
});

// Override-accept is the loop's existing way to say "I have read this and I am taking it, on the record", and
// it refused a red slice on the grounds that acceptSlice "would be accepted as an empty acceptance that no
// diff backs". The attempt snapshot IS a diff-backed immutable commit, so that objection is spent. What is
// still real is the branch: an attempt's parent is the base and the branch never moved, so accepting one
// without committing it would leave the next slice's base missing this slice's work.
test('Override accept promotes an unverified attempt onto the branch rather than refusing it', t => {
  const opened = openTestWork(t, { prefix: 'accept-attempt', workId: 'work-accept-attempt' });
  advanceWork(opened.worktree, { runtime: 'claude' }, redRun(writesValue(2)));
  const base = readState(opened.worktree, opened.workId).base_commit;

  acceptHumanReview(opened.worktree, {
    workId: 'work-accept-attempt',
    sliceId: 'S1',
    override: true,
    reason: 'The failures are environmental and tracked elsewhere; the change itself is reviewed and correct.',
  }, { verify: () => ({ status: 1, duration_ms: 2 }), hydrate: () => ({ hydrated: false }) });

  const state = readState(opened.worktree, opened.workId);
  const slice = state.slices[0];
  assert.equal(slice.status, 'accepted');
  assert.match(slice.checkpoint_commit || '', /^[0-9a-f]{40}$/, 'the accepted slice is backed by a real commit');
  assert.notEqual(state.head_commit, base, 'and that commit is on the branch, so the next slice builds on it');
  assert.equal(headOf(opened.worktree), state.head_commit);
});

// An acceptance that hides its red gate is worse than a refusal: every later reader — a handover, a
// completion review, a person asking why this shipped — would see an ordinary accepted slice.
test('Override accept records that the gate was red when it was taken', t => {
  const opened = openTestWork(t, { prefix: 'accept-record', workId: 'work-accept-record' });
  advanceWork(opened.worktree, { runtime: 'claude' }, redRun(writesValue(2)));

  acceptHumanReview(opened.worktree, {
    workId: 'work-accept-record',
    sliceId: 'S1',
    override: true,
    reason: 'Taking it with the gate red, deliberately.',
  }, { verify: () => ({ status: 1, duration_ms: 2 }), hydrate: () => ({ hydrated: false }) });

  // Through the store's own reader: in a linked worktree `.git` is a file, and the journal lives in the
  // common directory it points at.
  const events = readEvents(opened.worktree, 'work-accept-record');
  const accepted = events.find(event => event.event === 'slice-accepted');

  assert.equal(accepted.verification_status, 1, 'the exit status the gate actually returned is on the record');
  assert.equal(accepted.accepted_over_red_gate, true, 'and it is named, not left to be inferred from a number');
  assert.ok(events.some(event => event.event === 'human-override' && event.action === 'accept'),
    'with the human reason stored beside it');
});

test('Override accept is still refused for a slice that has implemented nothing', t => {
  const opened = openTestWork(t, { prefix: 'accept-nothing', workId: 'work-accept-nothing' });

  assert.throws(() => acceptHumanReview(opened.worktree, {
    workId: 'work-accept-nothing', sliceId: 'S1', override: true, reason: 'Nothing here, but accept it.',
  }), /no checkpoint and no attempt/u, 'there is genuinely nothing to back an acceptance, and the message says so');
});

test('Accept without an override is refused on a red slice, as before', t => {
  const opened = openTestWork(t, { prefix: 'accept-plain', workId: 'work-accept-plain' });
  advanceWork(opened.worktree, { runtime: 'claude' }, redRun(writesValue(2)));

  assert.throws(() => acceptHumanReview(opened.worktree, { workId: 'work-accept-plain', sliceId: 'S1' }),
    /not awaiting human acceptance/u, 'taking a red slice stays a deliberate act, never the default path');
});

test('Slice evidence carries both attempt anchors so a human can read either diff', t => {
  const opened = openTestWork(t, { prefix: 'attempt-evidence', workId: 'work-attempt-evidence' });

  advanceWork(opened.worktree, { runtime: 'claude' }, redRun(writesValue(2)));
  const evidence = sliceEvidence(opened.worktree, { workId: 'work-attempt-evidence' });

  assert.equal(evidence.checkpoint_commit, null);
  assert.equal(evidence.attempt_commit, readState(opened.worktree, opened.workId).slices[0].attempt_commit);
  assert.equal(evidence.prior_attempt_commit, null, 'a first attempt has nothing before it to diff against');
});
