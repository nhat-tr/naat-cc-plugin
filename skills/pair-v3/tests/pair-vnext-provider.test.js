const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildProviderCommand,
  providerEnvironment,
  runFreshProvider,
  usageFromOutput,
} = require('../scripts/lib/provider-runtime');

test('provider commands are fresh and review commands are read-only', () => {
  const common = { root: '/repo/worktree', prompt: 'bounded prompt', schemaPath: '/schema.json', schema: { type: 'object' }, outputPath: '/result.json', effort: 'medium', model: 'claude-opus-5' };
  const codex = buildProviderCommand({ ...common, runtime: 'codex', mode: 'review' });
  assert.ok(codex.args.includes('--ephemeral'));
  assert.deepEqual(codex.args.slice(codex.args.indexOf('--sandbox'), codex.args.indexOf('--sandbox') + 2), ['--sandbox', 'read-only']);
  assert.doesNotMatch(codex.args.join(' '), /resume|continue|fork/iu);
  const claude = buildProviderCommand({ ...common, runtime: 'claude', mode: 'review' });
  assert.ok(claude.args.includes('--no-session-persistence'));
  assert.match(claude.args.join(' '), /--disallowedTools Edit,Write,NotebookEdit,Task/u);
  assert.doesNotMatch(claude.args.join(' '), /resume|continue|fork/iu);
});

test('provider environment strips nested identities and failures expose no raw prompt', () => {
  const env = providerEnvironment({ PATH: '/usr/bin', CODEX_THREAD_ID: 'nested', CLAUDE_CODE_SESSION_ID: 'nested-too' });
  assert.equal(env.CODEX_THREAD_ID, undefined);
  assert.equal(env.CLAUDE_CODE_SESSION_ID, undefined);
  assert.equal(env.PAIR_STOP_GATE, 'off');
  assert.throws(() => runFreshProvider({
    runtime: 'codex', mode: 'implementation', root: '/repo', prompt: 'SECRET_PROMPT_CANARY', schemaPath: '/schema', outputPath: '/output', model: 'gpt-5',
  }, { spawnSync() { return { status: 1, stdout: '', stderr: 'safe failure' }; } }), error => {
    assert.doesNotMatch(error.message, /SECRET_PROMPT_CANARY/u);
    assert.match(error.message, /safe failure/u);
    return true;
  });
});

test('an over-cap structured result names the overage and still persists no transcript', () => {
  const oversized = { status: 'design-required', architecture_risk: 'SECRET_PROMPT_CANARY'.padEnd(3000, '!') };
  const stdout = JSON.stringify({ type: 'result', structured_output: oversized });
  const actualBytes = Buffer.byteLength(JSON.stringify(oversized), 'utf8');

  assert.throws(() => runFreshProvider({
    runtime: 'claude', mode: 'implementation', root: '/repo', prompt: 'bounded prompt', schemaPath: '/schema', schema: { type: 'object' }, outputPath: '/output', model: 'claude-opus-5', maxOutputBytes: 2048,
  }, { spawnSync() { return { status: 0, stdout, stderr: '' }; } }), error => {
    // Both numbers, so a retry can tell "shorten the return" from "the cap is wrong for this mode".
    assert.match(error.message, /exceeds 2048 UTF-8 bytes/u);
    assert.match(error.message, new RegExp(`returned ${actualBytes}`, 'u'));
    // The rejected result is discarded rather than journaled, so its content must not leak either.
    assert.doesNotMatch(error.message, /SECRET_PROMPT_CANARY/u);
    return true;
  });
});

test('provider telemetry extracts bounded usage without persisting transcript content', () => {
  const raw = [
    JSON.stringify({ type: 'item.completed', text: 'not telemetry' }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 120, cached_input_tokens: 80, output_tokens: 15, reasoning_output_tokens: 5 } }),
  ].join('\n');
  assert.deepEqual(usageFromOutput('codex', raw), {
    input_tokens: 120,
    cached_input_tokens: 80,
    cache_creation_input_tokens: 0,
    output_tokens: 15,
    reasoning_tokens: 5,
    cost_usd: null,
  });
});

// `model: 'default'` used to mean "pass no --model and let the CLI decide", and what it decided was the
// model the human had selected for their own interactive sessions. Switching that mid-Work silently changed
// which model implemented and reviewed the next Review Slice — observed live, where one S-05 round ran fable
// while every earlier round of the same Work ran opus. The provider layer now refuses rather than inherits.
test('a provider call refuses to inherit whichever model the human last selected', () => {
  const base = { runtime: 'claude', mode: 'review', root: '/repo', prompt: 'p', schemaPath: '/s', schema: { type: 'object' }, outputPath: '/o' };
  for (const model of [undefined, 'default']) {
    assert.throws(() => buildProviderCommand({ ...base, model }), /explicit model/u, `model=${String(model)} must be refused`);
    assert.throws(() => buildProviderCommand({ ...base, runtime: 'codex', model }), /explicit model/u);
  }
  const pinned = buildProviderCommand({ ...base, model: 'claude-opus-5' });
  assert.deepEqual(pinned.args.slice(pinned.args.indexOf('--model'), pinned.args.indexOf('--model') + 2), ['--model', 'claude-opus-5'],
    'and passes the pinned model every time, not only when it differs from a notion of default');
});

// The journal recorded `model: default` for every call, so the round that ran fable was indistinguishable
// from the ones that ran opus. What the session reports about itself is the only trustworthy answer.
test('the recorded model is the one the session ran, not the one requested', () => {
  const stream = [
    JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-fable-5' }),
    JSON.stringify({ type: 'result', subtype: 'success', structured_output: { status: 'completed' } }),
  ].join('\n');
  const run = runFreshProvider(
    { runtime: 'claude', mode: 'implementation', root: '/repo', prompt: 'p', schemaPath: '/s', schema: { type: 'object' }, outputPath: '/o', model: 'claude-opus-5' },
    { spawnSync() { return { status: 0, stdout: stream, stderr: '' }; } },
  );
  assert.equal(run.model, 'claude-fable-5', 'the record names what actually answered, so a mismatch is visible');
});
