const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildProviderCommand,
  providerEnvironment,
  runFreshProvider,
  usageFromOutput,
} = require('../scripts/lib/provider-runtime');

test('provider commands are fresh and review commands are read-only', () => {
  const common = { root: '/repo/worktree', prompt: 'bounded prompt', schemaPath: '/schema.json', schema: { type: 'object' }, outputPath: '/result.json', effort: 'medium' };
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
    runtime: 'codex', mode: 'implementation', root: '/repo', prompt: 'SECRET_PROMPT_CANARY', schemaPath: '/schema', outputPath: '/output',
  }, { spawnSync() { return { status: 1, stdout: '', stderr: 'safe failure' }; } }), error => {
    assert.doesNotMatch(error.message, /SECRET_PROMPT_CANARY/u);
    assert.match(error.message, /safe failure/u);
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
