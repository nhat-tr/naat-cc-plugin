const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  REVIEW_OUTPUT_LIMIT_BYTES,
  SLICE_OUTPUT_LIMIT_BYTES,
  acceptHumanReview,
  adjudicateFinding,
  advanceWork,
  openWork,
} = require('../scripts/lib/pair-engine');
const { blobAtCommit, readState, workPaths } = require('../scripts/lib/pair-store');
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
  const opened = openWork(root, { workId: 'work-engine', specPath: spec, manifestPath: manifest });
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
  const opened = openWork(root, { workId: 'work-architecture', specPath: spec, manifestPath: manifest });
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
  const opened = openWork(root, { workId: 'work-feedback', specPath: spec, manifestPath: manifest });
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
  const opened = openWork(root, { workId: 'work-composition', specPath: spec, manifestPath: manifest });
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
