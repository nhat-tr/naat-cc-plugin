const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  appendEvent,
  gitCommonDirectory,
  readEvents,
  readState,
  updatePairRef,
  workPaths,
  writeState,
} = require('../scripts/lib/pair-store');
const {
  determinePath,
  inspectCheckpointRisks,
  renderDesignCheckMarkdown,
} = require('../scripts/lib/architecture-routing');
const { validateManifest } = require('../scripts/lib/review-slice-manifest');
const { createPairWorktree, hydrateWorktree } = require('../scripts/lib/pair-worktree');
const { summarize, timeline } = require('../scripts/pair-report');
const { listReviewOutcomes, recordReviewOutcome } = require('../scripts/lib/review-evidence');

function repository(t) {
  const scratch = process.env.CLAUDE_SCRATCH_DIR || path.join(os.homedir(), '.claude-scratch');
  const parent = path.join(scratch, 'my-claude-code', 'pair-vnext-tests');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'repo-'));
  childProcess.execFileSync('git', ['init', '-q'], { cwd: root });
  childProcess.execFileSync('git', ['config', 'user.email', 'pair@test'], { cwd: root });
  childProcess.execFileSync('git', ['config', 'user.name', 'Pair Test'], { cwd: root });
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'value.js'), 'module.exports = 1;\n');
  childProcess.execFileSync('git', ['add', '.'], { cwd: root });
  childProcess.execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('Pair Work state and checkpoint refs survive linked worktree removal', t => {
  const root = repository(t);
  const linked = path.join(root, '.linked-pair');
  childProcess.execFileSync('git', ['worktree', 'add', '-qb', 'pair/test-work', linked], { cwd: root });
  writeState(linked, 'work-test', { schema: 1, work_id: 'work-test', lifecycle: 'ready' });
  const head = childProcess.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: linked, encoding: 'utf8' }).trim();
  const ref = updatePairRef(linked, 'work-test', 'checkpoints/S1', head);
  const review = recordReviewOutcome(linked, {
    workId: 'work-test', sliceId: 'S1', baseCommit: head, checkpointCommit: head, runtime: 'codex',
    review: { verdict: 'approve', findings: [] },
  });
  const common = gitCommonDirectory(root);

  childProcess.execFileSync('git', ['worktree', 'remove', linked], { cwd: root });

  assert.equal(readState(root, 'work-test').lifecycle, 'ready');
  assert.ok(workPaths(root, 'work-test').state.startsWith(common));
  assert.equal(childProcess.execFileSync('git', ['rev-parse', ref.ref], { cwd: root, encoding: 'utf8' }).trim(), head);
  assert.equal(listReviewOutcomes(root, 'work-test')[0].review_outcome_id, review.outcome.review_outcome_id);
});

test('Pair events reject bulk payload growth and omit prohibited fields', t => {
  const root = repository(t);
  appendEvent(root, 'work-events', { event: 'slice-started', review_slice_id: 'S1', prompt: 'must not persist', patch: 'must not persist' });
  const events = readEvents(root, 'work-events');
  assert.equal(events.length, 1);
  assert.equal(events[0].prompt, undefined);
  assert.equal(events[0].patch, undefined);
  assert.throws(() => appendEvent(root, 'work-events', { event: 'oversized', detail: 'x'.repeat(5000) }), /4096/);
});

test('Review Slice Manifest stays minimal, ordered, and Acceptance-Criteria complete', () => {
  const spec = '# Spec\n\n## Acceptance Criteria\n\n- [ ] AC-1: first behavior\n- [ ] AC-2: second behavior\n';
  const result = validateManifest({
    schema: 1,
    work_id: 'work-manifest',
    slices: [
      { id: 'S1', acceptance_criteria: ['AC-1'], outcome: 'First behavior works.', depends_on: [], verify: 'node --test first.test.js' },
      { id: 'S2', acceptance_criteria: ['AC-2'], outcome: 'Second behavior works.', depends_on: ['S1'], verify: 'node --test second.test.js' },
    ],
  }, spec);
  assert.ok(result.bytes < 16 * 1024);
  assert.deepEqual(Object.keys(result.manifest.slices[0]), ['id', 'acceptance_criteria', 'outcome', 'depends_on', 'verify']);
  assert.throws(() => validateManifest({
    schema: 1,
    work_id: 'work-manifest',
    slices: [{ id: 'S1', acceptance_criteria: ['AC-1'], outcome: 'Only first.', depends_on: [], verify: 'true' }],
  }, spec), /does not cover: AC-2/);
});

test('checkpoint inspection escalates changed state ownership and public contract', t => {
  const root = repository(t);
  const base = childProcess.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(root, 'src', 'registry.js'), 'export class Registry { static value = new Map(); }\n');
  childProcess.execFileSync('git', ['add', '.'], { cwd: root });
  childProcess.execFileSync('git', ['commit', '-qm', 'change'], { cwd: root });
  const result = inspectCheckpointRisks(root, base, 'HEAD');
  assert.ok(result.risks.includes('state or lifetime'));
  assert.ok(result.risks.includes('public or data contract'));
});

test('checkpoint inspection covers dotnet pipelines and workers, React state, remote calls, and replica topology', t => {
  const root = repository(t);
  const base = childProcess.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(root, 'src', 'Program.cs'), [
    'builder.Services.AddHostedService<Worker>();',
    'app.UseAuthentication();',
    'app.UseAuthorization();',
    'var client = new HttpClient();',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'src', 'state.tsx'), 'export const AppState = createContext(null);\n');
  fs.mkdirSync(path.join(root, 'infra'));
  fs.writeFileSync(path.join(root, 'infra', 'deployment.yaml'), 'kind: Deployment\nspec:\n  replicas: 3\n');
  childProcess.execFileSync('git', ['add', '.'], { cwd: root });
  childProcess.execFileSync('git', ['commit', '-qm', 'architecture risks'], { cwd: root });

  const result = inspectCheckpointRisks(root, base, 'HEAD');
  assert.ok(result.risks.includes('request pipeline'));
  assert.ok(result.risks.includes('asynchronous work or eventing'));
  assert.ok(result.risks.includes('state or lifetime'));
  assert.ok(result.risks.includes('remote boundary'));
  assert.ok(result.risks.includes('deployment or replica behavior'));
});

test('architecture routing accepts an open-ended bounded risk and renders a sub-2-KiB Design Check', () => {
  const route = determinePath({
    declaredRisk: 'Middleware order changes authentication behavior behind multiple load-balanced replicas.',
  });
  assert.equal(route.path, 'architecture-sensitive');
  const markdown = renderDesignCheckMarkdown(route.risk, {
    seam: 'Program.cs request pipeline; callers are authenticated API endpoints.',
    ownership: 'ASP.NET host owns stateless middleware; durable state remains external.',
    runtime: 'Every replica applies the same order; failures terminate in ProblemDetails.',
    contract: 'Authentication occurs before authorization without changing endpoint payloads.',
    alternative: 'Reject per-endpoint authentication checks and sticky-session dependence.',
    proof: 'Integration test the pipeline plus a two-replica runtime probe.',
  });
  assert.match(markdown, /^# Design Check/mu);
  assert.ok(Buffer.byteLength(markdown, 'utf8') < 2 * 1024);
});

test('linked worktree hydration reuses a fingerprinted install and rejects undeclared submodules', t => {
  const root = repository(t);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', packageManager: 'npm@11.0.0' }));
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ name: 'fixture', lockfileVersion: 3, packages: {} }));
  childProcess.execFileSync('git', ['add', '.'], { cwd: root });
  childProcess.execFileSync('git', ['commit', '-qm', 'package fixture'], { cwd: root });
  const linked = createPairWorktree(root, { workId: 'work-hydrate' }).path;
  let installs = 0;
  function runner(command, args, options) {
    if (command === 'npm') {
      installs++;
      assert.deepEqual(args.slice(0, 1), ['ci']);
      assert.ok(args.includes('--prefer-offline'));
      fs.mkdirSync(path.join(options.cwd, 'node_modules'), { recursive: true });
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 1, stdout: '', stderr: 'copy-on-write unavailable' };
  }
  const first = hydrateWorktree(root, { workId: 'work-hydrate', worktree: linked, runner });
  const second = hydrateWorktree(root, { workId: 'work-hydrate', worktree: linked, runner });
  assert.equal(first.reused, 'native-cache');
  assert.equal(second.reused, 'existing');
  assert.equal(installs, 1);
  assert.throws(() => hydrateWorktree(root, { workId: 'work-hydrate', worktree: linked, submodules: ['vendor/unknown'], runner }), /undeclared submodule/);
  const exclude = fs.readFileSync(path.join(gitCommonDirectory(root), 'info', 'exclude'), 'utf8');
  assert.match(exclude, /^\.pair-worktrees\/$/mu);
  assert.match(exclude, /^node_modules\/$/mu);
});

test('Pair report reads compact common-directory state instead of historical attempt payloads', t => {
  const root = repository(t);
  writeState(root, 'work-report', {
    schema: 1,
    work_id: 'work-report',
    lifecycle: 'complete',
    branch: 'pair/work-report',
    head_commit: 'a'.repeat(40),
    updated_at: '2026-08-03T00:00:00.000Z',
    slices: [{ id: 'S1', status: 'accepted', route: 'routine', correction_count: 0, checkpoint_commit: 'a'.repeat(40) }],
    invocation_totals: { calls: 1, input_tokens: 100, cached_input_tokens: 60, output_tokens: 20, duration_ms: 10 },
    recent_invocations: [{ kind: 'implementation', input_tokens: 100, cached_input_tokens: 60, output_tokens: 20, duration_ms: 10 }],
  });
  appendEvent(root, 'work-report', { event: 'review-recorded', finding_count: 1 });
  appendEvent(root, 'work-report', { event: 'review-feedback-recorded', disposition: 'false-positive' });
  const report = summarize(root, 'work-report');
  assert.deepEqual(report.totals, { calls: 1, input_tokens: 100, cached_input_tokens: 60, output_tokens: 20, duration_ms: 10 });
  assert.equal(report.review.findings, 1);
  assert.equal(report.review.dispositions['false-positive'], 1);
  assert.ok(fs.statSync(workPaths(root, 'work-report').state).size < 16 * 1024);
});

test('Pair report timeline is bounded and contains only compact review history evidence', t => {
  const rows = Array.from({ length: 700 }, (_value, index) => ({
    sequence: index + 1,
    at: '2026-08-03T00:00:00.000Z',
    event: index % 2 ? 'review-recorded' : 'review-feedback-recorded',
    review_slice_id: `S${index % 40}`,
    review_outcome_id: `review-${index}`,
    finding_id: `finding-${index}`,
    disposition: 'false-positive',
    prompt: 'must not appear',
    patch: 'must not appear',
    diagnostic: 'must not appear',
  }));
  rows.push({ sequence: 701, at: '2026-08-03T00:00:01.000Z', event: 'provider-finished', input_tokens: 999 });

  const result = timeline(rows);
  const serialized = JSON.stringify(result);
  assert.equal(result.event_count, 700);
  assert.ok(result.omitted_event_count > 0);
  assert.ok(Buffer.byteLength(serialized, 'utf8') <= 32 * 1024);
  assert.doesNotMatch(serialized, /must not appear|provider-finished|input_tokens/u);
  assert.equal(result.events.at(-1).sequence, 700);
});

test('Pair state stays below 16 KiB with forty compact accepted slices and only recent invocation detail', t => {
  const root = repository(t);
  const state = {
    schema: 1,
    product: 'pair-evidence-at-commit',
    work_id: 'work-max-state',
    lifecycle: 'complete',
    branch: 'pair/work-max-state',
    worktree: '/bounded/worktree',
    base_commit: 'a'.repeat(40),
    head_commit: 'b'.repeat(40),
    invocation_totals: { calls: 100, input_tokens: 100000, cached_input_tokens: 50000, output_tokens: 10000, duration_ms: 100000 },
    recent_invocations: Array.from({ length: 3 }, (_value, index) => ({
      kind: 'review', review_slice_id: `S${index + 38}`, runtime: 'codex', model: 'default', effort: 'medium',
      input_tokens: 1000, cached_input_tokens: 500, output_tokens: 100, duration_ms: 1000,
    })),
    slices: Array.from({ length: 40 }, (_value, index) => ({
      id: `S${index + 1}`,
      status: 'accepted',
      base_commit: 'a'.repeat(40),
      checkpoint_commit: 'b'.repeat(40),
      route: index % 2 ? 'routine' : 'architecture-sensitive',
      correction_count: 0,
    })),
  };
  writeState(root, state.work_id, state);
  assert.ok(fs.statSync(workPaths(root, state.work_id).state).size < 16 * 1024);
});
