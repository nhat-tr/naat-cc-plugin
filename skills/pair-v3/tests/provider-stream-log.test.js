const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildProviderCommand,
  runProviderSession,
  structuredOutput,
  usageFromOutput,
} = require('../scripts/lib/provider-runtime');

// Pair deliberately keeps evidence at commits rather than in transcripts, so a fresh provider session
// is unobservable while it runs: --output-format json emits one blob at exit and spawnSync buffers it
// in memory. That is right for the durable record and wrong for a human watching a 20-minute run with
// no idea whether it is working or wedged. Streaming is therefore opt-in: PAIR_STREAM_LOG turns the
// same invocation into newline-delimited events written straight to a file as they arrive, so the
// default contract is unchanged and nothing is persisted unless the operator asks for it.
function common() {
  return {
    root: '/repo/worktree',
    prompt: 'bounded prompt',
    schemaPath: '/schema.json',
    schema: { type: 'object' },
    outputPath: '/result.json',
    effort: 'medium',
    // Explicit, because a Pair call now refuses to inherit the ambient model.
    model: 'claude-opus-5',
  };
}

test('a Claude provider command streams newline-delimited events only when a stream log is requested', () => {
  const quiet = buildProviderCommand({ ...common(), runtime: 'claude', mode: 'implementation' });
  assert.ok(quiet.args.includes('json'), 'the default stays a single JSON envelope');
  assert.equal(quiet.args.includes('stream-json'), false);
  assert.equal(quiet.args.includes('--include-partial-messages'), false);

  const streaming = buildProviderCommand({ ...common(), runtime: 'claude', mode: 'implementation', streamLog: '/tmp/pair-stream.jsonl' });
  const format = streaming.args[streaming.args.indexOf('--output-format') + 1];
  assert.equal(format, 'stream-json');
  assert.ok(streaming.args.includes('--verbose'), 'stream-json with --print requires --verbose');
  assert.ok(streaming.args.includes('--include-partial-messages'), 'partial chunks are what make it readable live');
  assert.equal(streaming.args.includes('--no-session-persistence'), true, 'streaming still persists no session');
});

test('the structured result is recovered from newline-delimited events as well as a single envelope', () => {
  const envelope = { type: 'result', structured_output: { status: 'completed' }, usage: { input_tokens: 10, output_tokens: 4 } };
  const ndjson = [
    JSON.stringify({ type: 'system', subtype: 'init' }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } }),
    JSON.stringify(envelope),
  ].join('\n');

  assert.deepEqual(structuredOutput('claude', ndjson, '/unused'), { status: 'completed' });
  assert.deepEqual(structuredOutput('claude', JSON.stringify(envelope), '/unused'), { status: 'completed' });
});

test('provider telemetry is read from newline-delimited events without carrying their text', () => {
  const ndjson = [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'PRIVATE_REASONING_CANARY' }] } }),
    JSON.stringify({ type: 'result', usage: { input_tokens: 120, cache_read_input_tokens: 80, output_tokens: 15 }, total_cost_usd: 0.5 }),
  ].join('\n');

  const usage = usageFromOutput('claude', ndjson);

  assert.equal(usage.input_tokens, 120);
  assert.equal(usage.cached_input_tokens, 80);
  assert.equal(usage.output_tokens, 15);
  assert.equal(usage.cost_usd, 0.5);
  assert.doesNotMatch(JSON.stringify(usage), /CANARY/u, 'telemetry never carries transcript content');
});

test('a requested stream log receives the provider events and still yields the structured result', t => {
  const directory = fs.mkdtempSync(path.join(process.env.CLAUDE_SCRATCH_DIR || os.tmpdir(), 'pair-stream-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const streamLog = path.join(directory, 'run.jsonl');
  const events = [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'reading the seam' }] } }),
    JSON.stringify({ type: 'result', structured_output: { status: 'completed' }, usage: { output_tokens: 7 } }),
  ].join('\n');

  const result = runProviderSession(
    { ...common(), runtime: 'claude', mode: 'implementation', streamLog },
    {
      spawnSync(file, args, options) {
        // The child writes to the log itself via an inherited descriptor, which is what makes the file
        // readable while the run is still going rather than only after it exits.
        assert.equal(typeof options.stdio[1], 'number', 'stdout is redirected to the log descriptor');
        fs.writeSync(options.stdio[1], events);
        return { status: 0, stdout: null, stderr: '' };
      },
    },
  );

  assert.deepEqual(result.output, { status: 'completed' });
  assert.equal(result.usage.output_tokens, 7);
  assert.match(fs.readFileSync(streamLog, 'utf8'), /reading the seam/u);
});

// "Claude produced no structured result" was true of a crash, a refusal, a timeout and an exhausted retry
// loop alike, and only the last of those means "the session worked, the schema is what it could not
// satisfy". The provider states which in its terminal result record, so the diagnosis is free.
test('an exhausted structured-output retry loop is named by its cause and keeps its telemetry', () => {
  const streamLog = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pair-stream-fail-')), 'run.jsonl');
  const events = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abc' }),
    JSON.stringify({ type: 'result', subtype: 'error_max_structured_output_retries', is_error: true, num_turns: 27, usage: { input_tokens: 48, output_tokens: 25969 } }),
  ].join('\n') + '\n';

  let thrown = null;
  try {
    runProviderSession(
      { runtime: 'claude', mode: 'review', root: process.cwd(), prompt: 'p', schemaPath: '/tmp/schema.json', schema: {}, outputPath: '/tmp/out.json', model: 'claude-opus-5', streamLog },
      // Written from inside the stub, because openStreamLog opens the log with 'w': anything staged before
      // the spawn is truncated away, exactly as the real child's first write would truncate it.
      { spawnSync: () => { fs.writeFileSync(streamLog, events); return { status: 0, stdout: '', stderr: '' }; } },
    );
  } catch (error) { thrown = error; }

  assert.ok(thrown, 'the run still fails');
  assert.match(thrown.message, /error_max_structured_output_retries/u, 'the cause is named');
  assert.match(thrown.message, /27 turns/u, 'with how far it got');
  assert.equal(thrown.pair_invocation.failure, 'error_max_structured_output_retries');
  assert.equal(thrown.pair_invocation.usage.output_tokens, 25969, 'and the cost survives the exception');
});

// A slice legitimately runs the same kind twice — a review after a correction, a retried review after a
// provider failure — and streamLogPath names the file by slice and kind alone so the watcher can find it.
// Opening with 'w' made every later run silently erase the record of the one before it.
test('a second run of the same slice and kind appends to the stream log instead of erasing the first', () => {
  const directory = fs.mkdtempSync(path.join(process.env.CLAUDE_SCRATCH_DIR || os.tmpdir(), 'pair-stream-append-'));
  const streamLog = path.join(directory, 'run.jsonl');
  const invoke = marker => runProviderSession(
    { ...common(), runtime: 'claude', mode: 'implementation', streamLog },
    {
      spawnSync(file, args, options) {
        fs.writeSync(options.stdio[1], [
          JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: marker }] } }),
          JSON.stringify({ type: 'result', structured_output: { status: 'completed' }, usage: { output_tokens: 7 } }),
        ].join('\n') + '\n');
        return { status: 0, stdout: null, stderr: '' };
      },
    },
  );

  invoke('first run marker');
  invoke('second run marker');

  const log = fs.readFileSync(streamLog, 'utf8');
  assert.match(log, /first run marker/u, 'the earlier run survives the later one');
  assert.match(log, /second run marker/u);
  fs.rmSync(directory, { recursive: true, force: true });
});
