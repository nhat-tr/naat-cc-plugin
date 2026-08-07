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
  REVIEW_OUTPUT_LIMIT_BYTES,
  SLICE_OUTPUT_LIMIT_BYTES,
  acceptHumanReview,
  adjudicateFinding,
  advanceWork,
  openWork,
  recordCorrectionDirection,
} = require('../scripts/lib/pair-engine');
const { blobAtCommit, readEvents, readState, workPaths } = require('../scripts/lib/pair-store');
const { listReviewOutcomes } = require('../scripts/lib/review-evidence');

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

test('routine Review Slice uses one fresh implementation invocation and deterministic proof', t => {
  const scratch = process.env.CLAUDE_SCRATCH_DIR || path.join(os.homedir(), '.claude-scratch');
  const parent = path.join(scratch, 'my-claude-code', 'pair-vnext-tests');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'engine-'));
  childProcess.execFileSync('git', ['init', '-q'], { cwd: root });
  childProcess.execFileSync('git', ['config', 'user.email', 'pair@test'], { cwd: root });
  childProcess.execFileSync('git', ['config', 'user.name', 'Pair Test'], { cwd: root });
  fs.writeFileSync(path.join(root, 'value.js'), 'module.exports = 1;\n');
  childProcess.execFileSync('git', ['add', '.'], { cwd: root });
  childProcess.execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
  const spec = path.join(parent, `${path.basename(root)}-spec.md`);
  const manifest = path.join(parent, `${path.basename(root)}-slices.json`);
  fs.writeFileSync(spec, '# Spec\n\n## Acceptance Criteria\n\n- [ ] AC-1: value becomes two\n');
  fs.writeFileSync(manifest, JSON.stringify({ schema: 1, work_id: 'work-engine', slices: [{ id: 'S1', acceptance_criteria: ['AC-1'], outcome: 'Existing value returns two.', depends_on: [], verify: 'node verify.js' }] }));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(spec, { force: true });
    fs.rmSync(manifest, { force: true });
  });
  const opened = openWork(root, { workId: 'work-engine', specPath: spec, manifestPath: manifest, humanLoop: true });
  let providerCalls = 0;
  let verificationCalls = 0;
  const result = advanceWork(opened.worktree, { runtime: 'codex' }, {
    runProvider(input) {
      providerCalls++;
      fs.writeFileSync(path.join(input.root, 'value.js'), 'module.exports = 2;\n');
      return providerResult({
          status: 'completed', architecture_risk: null, design_check: null,
          failure_proof: { boundary: 'module export', method: 'unit', negative_control: 'Returning 1 fails the verification.' }, blocker: null,
      });
    },
    verify() {
      verificationCalls++;
      return { status: 0, duration_ms: 3, log_digest: 'a'.repeat(64) };
    },
    hydrate() { return { hydrated: false }; },
  });
  assert.equal(result.lifecycle, 'complete');
  assert.equal(providerCalls, 1);
  assert.equal(verificationCalls, 2, 'slice proof plus cumulative deterministic proof');
  assert.equal(readState(opened.worktree, 'work-engine').slices[0].status, 'accepted');
});

test('Architecture-Sensitive Path requires Design Check, fresh review, and human acceptance', t => {
  const scratch = process.env.CLAUDE_SCRATCH_DIR || path.join(os.homedir(), '.claude-scratch');
  const parent = path.join(scratch, 'my-claude-code', 'pair-vnext-tests');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'architecture-engine-'));
  childProcess.execFileSync('git', ['init', '-q'], { cwd: root });
  childProcess.execFileSync('git', ['config', 'user.email', 'pair@test'], { cwd: root });
  childProcess.execFileSync('git', ['config', 'user.name', 'Pair Test'], { cwd: root });
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'consumer.js'), 'module.exports = null;\n');
  childProcess.execFileSync('git', ['add', '.'], { cwd: root });
  childProcess.execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
  const spec = path.join(parent, `${path.basename(root)}-spec.md`);
  const manifest = path.join(parent, `${path.basename(root)}-slices.json`);
  fs.writeFileSync(spec, '# Spec\n\n## Acceptance Criteria\n\n- [ ] AC-1: independent registries do not share state\n');
  fs.writeFileSync(manifest, JSON.stringify({ schema: 1, work_id: 'work-architecture', slices: [{ id: 'S1', acceptance_criteria: ['AC-1'], outcome: 'Independent registry owners isolate state.', depends_on: [], verify: 'node verify.js' }] }));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(spec, { force: true }); fs.rmSync(manifest, { force: true }); });
  const opened = openWork(root, { workId: 'work-architecture', specPath: spec, manifestPath: manifest, humanLoop: true });
  let call = 0;
  const outputLimits = [];
  const dependencies = {
    runProvider(input) {
      call++;
      outputLimits.push(input.maxOutputBytes);
      if (call === 1) return providerResult({ status: 'design-required', architecture_risk: 'Registry ownership and lifetime move from process-global to composition-root scope.', design_check: designCheck(), failure_proof: null, blocker: null });
      if (call === 2) {
        fs.writeFileSync(path.join(input.root, 'src', 'registry.js'), 'export class Registry { constructor() { this.values = new Map(); } }\n');
        return providerResult({ status: 'completed', architecture_risk: 'Registry ownership and lifetime move from process-global to composition-root scope.', design_check: null, failure_proof: { boundary: 'composition root', method: 'integration', negative_control: 'A process-global registry makes the isolation assertion fail.' }, blocker: null });
      }
      return providerResult({ verdict: 'approve', findings: [] });
    },
    verify() { return { status: 0, duration_ms: 2, log_digest: 'b'.repeat(64) }; },
    hydrate() { return { hydrated: false }; },
  };
  let state = advanceWork(opened.worktree, { runtime: 'codex' }, dependencies);
  assert.equal(state.slices[0].status, 'design-ready');
  const designPath = path.join(workPaths(opened.worktree, 'work-architecture').designChecks, 'S1.md');
  assert.ok(fs.existsSync(designPath));
  assert.ok(fs.statSync(designPath).size < 2 * 1024);
  assert.equal(fs.existsSync(designPath.replace(/\.md$/u, '.json')), false);
  state = advanceWork(opened.worktree, { runtime: 'codex' }, dependencies);
  assert.equal(state.slices[0].status, 'review-ready');
  state = advanceWork(opened.worktree, { runtime: 'codex' }, dependencies);
  assert.equal(state.slices[0].status, 'awaiting-human-review');
  assert.deepEqual(outputLimits, [SLICE_OUTPUT_LIMIT_BYTES, SLICE_OUTPUT_LIMIT_BYTES, REVIEW_OUTPUT_LIMIT_BYTES]);
  assert.equal(call, 3);
  assert.equal(state.invocation_totals.calls, 3);
  assert.equal(state.recent_invocations.length, 3);
  assert.equal(state.invocations, undefined);
  state = acceptHumanReview(opened.worktree, { sliceId: 'S1' }, dependencies);
  assert.equal(state.lifecycle, 'complete');
});

test('review finding cannot trigger correction until human marks it valid', t => {
  const scratch = process.env.CLAUDE_SCRATCH_DIR || path.join(os.homedir(), '.claude-scratch');
  const parent = path.join(scratch, 'my-claude-code', 'pair-vnext-tests');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'feedback-engine-'));
  childProcess.execFileSync('git', ['init', '-q'], { cwd: root });
  childProcess.execFileSync('git', ['config', 'user.email', 'pair@test'], { cwd: root });
  childProcess.execFileSync('git', ['config', 'user.name', 'Pair Test'], { cwd: root });
  fs.writeFileSync(path.join(root, 'value.js'), 'module.exports = 1;\n');
  childProcess.execFileSync('git', ['add', '.'], { cwd: root });
  childProcess.execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
  const spec = path.join(parent, `${path.basename(root)}-spec.md`);
  const manifest = path.join(parent, `${path.basename(root)}-slices.json`);
  fs.writeFileSync(spec, '# Spec\n\n## Acceptance Criteria\n\n- [ ] AC-1: value becomes three\n');
  fs.writeFileSync(manifest, JSON.stringify({ schema: 1, work_id: 'work-feedback', slices: [{ id: 'S1', acceptance_criteria: ['AC-1'], outcome: 'Value returns three.', depends_on: [], verify: 'node verify.js' }] }));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(spec, { force: true }); fs.rmSync(manifest, { force: true }); });
  const opened = openWork(root, { workId: 'work-feedback', specPath: spec, manifestPath: manifest, humanLoop: true });
  let call = 0;
  const dependencies = {
    runProvider(input) {
      call++;
      if (call === 1) {
        fs.writeFileSync(path.join(input.root, 'value.js'), 'module.exports = 2;\n');
        return providerResult({ status: 'completed', architecture_risk: null, design_check: null, failure_proof: { boundary: 'module export', method: 'unit', negative_control: 'Returning one fails.' }, blocker: null });
      }
      if (call === 2) {
        const commit = childProcess.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: input.root, encoding: 'utf8' }).trim();
        return providerResult({ verdict: 'findings', findings: [{ severity: 'MAJOR', claim: 'The required value is still wrong.', scenario: 'Caller reads two while AC-1 requires three.', evidence: { commit, path: 'value.js', blob: blobAtCommit(input.root, commit, 'value.js'), line_start: 1, line_end: 1 }, impact: 'Acceptance behavior fails.', pass_condition: 'The module exports three.' }] });
      }
      fs.writeFileSync(path.join(input.root, 'value.js'), 'module.exports = 3;\n');
      return providerResult({ status: 'completed', architecture_risk: null, design_check: null, failure_proof: { boundary: 'module export', method: 'unit', negative_control: 'Returning two fails.' }, blocker: null });
    },
    verify() { return { status: 0, duration_ms: 2, log_digest: 'c'.repeat(64) }; },
    hydrate() { return { hydrated: false }; },
  };
  let state = advanceWork(opened.worktree, { runtime: 'codex', reviewPolicy: 'all' }, dependencies);
  assert.equal(state.slices[0].status, 'review-ready');
  state = advanceWork(opened.worktree, { runtime: 'codex', reviewPolicy: 'all' }, dependencies);
  assert.equal(state.slices[0].status, 'awaiting-feedback');
  assert.equal(call, 2, 'review alone cannot start a correction');
  const finding = listReviewOutcomes(opened.worktree, 'work-feedback')[0].findings[0];
  state = adjudicateFinding(opened.worktree, { findingId: finding.finding_id, disposition: 'valid', reason: 'AC-1 explicitly requires three.' });
  assert.equal(state.slices[0].status, 'correction-ready');
  state = advanceWork(opened.worktree, { runtime: 'codex' }, dependencies);
  assert.equal(state.slices[0].status, 'awaiting-human-review');
  assert.equal(state.slices[0].correction_count, 1);
  state = acceptHumanReview(opened.worktree, { sliceId: 'S1' }, dependencies);
  assert.equal(state.lifecycle, 'complete');
});

test('overlapping accepted slices trigger one fresh combined-diff review', t => {
  const scratch = process.env.CLAUDE_SCRATCH_DIR || path.join(os.homedir(), '.claude-scratch');
  const parent = path.join(scratch, 'my-claude-code', 'pair-vnext-tests');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'composition-engine-'));
  childProcess.execFileSync('git', ['init', '-q'], { cwd: root });
  childProcess.execFileSync('git', ['config', 'user.email', 'pair@test'], { cwd: root });
  childProcess.execFileSync('git', ['config', 'user.name', 'Pair Test'], { cwd: root });
  fs.writeFileSync(path.join(root, 'value.txt'), 'base\n');
  childProcess.execFileSync('git', ['add', '.'], { cwd: root });
  childProcess.execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
  const spec = path.join(parent, `${path.basename(root)}-spec.md`);
  const manifest = path.join(parent, `${path.basename(root)}-slices.json`);
  fs.writeFileSync(spec, '# Spec\n\n## Acceptance Criteria\n\n- [ ] AC-1: first line exists\n- [ ] AC-2: second line exists\n');
  fs.writeFileSync(manifest, JSON.stringify({ schema: 1, work_id: 'work-composition', slices: [
    { id: 'S1', acceptance_criteria: ['AC-1'], outcome: 'First line exists.', depends_on: [], verify: 'true' },
    { id: 'S2', acceptance_criteria: ['AC-2'], outcome: 'Second line exists.', depends_on: ['S1'], verify: 'true' },
  ] }));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(spec, { force: true }); fs.rmSync(manifest, { force: true }); });
  const opened = openWork(root, { workId: 'work-composition', specPath: spec, manifestPath: manifest, humanLoop: true });
  let calls = 0;
  const dependencies = {
    runProvider(input) {
      calls++;
      if (calls <= 2) {
        fs.appendFileSync(path.join(input.root, 'value.txt'), `${calls}\n`);
        return providerResult({ status: 'completed', architecture_risk: null, design_check: null, failure_proof: { boundary: `line ${calls}`, method: 'integration', negative_control: `Removing line ${calls} fails.` }, blocker: null });
      }
      return providerResult({ verdict: 'approve', findings: [] });
    },
    verify() { return { status: 0, duration_ms: 1, log_digest: 'd'.repeat(64) }; },
    hydrate() { return { hydrated: false }; },
  };
  let state = advanceWork(opened.worktree, { runtime: 'codex', reviewPolicy: 'off' }, dependencies);
  assert.equal(state.slices[0].status, 'accepted');
  state = advanceWork(opened.worktree, { runtime: 'codex', reviewPolicy: 'off' }, dependencies);
  assert.equal(state.lifecycle, 'completion-review-ready');
  assert.equal(state.composition_review_required, true);
  state = advanceWork(opened.worktree, { runtime: 'codex' }, dependencies);
  assert.equal(state.lifecycle, 'complete');
  assert.equal(calls, 3);
});

test('dirty-worktree block lifts once the tree is clean, including states written before the precondition field', t => {
  const scratch = process.env.CLAUDE_SCRATCH_DIR || path.join(os.homedir(), '.claude-scratch');
  const parent = path.join(scratch, 'my-claude-code', 'pair-vnext-tests');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'dirty-block-'));
  childProcess.execFileSync('git', ['init', '-q'], { cwd: root });
  childProcess.execFileSync('git', ['config', 'user.email', 'pair@test'], { cwd: root });
  childProcess.execFileSync('git', ['config', 'user.name', 'Pair Test'], { cwd: root });
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'consumer.js'), 'module.exports = null;\n');
  childProcess.execFileSync('git', ['add', '.'], { cwd: root });
  childProcess.execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
  const spec = path.join(parent, `${path.basename(root)}-spec.md`);
  const manifest = path.join(parent, `${path.basename(root)}-slices.json`);
  fs.writeFileSync(spec, '# Spec\n\n## Acceptance Criteria\n\n- [ ] AC-1: independent registries do not share state\n');
  fs.writeFileSync(manifest, JSON.stringify({ schema: 1, work_id: 'work-dirty-block', slices: [{ id: 'S1', acceptance_criteria: ['AC-1'], outcome: 'Independent registry owners isolate state.', depends_on: [], verify: 'node verify.js' }] }));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(spec, { force: true }); fs.rmSync(manifest, { force: true }); });
  const opened = openWork(root, { workId: 'work-dirty-block', specPath: spec, manifestPath: manifest, humanLoop: true });
  let calls = 0;
  const dependencies = {
    runProvider(input) {
      calls++;
      if (calls === 1) return providerResult({ status: 'design-required', architecture_risk: 'Registry ownership and lifetime move from process-global to composition-root scope.', design_check: designCheck(), failure_proof: null, blocker: null });
      if (calls === 2) {
        fs.writeFileSync(path.join(input.root, 'src', 'registry.js'), 'export class Registry { constructor() { this.values = new Map(); } }\n');
        return providerResult({ status: 'completed', architecture_risk: 'Registry ownership and lifetime move from process-global to composition-root scope.', design_check: null, failure_proof: { boundary: 'composition root', method: 'integration', negative_control: 'A process-global registry makes the isolation assertion fail.' }, blocker: null });
      }
      return providerResult({ verdict: 'approve', findings: [] });
    },
    verify() { return { status: 0, duration_ms: 2, log_digest: 'e'.repeat(64) }; },
    hydrate() { return { hydrated: false }; },
  };
  let state = advanceWork(opened.worktree, { runtime: 'codex' }, dependencies);
  assert.equal(state.slices[0].status, 'design-ready');

  const stray = path.join(opened.worktree, 'stray.txt');
  fs.writeFileSync(stray, 'left behind by a killed attempt\n');
  state = advanceWork(opened.worktree, { runtime: 'codex' }, dependencies);
  assert.equal(state.lifecycle, 'blocked');
  assert.equal(state.blocked_precondition, 'dirty-worktree');
  assert.equal(state.slices[0].blocked_from, 'design-ready');
  assert.equal(calls, 1, 'a blocked precondition spends no model call');

  state = advanceWork(opened.worktree, { runtime: 'codex' }, dependencies);
  assert.equal(state.lifecycle, 'blocked', 'the block holds while the tree is still dirty');

  // A state written before the precondition field existed carries only the reason text.
  const statePath = workPaths(opened.worktree, 'work-dirty-block').state;
  const legacy = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  delete legacy.blocked_precondition;
  delete legacy.slices[0].blocked_from;
  fs.writeFileSync(statePath, JSON.stringify(legacy));

  fs.rmSync(stray);
  state = advanceWork(opened.worktree, { runtime: 'codex' }, dependencies);
  assert.equal(state.slices[0].status, 'review-ready', 'the cleaned tree resumes the Design Check checkpoint');
  assert.equal(state.blocked_reason, null);
  assert.equal(calls, 2, 'resuming spends exactly the interrupted implementation call');
});

test('a block that is not a self-healing precondition stays latched on a clean worktree', t => {
  const scratch = process.env.CLAUDE_SCRATCH_DIR || path.join(os.homedir(), '.claude-scratch');
  const parent = path.join(scratch, 'my-claude-code', 'pair-vnext-tests');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'latched-block-'));
  childProcess.execFileSync('git', ['init', '-q'], { cwd: root });
  childProcess.execFileSync('git', ['config', 'user.email', 'pair@test'], { cwd: root });
  childProcess.execFileSync('git', ['config', 'user.name', 'Pair Test'], { cwd: root });
  fs.writeFileSync(path.join(root, 'value.js'), 'module.exports = 1;\n');
  childProcess.execFileSync('git', ['add', '.'], { cwd: root });
  childProcess.execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
  const spec = path.join(parent, `${path.basename(root)}-spec.md`);
  const manifest = path.join(parent, `${path.basename(root)}-slices.json`);
  fs.writeFileSync(spec, '# Spec\n\n## Acceptance Criteria\n\n- [ ] AC-1: value becomes two\n');
  fs.writeFileSync(manifest, JSON.stringify({ schema: 1, work_id: 'work-latched', slices: [{ id: 'S1', acceptance_criteria: ['AC-1'], outcome: 'Existing value returns two.', depends_on: [], verify: 'node verify.js' }] }));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(spec, { force: true }); fs.rmSync(manifest, { force: true }); });
  const opened = openWork(root, { workId: 'work-latched', specPath: spec, manifestPath: manifest, humanLoop: true });
  let calls = 0;
  const dependencies = {
    runProvider() {
      calls++;
      return providerResult({ status: 'blocked', architecture_risk: null, design_check: null, failure_proof: null, blocker: 'the upstream contract is undecided' });
    },
    verify() { return { status: 0, duration_ms: 1, log_digest: 'f'.repeat(64) }; },
    hydrate() { return { hydrated: false }; },
  };
  let state = advanceWork(opened.worktree, { runtime: 'codex' }, dependencies);
  assert.equal(state.lifecycle, 'blocked');
  assert.equal(state.blocked_reason, 'the upstream contract is undecided');
  state = advanceWork(opened.worktree, { runtime: 'codex' }, dependencies);
  assert.equal(state.lifecycle, 'blocked', 'a human-decision block does not lift by itself');
  assert.equal(calls, 1);
});

test('verification diagnostics name the failure instead of the stack frames around it', () => {
  const { verificationCommand } = require('../scripts/lib/pair-engine');
  const emit = lines => verificationCommand(`cat <<'PAIRLOG'\n${lines.join('\n')}\nPAIRLOG\nexit 1`, process.cwd());

  const stdoutOnly = emit(['src/consumer.cs(62,28): error CS0103: The name LogLevel does not exist']);
  assert.equal(stdoutOnly.status, 1);
  assert.match(stdoutOnly.diagnostic, /error CS0103/u, 'a stdout-only failure still names its cause');

  const runner = emit([
    'Failed WalkRequest_CarriesClassificationKeys [11 ms]',
    '  Error Message:',
    '     Assert.That(request.ClassificationTypeKeys, Is.EqualTo(expected))',
    '  Expected: < "HoClass" >',
    '  But was:  < empty >',
    '  Stack Trace:',
    '     at Paragon.Tests.Catalog.WalkTests.WalkRequest_CarriesClassificationKeys()',
    '   at NUnit.Framework.Internal.AsyncToSyncAdapter.Await(TestExecutionContext context)',
    '   at NUnit.Framework.Internal.Commands.SetUpTearDownItem.RunSetUp(TestExecutionContext context)',
  ]);
  assert.match(runner.diagnostic, /WalkRequest_CarriesClassificationKeys/u, 'the failing test is named');
  assert.match(runner.diagnostic, /But was: {2}< empty >/u, 'the expectation that failed survives');
  assert.doesNotMatch(runner.diagnostic, /AsyncToSyncAdapter/u, 'framework stack frames are not the diagnostic');
  assert.doesNotMatch(runner.diagnostic, /Error Message:$/mu, 'a contentless header does not spend the budget');

  const typedCause = emit([
    'Failed CatalogSync_WhenWalkCompletes_ThenFacetsMerge [2 s]',
    '  Error Message:',
    '   System.Net.Http.HttpRequestException : Connection refused (localhost:5432)',
    '  Stack Trace:',
    '     at Paragon.Tests.Integration.ParagonApiFixture.OneTimeSetUp()',
  ]);
  assert.match(typedCause.diagnostic, /HttpRequestException : Connection refused/u, 'a typed cause is matched by suffix, not word boundary');

  const stderrWins = verificationCommand("echo 'noise on stdout'; echo 'real failure cause' 1>&2; exit 1", process.cwd());
  assert.equal(stderrWins.diagnostic, 'real failure cause');

  const unannounced = verificationCommand("echo 'nothing here looks like a failure'; exit 1", process.cwd());
  assert.match(unannounced.diagnostic, /nothing here looks like a failure/u, 'output that announces nothing falls back to its tail');

  const zeroDiagnostics = emit(['Build FAILED.', '', '    29 Warning(s)', '    0 Error(s)']);
  assert.match(zeroDiagnostics.diagnostic, /parallel worker nodes could not start/u);
  assert.match(zeroDiagnostics.diagnostic, /-m:1/u);
});

test('a Correction Direction steers the one bounded correction and is spent with it', t => {
  const scratch = process.env.CLAUDE_SCRATCH_DIR || path.join(os.homedir(), '.claude-scratch');
  const parent = path.join(scratch, 'my-claude-code', 'pair-vnext-tests');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'direction-'));
  childProcess.execFileSync('git', ['init', '-q'], { cwd: root });
  childProcess.execFileSync('git', ['config', 'user.email', 'pair@test'], { cwd: root });
  childProcess.execFileSync('git', ['config', 'user.name', 'Pair Test'], { cwd: root });
  fs.writeFileSync(path.join(root, 'value.js'), 'module.exports = 1;\n');
  childProcess.execFileSync('git', ['add', '.'], { cwd: root });
  childProcess.execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
  const spec = path.join(parent, `${path.basename(root)}-spec.md`);
  const manifest = path.join(parent, `${path.basename(root)}-slices.json`);
  fs.writeFileSync(spec, '# Spec\n\n## Acceptance Criteria\n\n- [ ] AC-1: value becomes two\n');
  fs.writeFileSync(manifest, JSON.stringify({ schema: 1, work_id: 'work-direction', slices: [{ id: 'S1', acceptance_criteria: ['AC-1'], outcome: 'Existing value returns two.', depends_on: [], verify: 'node verify.js' }] }));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(spec, { force: true }); fs.rmSync(manifest, { force: true }); });
  const opened = openWork(root, { workId: 'work-direction', specPath: spec, manifestPath: manifest, humanLoop: true });

  const prompts = [];
  let verifications = 0;
  const dependencies = {
    runProvider(input) {
      prompts.push(input.prompt);
      fs.writeFileSync(path.join(input.root, 'value.js'), `module.exports = ${prompts.length + 1};\n`);
      return providerResult({ status: 'completed', architecture_risk: null, design_check: null, failure_proof: { boundary: 'module export', method: 'unit', negative_control: 'Returning 1 fails the verification.' }, blocker: null });
    },
    verify() {
      verifications++;
      // First proof fails so the slice reaches correction-ready; everything after passes.
      return verifications === 1
        ? { status: 1, duration_ms: 3, log_digest: 'a'.repeat(64), diagnostic: 'Failed Value_returns_two — Expected: 2 But was: 1' }
        : { status: 0, duration_ms: 3, log_digest: 'b'.repeat(64) };
    },
    hydrate() { return { hydrated: false }; },
  };

  let state = advanceWork(opened.worktree, { runtime: 'codex', reviewPolicy: 'off' }, dependencies);
  assert.equal(state.slices[0].status, 'correction-ready');

  assert.throws(
    () => recordCorrectionDirection(opened.worktree, { text: '' }),
    /requires --text/u,
    'an empty direction is refused',
  );
  assert.throws(
    () => recordCorrectionDirection(opened.worktree, { text: 'x'.repeat(1001) }),
    /1-1000 characters/u,
    'an unbounded direction is refused',
  );

  const direction = 'The value must come from the composition root, not a module-level constant.';
  state = recordCorrectionDirection(opened.worktree, { text: direction });
  assert.equal(state.slices[0].correction_direction, direction);
  assert.ok(state.slices[0].correction_direction_blob, 'the direction is stored as addressable evidence');

  state = advanceWork(opened.worktree, { runtime: 'codex', reviewPolicy: 'off' }, dependencies);
  const correctionPrompt = prompts.at(-1);
  assert.match(correctionPrompt, /Correction Direction \(bounded, human-authored, binding for this correction\)/u);
  assert.match(correctionPrompt, /composition root, not a module-level constant/u);
  assert.match(correctionPrompt, /Expected: 2 But was: 1/u, 'the deterministic failure still travels with it');
  assert.doesNotMatch(
    correctionPrompt.split('Correction Direction')[0],
    /composition root/u,
    'human intent is not smuggled into the falsifiable-evidence array',
  );
  assert.equal(state.slices[0].correction_direction, undefined, 'the direction is spent with the correction it steered');

  // Contract changed deliberately: a direction outside the correction window used to be REFUSED, which
  // made the reducer the gatekeeper of a human who could already see the wrong turn. It is now admitted
  // and the out-of-window use is recorded as a human override, so the steering is auditable rather than
  // forbidden. What must still hold is that it is spent with the attempt it steers, asserted above.
  recordCorrectionDirection(opened.worktree, { text: 'steer the next attempt instead' });
  const steered = readState(opened.worktree);
  assert.equal(steered.slices[0].correction_direction, 'steer the next attempt instead');
  const override = readEvents(opened.worktree, 'work-direction').findLast(event => event.event === 'human-override');
  assert.equal(override.action, 'direct', 'the out-of-window steer is recorded, not silently accepted');
});
