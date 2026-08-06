// AC-1: a slice's first implementation call persists its provider session and records session id,
// runtime and token/cache telemetry in Pair state — for both result-envelope shapes.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { advanceWork } = require('../scripts/lib/pair-engine');
const { readEvents, readState } = require('../scripts/lib/pair-store');
const {
  buildProviderCommand,
  runProviderSession,
  sessionIdFromOutput,
  usageFromOutput,
} = require('../scripts/lib/provider-runtime');
const { completedSlice, greenVerification, openTestWork } = require('./helpers/warm-work');

const COMMON = {
  root: '/repo/worktree',
  prompt: 'bounded prompt',
  schemaPath: '/schema.json',
  schema: { type: 'object' },
  outputPath: '/result.json',
  effort: 'medium',
  model: 'claude-opus-5',
};

// The single JSON envelope produced by --output-format json.
function singleEnvelope() {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: 'a46ff9a9-4c2e-471e-bc1c-fd3a992a5d26',
    total_cost_usd: 0.42,
    structured_output: { status: 'completed' },
    usage: {
      input_tokens: 90,
      cache_read_input_tokens: 3727532,
      cache_creation_input_tokens: 113064,
      output_tokens: 33283,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 113064 },
      iterations: [{ input_tokens: 2, cache_read_input_tokens: 112158, cache_creation_input_tokens: 906 }],
    },
  });
}

// The newline-delimited event stream produced by --output-format stream-json, which is what a run with a
// stream log configured actually writes. Same terminal record, different container.
function eventArray() {
  return [
    JSON.stringify({ type: 'system', subtype: 'hook_started', session_id: 'a46ff9a9-4c2e-471e-bc1c-fd3a992a5d26' }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant' } }),
    singleEnvelope(),
  ].join('\n');
}

test('an implementation call keeps its session while a review still refuses to', () => {
  const implementation = buildProviderCommand({ ...COMMON, runtime: 'claude', mode: 'implementation', persistSession: true });
  assert.ok(!implementation.args.includes('--no-session-persistence'),
    'a session nothing can resume is not a warm session');

  const review = buildProviderCommand({ ...COMMON, runtime: 'claude', mode: 'review' });
  assert.ok(review.args.includes('--no-session-persistence'), 'reviews stay one-shot and leave nothing behind');
  assert.throws(() => buildProviderCommand({ ...COMMON, runtime: 'claude', mode: 'review', persistSession: true }),
    /review is always a fresh session/u, 'and no caller can opt a review into warmth');
  assert.throws(() => buildProviderCommand({ ...COMMON, runtime: 'codex', mode: 'review', resumeSessionId: 'abc' }),
    /review is always a fresh session/u);

  const codex = buildProviderCommand({ ...COMMON, runtime: 'codex', mode: 'implementation', persistSession: true });
  assert.ok(!codex.args.includes('--ephemeral'), '--ephemeral is exactly what makes a codex session unresumable');
  assert.ok(buildProviderCommand({ ...COMMON, runtime: 'codex', mode: 'review' }).args.includes('--ephemeral'));
});

for (const [shape, raw] of [['single envelope', singleEnvelope()], ['event array', eventArray()]]) {
  test(`session id and cache telemetry are read from a ${shape}`, () => {
    assert.equal(sessionIdFromOutput('claude', raw), 'a46ff9a9-4c2e-471e-bc1c-fd3a992a5d26');
    const usage = usageFromOutput('claude', raw);
    assert.equal(usage.cached_input_tokens, 3727532);
    assert.equal(usage.cache_creation_input_tokens, 113064);
    assert.equal(usage.cache_creation_1h_input_tokens, 113064, 'cache writes are priced per TTL tier');
    assert.equal(usage.cache_creation_5m_input_tokens, 0);
    assert.equal(usage.cost_usd, 0.42);
    // Not 90 + 3,727,532 + 113,064: the envelope sums every turn of the session, so summing it would read
    // a long session as a context far larger than any single request ever carried.
    assert.equal(usage.context_tokens, 2 + 112158 + 906,
      'context size is the last request, not the session total');

    const run = runProviderSession({ ...COMMON, runtime: 'claude', mode: 'implementation', persistSession: true },
      { spawnSync: () => ({ status: 0, stdout: raw, stderr: '' }) });
    assert.equal(run.session_id, 'a46ff9a9-4c2e-471e-bc1c-fd3a992a5d26');
    assert.equal(run.resumed, false, 'the first call of a slice opens the session rather than resuming one');
  });
}

test('the first implementation call records the warm session on the Review Slice', t => {
  const opened = openTestWork(t, { prefix: 'capture', workId: 'work-warm-capture' });
  advanceWork(opened.worktree, { runtime: 'claude' }, {
    runProvider(input) {
      assert.equal(input.persistSession, true, 'an implementation call asks for a session worth resuming');
      assert.equal(input.resumeSessionId, null, 'and has none to resume yet');
      fs.writeFileSync(path.join(input.root, 'value.js'), 'module.exports = 2;\n');
      return {
        output: completedSlice(),
        usage: { input_tokens: 900, cached_input_tokens: 17900, cache_creation_input_tokens: 4000, cache_creation_1h_input_tokens: 4000, cache_creation_5m_input_tokens: 0, output_tokens: 300, context_tokens: 22800, cost_usd: 0.09 },
        duration_ms: 5,
        runtime: 'claude',
        model: 'claude-opus-5',
        effort: 'medium',
        session_id: 'warm-abc',
        resumed: false,
      };
    },
    // Held before the slice can be accepted, so the warm session is still on the slice when asserted.
    verify: () => ({ status: 1, duration_ms: 3, diagnostic: 'still red' }),
    hydrate: () => ({ hydrated: false }),
  });

  const state = readState(opened.worktree, opened.workId);
  const warm = state.slices[0].warm_session;
  assert.equal(warm.session_id, 'warm-abc');
  assert.equal(warm.runtime, 'claude');
  assert.equal(warm.context_tokens, 22800);
  assert.equal(warm.calls, 1);

  const call = readEvents(opened.worktree, opened.workId).findLast(event => event.event === 'provider-finished');
  assert.equal(call.session_id, 'warm-abc');
  assert.equal(call.resumed, false);
  assert.equal(call.cached_input_tokens, 17900);
  assert.equal(call.cache_creation_1h_input_tokens, 4000);
  assert.equal(call.context_tokens, 22800);
  assert.equal(call.cost_usd, 0.09);

  const opening = readEvents(opened.worktree, opened.workId).find(event => event.event === 'warm-session-opened');
  assert.equal(opening.session_id, 'warm-abc');
});

// The constraint that keeps this change inert for Work already in flight. A state written before warm
// sessions existed carries no policy, and every read of it has to answer "not enabled" rather than
// "enabled by default" — otherwise the live Work would start persisting sessions mid-flight.
test('a Work opened before warm sessions existed keeps spawning fresh', t => {
  const opened = openTestWork(t, { prefix: 'legacy', workId: 'work-warm-legacy' });
  const paths = require('../scripts/lib/pair-store').workPaths(opened.worktree, opened.workId);
  const state = JSON.parse(fs.readFileSync(paths.state, 'utf8'));
  delete state.warm_session_policy;
  fs.writeFileSync(paths.state, JSON.stringify(state, null, 2));

  let persisted = null;
  advanceWork(opened.worktree, { runtime: 'claude' }, {
    runProvider(input) {
      persisted = input.persistSession;
      fs.writeFileSync(path.join(input.root, 'value.js'), 'module.exports = 2;\n');
      return { output: completedSlice(), usage: {}, duration_ms: 1, runtime: 'claude', model: 'm', effort: 'medium', session_id: 'ignored-abc' };
    },
    verify: greenVerification,
    hydrate: () => ({ hydrated: false }),
  });
  assert.equal(persisted, false, 'no warm-session policy means the fresh-spawn behavior it was opened with');
  assert.equal(readState(opened.worktree, opened.workId).slices[0].warm_session, undefined);
});
