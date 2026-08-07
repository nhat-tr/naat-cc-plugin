// Per-process machine scope: the real machine lease is global, and parallel test files would refuse
// each other's verifications. Required before the engine, so the env var is set when pair-store reads it.
require('./isolate-machine-lease');

const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openWork } = require('../../scripts/lib/pair-engine');

// Warm-session behavior is decided by ~/.config/pair/config.json, so a test that read the developer's own
// file would pass or fail on their preferences. Every fixture points XDG_CONFIG_HOME at a directory it
// writes itself, which also makes the non-default settings directly testable.
function withPairConfig(t, config) {
  const parent = scratchParent();
  const home = fs.mkdtempSync(path.join(parent, 'config-'));
  fs.mkdirSync(path.join(home, 'pair'), { recursive: true });
  fs.writeFileSync(path.join(home, 'pair', 'config.json'), JSON.stringify(config ?? {}));
  const saved = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = home;
  t.after(() => {
    if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved;
    fs.rmSync(home, { recursive: true, force: true });
  });
  return home;
}

function scratchParent() {
  const scratch = process.env.CLAUDE_SCRATCH_DIR || path.join(os.homedir(), '.claude-scratch');
  const parent = path.join(scratch, 'my-claude-code', 'pair-warm-tests');
  fs.mkdirSync(parent, { recursive: true });
  return parent;
}

const DEFAULT_SLICES = [{
  id: 'S1',
  acceptance_criteria: ['AC-1'],
  outcome: 'Existing value returns two.',
  depends_on: [],
  verify: 'node verify.js',
}];

const DEFAULT_SPEC_MARKDOWN = '# Spec\n\n## Acceptance Criteria\n\n- [ ] AC-1: value becomes two\n';

// One Pair Work on a throwaway repository, opened and ready to run. `config` is written before openWork
// so the Work pins the policy under test — the policy is pinned at open and never re-read afterwards.
// `specMarkdown` is a minimal escape hatch for callers that need the specification body itself under
// test (extra Acceptance Criteria, prose that must not leak into a projection) rather than just the slices.
// `files` adds tracked files to the base commit, for a test that needs code the Review Slice never edits.
//
// human_in_the_loop_default is pinned true here and overridable per fixture: almost every test in this
// suite is about a gate a human stands in, and the shipped default drives past those gates. The default
// itself is asserted where it is decided, on humanLoopSettings.
function openTestWork(t, {
  prefix = 'warm',
  workId = 'work-warm',
  slices = DEFAULT_SLICES,
  specMarkdown = DEFAULT_SPEC_MARKDOWN,
  files = {},
  config = {},
} = {}) {
  withPairConfig(t, { default_model: 'test-model', human_in_the_loop_default: true, ...config });
  const parent = scratchParent();
  const root = fs.mkdtempSync(path.join(parent, `${prefix}-`));
  childProcess.execFileSync('git', ['init', '-q'], { cwd: root });
  childProcess.execFileSync('git', ['config', 'user.email', 'pair@test'], { cwd: root });
  childProcess.execFileSync('git', ['config', 'user.name', 'Pair Test'], { cwd: root });
  fs.writeFileSync(path.join(root, 'value.js'), 'module.exports = 1;\n');
  for (const [relative, contents] of Object.entries(files)) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }
  childProcess.execFileSync('git', ['add', '.'], { cwd: root });
  childProcess.execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
  const spec = path.join(parent, `${path.basename(root)}-spec.md`);
  const manifest = path.join(parent, `${path.basename(root)}-slices.json`);
  fs.writeFileSync(spec, specMarkdown);
  fs.writeFileSync(manifest, JSON.stringify({ schema: 1, work_id: workId, slices }));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(spec, { force: true });
    fs.rmSync(manifest, { force: true });
  });
  const opened = openWork(root, { workId, specPath: spec, manifestPath: manifest });
  return { root, workId, spec, manifest, worktree: opened.worktree, state: opened.state };
}

// The envelope a provider returns after a successful call, with every field the warm-session bookkeeping
// reads. Defaults describe a fresh first call so a test only states what it is actually about.
function providerResult(output, overrides = {}) {
  const { usage = {}, ...rest } = overrides;
  return {
    output,
    usage: {
      input_tokens: 100,
      cached_input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_creation_5m_input_tokens: 0,
      cache_creation_1h_input_tokens: 0,
      output_tokens: 20,
      context_tokens: 1000,
      cost_usd: 0.01,
      ...usage,
    },
    duration_ms: 5,
    runtime: 'claude',
    model: 'test-model',
    effort: 'medium',
    session_id: 'session-1',
    resumed: false,
    ...rest,
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

function greenVerification() {
  return { status: 0, duration_ms: 3, log_digest: 'a'.repeat(64) };
}

module.exports = {
  completedSlice,
  greenVerification,
  openTestWork,
  providerResult,
  scratchParent,
  withPairConfig,
};
