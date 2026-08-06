// AC-10: resume composes with structured-output flags on both runtimes without altering their result
// envelopes. The risk this covers is silent: if --resume and --json-schema were mutually exclusive, or if
// resuming changed the shape of what comes back, every warm call would parse as "produced no structured
// result" and the loop would blame the model.

const assert = require('node:assert/strict');
const test = require('node:test');

const { buildProviderCommand, runProviderSession, structuredOutput } = require('../scripts/lib/provider-runtime');

const COMMON = {
  root: '/repo/worktree',
  prompt: 'bounded prompt',
  schemaPath: '/schema.json',
  schema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { status: { type: 'string' } } },
  outputPath: '/result.json',
  effort: 'medium',
  model: 'claude-opus-5',
  mode: 'implementation',
};

test('claude carries its schema, model and effort into a resumed call unchanged', () => {
  const fresh = buildProviderCommand({ ...COMMON, runtime: 'claude', persistSession: true });
  const warm = buildProviderCommand({ ...COMMON, runtime: 'claude', resumeSessionId: 'sess-1', persistSession: true });

  // A warm session's flag-set has to stay constant or its cached prefix is worthless, so the only
  // difference between these two commands is the resume itself.
  const withoutResume = warm.args.filter((arg, index) => arg !== '--resume' && warm.args[index - 1] !== '--resume');
  assert.deepEqual(withoutResume, fresh.args, 'resuming changed a flag other than --resume');

  const schema = JSON.parse(warm.args[warm.args.indexOf('--json-schema') + 1]);
  assert.equal(schema.$schema, undefined,
    'the claude validator cannot resolve the draft 2020-12 meta-schema ref, so it must not be sent');
  assert.deepEqual(schema.properties, COMMON.schema.properties);
  assert.deepEqual(warm.args.slice(warm.args.indexOf('--model'), warm.args.indexOf('--model') + 2), ['--model', 'claude-opus-5']);
  assert.deepEqual(warm.args.slice(warm.args.indexOf('--effort'), warm.args.indexOf('--effort') + 2), ['--effort', 'medium']);
});

test('codex carries its output schema and last-message file into a resumed call unchanged', () => {
  const fresh = buildProviderCommand({ ...COMMON, runtime: 'codex', persistSession: true });
  const warm = buildProviderCommand({ ...COMMON, runtime: 'codex', resumeSessionId: 'sess-1', persistSession: true });

  for (const flag of ['--output-schema', '--output-last-message', '--model', '--sandbox']) {
    assert.deepEqual(warm.args.slice(warm.args.indexOf(flag), warm.args.indexOf(flag) + 2),
      fresh.args.slice(fresh.args.indexOf(flag), fresh.args.indexOf(flag) + 2),
      `${flag} differs between a fresh and a resumed codex call`);
  }
  assert.deepEqual(warm.args.slice(0, 2), ['exec', 'resume']);
  assert.deepEqual(fresh.args.slice(0, 1), ['exec']);
  assert.deepEqual(warm.args.slice(-2), ['sess-1', 'bounded prompt'],
    'codex fills [SESSION_ID] [PROMPT] in order, so the id sits immediately before the prompt');
});

// The envelope of a resumed run is the same envelope, so the same reader produces the same result.
test('a resumed run returns the same envelope shape a fresh one does', () => {
  const envelope = JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, session_id: 'sess-1',
    structured_output: { status: 'completed' },
    usage: { input_tokens: 3, cache_read_input_tokens: 40000, output_tokens: 120 },
  });
  assert.deepEqual(structuredOutput('claude', envelope, '/unused'), { status: 'completed' });

  const run = runProviderSession({ ...COMMON, runtime: 'claude', resumeSessionId: 'sess-1', persistSession: true },
    { spawnSync: () => ({ status: 0, stdout: envelope, stderr: '' }) });
  assert.deepEqual(run.output, { status: 'completed' });
  assert.equal(run.resumed, true);
  assert.equal(run.session_id, 'sess-1');
  assert.equal(run.usage.cached_input_tokens, 40000);
});
