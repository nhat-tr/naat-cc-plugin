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
  adjudicateFinding,
  advanceWork,
  failingTestIdentities,
  forgetKnownFailure,
  knownFailures,
  openWork,
  recordKnownFailure,
  verifyActiveSlice,
} = require('../scripts/lib/pair-engine');
const { readState, workPaths, writeState } = require('../scripts/lib/pair-store');
const { listReviewOutcomes } = require('../scripts/lib/review-evidence');
const { nextCommand } = require('../scripts/pair-cli');

const UNUSED_PID = 2 ** 30;

function workEvents(root, workId) {
  return fs.readFileSync(workPaths(root, workId).events, 'utf8')
    .split(/\r?\n/u)
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

const FLAKE = 'Paragon.Tests.Integration.Lens.WarmLensSessionTests.WarmLensSession_verifies_no_state_crosses_turns';

function providerResult(output) {
  return {
    output,
    usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 20 },
    duration_ms: 5,
    runtime: 'codex', model: 'default', effort: 'medium',
  };
}

function completedSlice() {
  return {
    status: 'completed',
    architecture_risk: null,
    design_check: null,
    failure_proof: { boundary: 'module export', method: 'unit', negative_control: 'Returning 1 fails the verification.' },
    blocker: null,
  };
}

function openScratchWork(t, workId) {
  const scratch = process.env.CLAUDE_SCRATCH_DIR || path.join(os.homedir(), '.claude-scratch');
  const parent = path.join(scratch, 'my-claude-code', 'pair-vnext-tests');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'baseline-'));
  childProcess.execFileSync('git', ['init', '-q'], { cwd: root });
  childProcess.execFileSync('git', ['config', 'user.email', 'pair@test'], { cwd: root });
  childProcess.execFileSync('git', ['config', 'user.name', 'Pair Test'], { cwd: root });
  fs.writeFileSync(path.join(root, 'value.js'), 'module.exports = 1;\n');
  childProcess.execFileSync('git', ['add', '.'], { cwd: root });
  childProcess.execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
  const spec = path.join(parent, `${path.basename(root)}-spec.md`);
  const manifest = path.join(parent, `${path.basename(root)}-slices.json`);
  fs.writeFileSync(spec, '# Spec\n\n## Acceptance Criteria\n\n- [ ] AC-1: value becomes two\n');
  fs.writeFileSync(manifest, JSON.stringify({
    schema: 1,
    work_id: workId,
    slices: [{ id: 'S1', acceptance_criteria: ['AC-1'], outcome: 'Existing value returns two.', depends_on: [], verify: 'node verify.js' }],
  }));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(spec, { force: true });
    fs.rmSync(manifest, { force: true });
  });
  return openWork(root, { workId, specPath: spec, manifestPath: manifest });
}

function implementationDependencies(verifyResults) {
  const remaining = [...verifyResults];
  return {
    runProvider(input) {
      fs.writeFileSync(path.join(input.root, 'value.js'), 'module.exports = 2;\n');
      return providerResult(completedSlice());
    },
    verify() {
      return remaining.length > 1 ? remaining.shift() : remaining[0];
    },
    hydrate() { return { hydrated: false }; },
  };
}

test('failing test identities are read from the runner rather than inferred from the exit status', () => {
  const dotnet = [
    '  Failed Paragon.Tests.Catalog.SyncTests.Sync_persists_each_page [1 s]',
    '  Error Message:',
    '   Expected: 5',
    `[31mFailed!  - Failed:     1, Passed:   329, Skipped:     0, Total:   330[0m`,
  ].join('\n');
  assert.deepEqual(failingTestIdentities(dotnet), ['Paragon.Tests.Catalog.SyncTests.Sync_persists_each_page']);
  assert.deepEqual(failingTestIdentities('not ok 3 - registry isolates state\nok 4 - other'), ['registry isolates state']);
  assert.deepEqual(failingTestIdentities('Build succeeded.\nAll tests passed.'), []);
});

test('a declared Known Failure keeps a pre-existing failure from parking the Review Slice at correction-ready', t => {
  const opened = openScratchWork(t, 'work-baseline-exempt');
  recordKnownFailure(opened.worktree, {
    workId: 'work-baseline-exempt',
    test: FLAKE,
    reason: 'Fails in the full suite since 2026-07-29 and passes 2/2 in isolation in the same worktree.',
  });
  const state = advanceWork(opened.worktree, { runtime: 'codex' }, implementationDependencies([
    { status: 1, duration_ms: 3, log_digest: 'a'.repeat(64), failing_tests: [FLAKE], diagnostic: 'Expected 5, but was 1' },
  ]));
  const projected = state.slices[0];
  assert.notEqual(projected.status, 'correction-ready', 'a failure the Work did not cause must not consume its correction window');
  assert.equal(projected.correction_count, 0);
  assert.ok(projected.checkpoint_commit, 'the slice checkpoints because it introduced no new failure');
  const verification = workEvents(opened.worktree, 'work-baseline-exempt').find(event => event.event === 'verification-finished');
  assert.equal(verification.status, 0, 'the exemption is applied');
  assert.equal(verification.observed_status, 1, 'and the real exit status stays on the record');
  assert.equal(verification.baselined_test_count, 1);
});

test('a failure outside the Known Failure Baseline still parks the Review Slice at correction-ready', t => {
  const opened = openScratchWork(t, 'work-baseline-strict');
  recordKnownFailure(opened.worktree, {
    workId: 'work-baseline-strict',
    test: FLAKE,
    reason: 'Pre-existing full-suite flake, passes in isolation.',
  });
  const state = advanceWork(opened.worktree, { runtime: 'codex' }, implementationDependencies([
    {
      status: 1,
      duration_ms: 3,
      log_digest: 'b'.repeat(64),
      failing_tests: [FLAKE, 'Paragon.Tests.Catalog.SyncTests.Sync_persists_each_page'],
      diagnostic: 'Sync_persists_each_page failed',
    },
  ]));
  assert.equal(state.slices[0].status, 'correction-ready');
  assert.equal(state.slices[0].checkpoint_commit, undefined);
});

test('an unrecognised runner is never exempted, because no test identity can be matched against the baseline', t => {
  const opened = openScratchWork(t, 'work-baseline-unparsed');
  recordKnownFailure(opened.worktree, {
    workId: 'work-baseline-unparsed',
    test: FLAKE,
    reason: 'Pre-existing full-suite flake, passes in isolation.',
  });
  const state = advanceWork(opened.worktree, { runtime: 'codex' }, implementationDependencies([
    { status: 1, duration_ms: 3, log_digest: 'c'.repeat(64), failing_tests: [], diagnostic: 'exit 1' },
  ]));
  assert.equal(state.slices[0].status, 'correction-ready');
});

test('re-verification clears a deterministic failure and checkpoints without spending the one correction', t => {
  const opened = openScratchWork(t, 'work-verify-clears');
  const parked = advanceWork(opened.worktree, { runtime: 'codex' }, implementationDependencies([
    { status: 1, duration_ms: 3, log_digest: 'd'.repeat(64), failing_tests: ['Suite.Env_dependent_case'], diagnostic: 'container port already in use' },
  ]));
  assert.equal(parked.slices[0].status, 'correction-ready');

  const { report, state } = verifyActiveSlice(opened.worktree, { workId: 'work-verify-clears' }, {
    verify() { return { status: 0, duration_ms: 4, log_digest: 'e'.repeat(64), failing_tests: [] }; },
    hydrate() { return { hydrated: false }; },
  });
  assert.equal(report.status, 0);
  assert.ok(report.checkpoint_created, 're-verification is the escape from an environmental failure');
  assert.equal(state.slices[0].correction_count, 0, 'no model correction ran, so none was spent');
  assert.equal(readState(opened.worktree, 'work-verify-clears').slices[0].verification_failure, undefined);
});

test('re-verification that still fails leaves the Review Slice parked and names what failed', t => {
  const opened = openScratchWork(t, 'work-verify-still-red');
  advanceWork(opened.worktree, { runtime: 'codex' }, implementationDependencies([
    { status: 1, duration_ms: 3, log_digest: 'f'.repeat(64), failing_tests: ['Suite.Real_defect'], diagnostic: 'assertion failed' },
  ]));
  const { report, state } = verifyActiveSlice(opened.worktree, { workId: 'work-verify-still-red' }, {
    verify() { return { status: 1, duration_ms: 4, log_digest: '0'.repeat(64), failing_tests: ['Suite.Real_defect'], diagnostic: 'assertion failed' }; },
    hydrate() { return { hydrated: false }; },
  });
  assert.equal(report.status, 1);
  assert.equal(report.checkpoint_created, false);
  assert.deepEqual(report.introduced_failing_tests, ['Suite.Real_defect']);
  assert.equal(state.slices[0].status, 'correction-ready');
});

test('re-verification does not promote a slice whose correction is owed to a valid finding', t => {
  const opened = openScratchWork(t, 'work-verify-valid-finding');
  const state = advanceWork(opened.worktree, { runtime: 'codex' }, implementationDependencies([
    { status: 0, duration_ms: 3, log_digest: '4'.repeat(64), failing_tests: [] },
  ]));
  // Stand the slice in the shape adjudicateFinding leaves behind: a green checkpoint, a Review
  // Outcome, and no deterministic failure — the correction is owed to the finding, not to the gate.
  const projected = state.slices[0];
  projected.status = 'correction-ready';
  projected.review_outcome_id = 'review-outcome-test';
  delete projected.verification_failure;
  writeState(opened.worktree, 'work-verify-valid-finding', state);

  const { report, state: after } = verifyActiveSlice(opened.worktree, { workId: 'work-verify-valid-finding' }, {
    verify() { return { status: 0, duration_ms: 4, log_digest: '5'.repeat(64), failing_tests: [] }; },
    hydrate() { return { hydrated: false }; },
  });
  assert.equal(report.status, 0);
  assert.equal(report.clears_deterministic_failure, false);
  assert.equal(report.checkpoint_created, false, 'a clean gate proves nothing this slice was not already granted');
  assert.equal(after.slices[0].status, 'correction-ready');
  assert.equal(after.slices[0].correction_count, 0);
});

test('the named next command tells the two correction-ready roads apart', () => {
  const deterministic = {
    lifecycle: 'ready',
    slices: [{ id: 'S1', status: 'correction-ready', verification_failure: 'Expected 5, but was 1' }],
  };
  const validFinding = {
    lifecycle: 'ready',
    slices: [{ id: 'S1', status: 'correction-ready', review_outcome_id: 'review-outcome-test' }],
  };
  assert.match(nextCommand(deterministic, deterministic.slices[0]), /^pair-loop verify --slice S1/u);
  assert.match(nextCommand(validFinding, validFinding.slices[0]), /^pair-loop run/u);
});

test('a second verification of the same Work is refused while the first is still running', t => {
  const opened = openScratchWork(t, 'work-verify-lease');
  let refusal = null;
  advanceWork(opened.worktree, { runtime: 'codex' }, {
    runProvider(input) {
      fs.writeFileSync(path.join(input.root, 'value.js'), 'module.exports = 2;\n');
      return providerResult(completedSlice());
    },
    verify() {
      // Reentering while this run holds the lease is exactly the concurrent-suite case: one machine,
      // one set of containers, two suites making each other fail in unrelated places. Only the first
      // reentry is the interesting one; by the cumulative run the slice is already accepted.
      if (refusal === null) {
        try {
          verifyActiveSlice(opened.worktree, { workId: 'work-verify-lease', sliceId: 'S1' }, {
            verify() { return { status: 0, duration_ms: 1, log_digest: '1'.repeat(64), failing_tests: [] }; },
            hydrate() { return { hydrated: false }; },
          });
          refusal = 'concurrent verification was allowed';
        } catch (error) { refusal = error.message; }
      }
      return { status: 0, duration_ms: 3, log_digest: '2'.repeat(64), failing_tests: [] };
    },
    hydrate() { return { hydrated: false }; },
  });
  assert.match(refusal || '', /has been running since/u);
  assert.match(refusal || '', /concurrent suites share this machine/u);
});

test('an abandoned verification lease does not wedge the next run', t => {
  const opened = openScratchWork(t, 'work-verify-lease-reap');
  const lease = path.join(workPaths(opened.worktree, 'work-verify-lease-reap').verificationLease);
  fs.mkdirSync(lease, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(lease, 'owner.json'), JSON.stringify({ pid: UNUSED_PID, nonce: 'dead', at: new Date().toISOString() }));
  const state = advanceWork(opened.worktree, { runtime: 'codex' }, implementationDependencies([
    { status: 0, duration_ms: 3, log_digest: '3'.repeat(64), failing_tests: [] },
  ]));
  assert.equal(state.slices[0].status, 'accepted');
  assert.equal(fs.existsSync(lease), false, 'the lease is released, not leaked');
});

test('the human reason for calling a finding valid reaches the correcting session', t => {
  const opened = openScratchWork(t, 'work-adjudication-reaches');
  const prompts = [];
  const dependencies = {
    runProvider(input) {
      prompts.push(input.prompt);
      if (input.mode === 'review') {
        return providerResult({
          verdict: 'findings',
          findings: [{
            severity: 'MAJOR',
            claim: 'The value is computed twice.',
            scenario: 'Two callers each recompute it on every request.',
            evidence: {
              commit: readState(opened.worktree, 'work-adjudication-reaches').slices[0].checkpoint_commit,
              path: 'value.js',
              blob: childProcess.execFileSync('git', ['rev-parse', 'HEAD:value.js'], { cwd: opened.worktree, encoding: 'utf8' }).trim(),
              line_start: 1,
              line_end: 1,
            },
            impact: 'Wasted work on every request.',
            pass_condition: 'The value is computed once.',
          }],
        });
      }
      // The correction has to change something a checkpoint can hold, or it commits nothing.
      const memoised = input.prompt.startsWith('Correct Review Slice');
      fs.writeFileSync(path.join(input.root, 'value.js'), memoised ? 'const value = 2;\nmodule.exports = value;\n' : 'module.exports = 2;\n');
      return providerResult(completedSlice());
    },
    verify() { return { status: 0, duration_ms: 3, log_digest: '6'.repeat(64), failing_tests: [] }; },
    hydrate() { return { hydrated: false }; },
  };
  // Each advance performs at most one fresh model action: implement, then review, then correct.
  advanceWork(opened.worktree, { runtime: 'codex', reviewPolicy: 'all' }, dependencies);
  advanceWork(opened.worktree, { runtime: 'codex', reviewPolicy: 'all' }, dependencies);
  const outcome = readState(opened.worktree, 'work-adjudication-reaches').slices[0].review_outcome_id;
  assert.ok(outcome, 'the review recorded an outcome to adjudicate');
  const finding = listReviewOutcomes(opened.worktree, 'work-adjudication-reaches')
    .find(item => item.review_outcome_id === outcome).findings[0];
  adjudicateFinding(opened.worktree, {
    workId: 'work-adjudication-reaches',
    findingId: finding.finding_id,
    disposition: 'valid',
    reason: 'Confirmed: both callers recompute, memoise at the module boundary rather than per caller.',
  });
  advanceWork(opened.worktree, { runtime: 'codex' }, dependencies);
  const correction = prompts.at(-1);
  assert.match(correction, /Correct Review Slice/u, 'the last invocation is the correction');
  assert.match(correction, /memoise at the module boundary rather than per caller/u,
    'the human adjudication travels with the finding it adjudicates');
});

test('a Known Failure requires the evidence that it pre-exists the Work, and withdrawing an absent one is refused', t => {
  const opened = openScratchWork(t, 'work-baseline-guards');
  assert.throws(
    () => recordKnownFailure(opened.worktree, { workId: 'work-baseline-guards', test: FLAKE }),
    /requires --reason/u,
  );
  recordKnownFailure(opened.worktree, { workId: 'work-baseline-guards', test: FLAKE, reason: 'Pre-existing since 2026-07-29.' });
  recordKnownFailure(opened.worktree, { workId: 'work-baseline-guards', test: FLAKE, reason: 'Re-declared with sharper evidence.' });
  assert.equal(knownFailures(opened.worktree, 'work-baseline-guards').length, 1, 'a re-declaration replaces rather than duplicates');
  assert.throws(
    () => forgetKnownFailure(opened.worktree, { workId: 'work-baseline-guards', test: 'Suite.Never_declared' }),
    /not in the Known Failure Baseline/u,
  );
  forgetKnownFailure(opened.worktree, { workId: 'work-baseline-guards', test: FLAKE });
  assert.deepEqual(knownFailures(opened.worktree, 'work-baseline-guards'), []);
});
