const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { redactString } = require('./pair-store');

const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024;

const NESTED_SESSION_ENV_KEYS = [
  'CODEX_THREAD_ID',
  'CLAUDECODE',
  'CLAUDE_CODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_PARENT_SESSION_ID',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_SESSION_ID',
  'CLAUDE_SESSION_ID_OVERRIDE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SSE_PORT',
];

function providerEnvironment(source = process.env) {
  const env = {
    ...source,
    PATH: String(source.PATH || '').split(path.delimiter).filter(entry => entry && !entry.includes('cmux-cli-shims')).join(path.delimiter),
    PAIR_STOP_GATE: 'off',
    CLAUDE_STOP_GATE: 'off',
    // Keeps a sandboxed child from stranding a generation of MSBuild worker nodes on every attempt.
    MSBUILDDISABLENODEREUSE: '1',
  };
  for (const key of NESTED_SESSION_ENV_KEYS) delete env[key];
  return env;
}

// The one place that could inherit an ambient model, so the one place that refuses to. Omitting --model let
// the CLI fall back to whatever the human last chose for their own sessions, which meant switching model
// mid-Work silently changed who implemented and reviewed the next Review Slice.
function requireExplicitModel(model) {
  if (model && model !== 'default') return;
  throw new Error('a Pair run needs an explicit model, and will not inherit the one your interactive sessions are set to. Pin it with default_model in ~/.config/pair/config.json, or pass --model <id>.');
}

function buildProviderCommand({ runtime, mode, root, prompt, schemaPath, schema, outputPath, model = null, effort = 'medium', streamLog = null }) {
  if (!['implementation', 'review'].includes(mode)) throw new Error(`unsupported provider mode ${mode}`);
  if (runtime === 'codex') {
    const args = [
      'exec',
      '--json',
      '--ephemeral',
      '--sandbox', mode === 'review' ? 'read-only' : 'workspace-write',
      '-C', root,
      '--output-schema', schemaPath,
      '--output-last-message', outputPath,
    ];
    requireExplicitModel(model);
    args.push('--model', model);
    if (effort && effort !== 'default') args.push('-c', `model_reasoning_effort="${effort}"`);
    args.push(prompt);
    return { file: 'codex', args, cwd: root };
  }
  if (runtime === 'claude') {
    const args = [
      '-p', prompt,
      // stream-json turns the run into events as they happen, which is the only way to watch a
      // 20-minute fresh session. --verbose is not optional: the CLI requires it to stream under
      // --print. The session itself is still never persisted either way.
      '--output-format', streamLog ? 'stream-json' : 'json',
      ...(streamLog ? ['--verbose', '--include-partial-messages'] : []),
      '--no-session-persistence',
      '--permission-mode', mode === 'review' ? 'dontAsk' : 'acceptEdits',
    ];
    if (mode === 'review') args.push('--disallowedTools', 'Edit,Write,NotebookEdit,Task');
    // The Claude CLI validator cannot resolve the draft 2020-12 meta-schema ref, so it rejects any
    // schema declaring it. Codex reads the same file via schemaPath and keeps the declaration.
    const { $schema: _declaredDraft, ...claudeSchema } = schema;
    args.push('--json-schema', JSON.stringify(claudeSchema));
    // Always, never conditionally: omitting it is what let ~/.claude/settings.json decide for a Pair run.
    requireExplicitModel(model);
    args.push('--model', model);
    if (effort && effort !== 'default') args.push('--effort', effort);
    return { file: 'claude', args, cwd: root };
  }
  throw new Error(`unsupported runtime ${runtime}`);
}

// A Claude run reports itself either as one JSON envelope (--output-format json) or as newline-
// delimited events (--output-format stream-json, used when a stream log is requested). Both end with
// the same `result` envelope, so resolving it in one place lets the two formats be interchangeable and
// keeps the streaming switch from rippling into every parser.
function openStreamLog(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // Append: the path names only slice and kind, and a retried review or a post-correction re-review is
  // the same slice and kind again — truncating here erased the record of the run before it.
  return fs.openSync(file, 'a', 0o600);
}

function claudeEnvelope(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.findLast(item => item?.type === 'result') || parsed.at(-1);
    return parsed;
  } catch {
    const events = text.split(/\r?\n/u).filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
    return events.findLast(item => item?.type === 'result') || events.at(-1) || null;
  }
}

// The terminal result record, whether or not it carried usable output. claudeEnvelope already prefers it,
// but falls back to the last event of any kind, so it cannot be trusted to be the result when the run failed.
function claudeResultRecord(raw) {
  const envelope = claudeEnvelope(raw);
  return envelope?.type === 'result' ? envelope : null;
}

// What the session reported running, not what was asked for. The journal recorded `model: default` for
// every call, so it could not distinguish the round that ran fable from the ones that ran opus — the record
// has to name the model that actually produced the checkpoint.
function modelFromOutput(runtime, raw) {
  if (runtime !== 'claude') return null;
  for (const line of String(raw || '').split(/\r?\n/u).filter(Boolean)) {
    try {
      const parsed = JSON.parse(line);
      if (parsed?.type === 'system' && parsed.subtype === 'init' && parsed.model) return parsed.model;
      if (parsed?.type === 'result' && parsed.model) return parsed.model;
    } catch { /* a partial or non-record line */ }
  }
  return null;
}

function usageFromOutput(runtime, raw) {
  const empty = { input_tokens: 0, cached_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, cost_usd: null };
  if (!String(raw || '').trim()) return empty;
  if (runtime === 'codex') {
    const events = String(raw).split(/\r?\n/u).filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
    const usage = [...events].reverse().find(event => event.type === 'turn.completed')?.usage || {};
    return {
      input_tokens: usage.input_tokens || 0,
      cached_input_tokens: usage.cached_input_tokens || 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
      output_tokens: usage.output_tokens || 0,
      reasoning_tokens: usage.reasoning_output_tokens || 0,
      cost_usd: null,
    };
  }
  const envelope = claudeEnvelope(raw);
  if (!envelope) return empty;
  const usage = envelope?.usage || envelope?.result?.usage || {};
  return {
    input_tokens: usage.input_tokens || usage.inputTokens || 0,
    cached_input_tokens: usage.cache_read_input_tokens || usage.cached_input_tokens || 0,
    cache_creation_input_tokens: usage.cache_creation_input_tokens || usage.cacheCreationInputTokens || 0,
    output_tokens: usage.output_tokens || usage.outputTokens || 0,
    reasoning_tokens: usage.reasoning_tokens || 0,
    cost_usd: Number.isFinite(envelope?.total_cost_usd) ? envelope.total_cost_usd : null,
  };
}

function structuredOutput(runtime, raw, outputPath) {
  if (runtime === 'codex') {
    if (!fs.existsSync(outputPath)) throw new Error('Codex produced no structured result');
    return JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  }
  const envelope = claudeEnvelope(raw);
  const candidate = envelope?.structured_output ?? envelope?.result?.structured_output ?? envelope?.result;
  if (!candidate || typeof candidate !== 'object') {
    // "produced no structured result" is true of a crash, a refusal, a timeout and an exhausted retry loop
    // alike, and the next attempt needs to know which. The provider states it in the terminal result record
    // (error_max_structured_output_retries after 27 turns, say), and that subtype is the whole diagnosis:
    // the session worked, the schema is what it could not satisfy. Turn count and subtype carry no
    // transcript content, so naming them keeps the no-persisted-transcript contract intact.
    const failure = claudeResultRecord(raw);
    if (failure?.subtype) {
      throw new Error(`Claude ended with ${failure.subtype}`
        + `${failure.num_turns ? ` after ${failure.num_turns} turns` : ''}`
        + ' — the session ran but never returned output matching the required schema');
    }
    throw new Error('Claude produced no structured result');
  }
  return candidate;
}

function runFreshProvider(input, dependencies = {}) {
  const started = Date.now();
  const command = buildProviderCommand(input);
  const spawnSync = dependencies.spawnSync || childProcess.spawnSync;
  // Handing the child a file descriptor rather than a pipe is what makes the log readable *during* the
  // run: the events land in the file as the child writes them, with no async rewrite of this function
  // and no 8 MB maxBuffer ceiling on the captured output.
  const logDescriptor = input.streamLog ? openStreamLog(input.streamLog) : null;
  let result;
  try {
    result = spawnSync(command.file, command.args, {
      cwd: command.cwd,
      env: providerEnvironment(dependencies.env || process.env),
      encoding: 'utf8',
      timeout: input.timeoutMs || 45 * 60 * 1000,
      maxBuffer: 8 * 1024 * 1024,
      ...(logDescriptor === null ? {} : { stdio: ['ignore', logDescriptor, 'pipe'] }),
    });
  } finally {
    if (logDescriptor !== null) fs.closeSync(logDescriptor);
  }
  const raw = logDescriptor === null
    ? (result.stdout || '')
    : fs.readFileSync(input.streamLog, 'utf8');
  const usage = usageFromOutput(input.runtime, raw);
  // Usage is known before any of the failures below, and it used to be discarded with the exception: a
  // review that burned 26k output tokens over six minutes and then failed its schema left the Work's
  // invocation totals untouched, so the cost was real and the accounting said nothing happened. Attaching
  // it to the error lets the caller record the attempt without changing the fact that the loop refuses to
  // advance on a failure.
  const failed = (message) => {
    const error = new Error(message);
    error.pair_invocation = {
      runtime: input.runtime,
      mode: input.mode,
      usage,
      duration_ms: Date.now() - started,
      model: modelFromOutput(input.runtime, raw) || input.model || null,
      failure: claudeResultRecord(raw)?.subtype || null,
    };
    return error;
  };
  if (result.error) throw failed(redactString(result.error.message));
  if (result.status !== 0) {
    const detail = redactString(result.stderr || '').trim().slice(0, 1000);
    throw failed(`${input.runtime} ${input.mode} invocation failed with status ${result.status}${detail ? `: ${detail}` : ''}`);
  }
  let output;
  try {
    output = structuredOutput(input.runtime, raw, input.outputPath);
  } catch (error) {
    throw failed(error.message);
  }
  const outputBytes = Buffer.byteLength(JSON.stringify(output), 'utf8');
  const maxOutputBytes = input.maxOutputBytes || DEFAULT_MAX_OUTPUT_BYTES;
  if (outputBytes > maxOutputBytes) {
    // The session has already ended and its result is about to be discarded, so the overage is the
    // only diagnostic the next attempt gets: a few bytes over means shorten the return, a multiple
    // over means the cap is wrong for this mode. Byte counts carry no transcript content, so naming
    // them keeps the no-persisted-transcript contract intact.
    throw failed(`${input.mode} structured result exceeds ${maxOutputBytes} UTF-8 bytes (returned ${outputBytes})`);
  }
  return {
    output,
    usage,
    duration_ms: Date.now() - started,
    runtime: input.runtime,
    model: modelFromOutput(input.runtime, raw) || input.model || 'default',
    effort: input.effort || 'medium',
  };
}

module.exports = {
  NESTED_SESSION_ENV_KEYS,
  buildProviderCommand,
  providerEnvironment,
  runFreshProvider,
  structuredOutput,
  modelFromOutput,
  usageFromOutput,
};
