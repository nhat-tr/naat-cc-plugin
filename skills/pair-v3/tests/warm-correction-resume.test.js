// AC-2: a correction dispatch for a slice holding a warm session resumes that session instead of
// spawning fresh, and its prompt carries only call-variable content — no slice-stable package.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { advanceWork } = require('../scripts/lib/pair-engine');
const { readState } = require('../scripts/lib/pair-store');
const { KIND_BOILERPLATE } = require('../scripts/lib/pair-prompts');
const { buildProviderCommand } = require('../scripts/lib/provider-runtime');
const { completedSlice, greenVerification, openTestWork } = require('./helpers/warm-work');

const COMMON = {
  root: '/repo/worktree',
  prompt: 'bounded prompt',
  schemaPath: '/schema.json',
  schema: { type: 'object' },
  outputPath: '/result.json',
  effort: 'medium',
  model: 'claude-opus-5',
  mode: 'implementation',
};

function warmRun(session, overrides = {}) {
  return {
    output: completedSlice(),
    usage: { input_tokens: 5, cached_input_tokens: 20000, output_tokens: 200, context_tokens: 25000 },
    duration_ms: 4,
    runtime: 'claude',
    model: 'test-model',
    effort: 'medium',
    session_id: session,
    ...overrides,
  };
}

test('both runtimes resume by session id rather than starting over', () => {
  const claude = buildProviderCommand({ ...COMMON, runtime: 'claude', resumeSessionId: 'sess-9', persistSession: true });
  assert.deepEqual(claude.args.slice(claude.args.indexOf('--resume'), claude.args.indexOf('--resume') + 2), ['--resume', 'sess-9']);
  assert.ok(!claude.args.includes('--no-session-persistence'), 'a resumed session must stay persisted for the next round');

  const codex = buildProviderCommand({ ...COMMON, runtime: 'codex', resumeSessionId: 'sess-9', persistSession: true });
  assert.deepEqual(codex.args.slice(0, 2), ['exec', 'resume'], 'codex resumes through its own subcommand');
  assert.ok(!codex.args.includes('--ephemeral'));
  // `codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]`: the two positionals are filled in order, so the
  // session id has to be the argument immediately before the prompt.
  assert.deepEqual(codex.args.slice(-2), ['sess-9', 'bounded prompt']);
});

test('a correction on a warm slice resumes it and re-sends no slice-stable package', t => {
  const opened = openTestWork(t, { prefix: 'resume', workId: 'work-warm-resume' });
  const calls = [];
  const dependencies = {
    runProvider(input) {
      calls.push(input);
      fs.writeFileSync(path.join(input.root, 'value.js'), `module.exports = ${calls.length + 1};\n`);
      return warmRun('sess-warm', { resumed: Boolean(input.resumeSessionId) });
    },
    // Red on the first attempt so the slice lands at correction-ready, green on the correction.
    verify: () => (calls.length === 1
      ? { status: 1, duration_ms: 2, diagnostic: 'value is still 1' }
      : greenVerification()),
    hydrate: () => ({ hydrated: false }),
  };

  advanceWork(opened.worktree, { runtime: 'claude' }, dependencies);
  assert.equal(readState(opened.worktree, opened.workId).slices[0].status, 'correction-ready');

  advanceWork(opened.worktree, { runtime: 'claude' }, dependencies);
  assert.equal(calls.length, 2, 'the correction is a second call, not a second Work');
  const [implementation, correction] = calls;
  assert.equal(implementation.resumeSessionId, null);
  assert.equal(correction.resumeSessionId, 'sess-warm', 'the correction continues the session that wrote the code');

  // The whole point of continuity: the session already holds the outcome and the acceptance criteria, so
  // re-sending them is paying twice for the thing continuity exists to avoid.
  assert.ok(correction.prompt.startsWith(KIND_BOILERPLATE.correction),
    'a correction still opens with its invariant boilerplate');
  assert.doesNotMatch(correction.prompt, /Acceptance Criteria/u);
  assert.doesNotMatch(correction.prompt, /Existing value returns two\./u);
  assert.doesNotMatch(correction.prompt, /Review Slice: S1/u);
  // What it does carry is the evidence the session cannot already know.
  assert.match(correction.prompt, /Declared verification failed\./u);
  assert.match(correction.prompt, /value is still 1/u);

  // Compared against what the same correction would have said with no warm session to lean on.
  assert.ok(implementation.prompt.includes('Acceptance Criteria'),
    'a cold call still carries the full slice-stable package');
});

test('a cold correction still carries the slice-stable package', t => {
  const opened = openTestWork(t, { prefix: 'cold', workId: 'work-cold-correction', config: { warm_session_enabled: false } });
  const calls = [];
  const dependencies = {
    runProvider(input) {
      calls.push(input);
      fs.writeFileSync(path.join(input.root, 'value.js'), `module.exports = ${calls.length + 1};\n`);
      return warmRun('sess-cold');
    },
    verify: () => (calls.length === 1
      ? { status: 1, duration_ms: 2, diagnostic: 'value is still 1' }
      : greenVerification()),
    hydrate: () => ({ hydrated: false }),
  };
  advanceWork(opened.worktree, { runtime: 'claude' }, dependencies);
  advanceWork(opened.worktree, { runtime: 'claude' }, dependencies);

  const correction = calls[1];
  assert.equal(correction.resumeSessionId, null, 'disabled means exactly the fresh-spawn loop as it was');
  assert.equal(correction.persistSession, false);
  assert.match(correction.prompt, /Acceptance Criteria/u, 'so the fresh session needs the full package');
  assert.match(correction.prompt, /Declared verification failed\./u);
});
