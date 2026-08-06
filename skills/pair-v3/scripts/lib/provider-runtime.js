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

// A headless child connects every MCP server and plugin the human configured for their own interactive
// sessions and then uses none of them: measured at ~28K tokens of boot context per spawn, paid on every
// one of the 62 calls a five-item Work took. Both runtimes can be told to boot with the user's servers
// left out, and nothing downstream of a Pair prompt has ever addressed one.
function bootDietArguments(runtime) {
  return runtime === 'codex'
    // Codex loads its servers from the [mcp_servers.*] tables of ~/.codex/config.toml; an empty inline
    // table overrides all of them for this invocation only.
    ? ['-c', 'mcp_servers={}']
    : ['--strict-mcp-config'];
}

function buildProviderCommand({ runtime, mode, root, prompt, schemaPath, schema, outputPath, model = null, effort = 'medium', streamLog = null, resumeSessionId = null, persistSession = false }) {
  if (!['implementation', 'review'].includes(mode)) throw new Error(`unsupported provider mode ${mode}`);
  // Structural, not a default: a reviewer that could resume the session that wrote the code would be
  // reviewing its own reasoning, and independent fresh eyes are a guarantee of this loop rather than a
  // preference. No caller can opt a review into warmth, however the plan above it was computed.
  if (mode === 'review' && (resumeSessionId || persistSession)) {
    throw new Error('a review is always a fresh session; only implementation calls may persist or resume one');
  }
  if (runtime === 'codex') {
    const resuming = Boolean(resumeSessionId);
    const args = resuming ? ['exec', 'resume'] : ['exec'];
    args.push('--json');
    // --ephemeral is what makes a session unresumable, so it is dropped exactly where the session is
    // meant to survive. Fresh one-shot calls keep it and persist nothing, as they always have.
    if (!resuming && !persistSession) args.push('--ephemeral');
    args.push(
      '--sandbox', mode === 'review' ? 'read-only' : 'workspace-write',
      '-C', root,
      '--output-schema', schemaPath,
      '--output-last-message', outputPath,
      ...bootDietArguments('codex'),
    );
    requireExplicitModel(model);
    args.push('--model', model);
    if (effort && effort !== 'default') args.push('-c', `model_reasoning_effort="${effort}"`);
    // `codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]`: the two positionals are filled in order, so
    // the session id goes immediately before the prompt and after every flag.
    if (resuming) args.push(resumeSessionId);
    args.push(prompt);
    return { file: 'codex', args, cwd: root };
  }
  if (runtime === 'claude') {
    const resuming = Boolean(resumeSessionId);
    const args = [
      '-p', prompt,
      // stream-json turns the run into events as they happen, which is the only way to watch a
      // 20-minute session. --verbose is not optional: the CLI requires it to stream under --print.
      '--output-format', streamLog ? 'stream-json' : 'json',
      ...(streamLog ? ['--verbose', '--include-partial-messages'] : []),
    ];
    if (resuming) args.push('--resume', resumeSessionId);
    // Persistence is what a later --resume reads, so a session meant to carry a slice must not disable
    // it. Everything else still refuses to leave a transcript behind.
    if (!resuming && !persistSession) args.push('--no-session-persistence');
    args.push('--permission-mode', mode === 'review' ? 'dontAsk' : 'acceptEdits');
    args.push(...bootDietArguments('claude'));
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

// Three shapes reach here — one JSON envelope (--output-format json), a JSON array of events, and
// newline-delimited events (stream-json, used when a stream log is requested). Parsing all three in one
// place is what lets every reader below — structured result, usage, session id — be written once and
// work identically whichever shape the call happened to produce.
function outputRecords(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return text.split(/\r?\n/u).filter(Boolean).flatMap(line => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  }
}

function claudeEnvelope(raw) {
  const records = outputRecords(raw);
  return records.findLast(item => item?.type === 'result') || records.at(-1) || null;
}

// The id a later --resume / `exec resume` is handed. Read from the terminal result rather than the first
// event on purpose: a runtime that forks rather than continues on resume reports the live id at the end,
// and the chain stays correct only if each call adopts the id its own run actually ran under.
function sessionIdFromOutput(runtime, raw) {
  const records = outputRecords(raw);
  const idOf = record => (runtime === 'codex'
    ? record?.thread_id || record?.session_id || record?.payload?.session_id || record?.msg?.session_id
    : record?.session_id);
  const terminal = records.findLast(record => (runtime === 'codex'
    ? record?.type === 'turn.completed' || record?.type === 'thread.started'
    : record?.type === 'result') && idOf(record));
  const fallback = records.findLast(record => idOf(record));
  const id = idOf(terminal) || idOf(fallback);
  return id ? String(id) : null;
}

// How big the prompt had actually grown by the end of the call — the number rotation bounds, and it is
// not the sum of the envelope's token counts. Anthropic reports input, cache-read and cache-write as
// three disjoint counts and the envelope SUMS them over every turn of the session; one observed run
// totalled 3.7M cache-read tokens across a context that never exceeded 113K. The last iteration is the
// only entry that describes a single request.
function claudeContextTokens(usage) {
  const iterations = Array.isArray(usage.iterations) ? usage.iterations : [];
  const source = iterations.at(-1) || usage;
  return (source.input_tokens || 0) + (source.cache_read_input_tokens || 0) + (source.cache_creation_input_tokens || 0);
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

const EMPTY_USAGE = {
  input_tokens: 0,
  cached_input_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_creation_5m_input_tokens: 0,
  cache_creation_1h_input_tokens: 0,
  output_tokens: 0,
  reasoning_tokens: 0,
  context_tokens: 0,
  cost_usd: null,
};

function usageFromOutput(runtime, raw) {
  if (!String(raw || '').trim()) return { ...EMPTY_USAGE };
  if (runtime === 'codex') {
    const events = outputRecords(raw);
    const usage = events.findLast(event => event?.type === 'turn.completed')?.usage || {};
    return {
      ...EMPTY_USAGE,
      input_tokens: usage.input_tokens || 0,
      cached_input_tokens: usage.cached_input_tokens || 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
      output_tokens: usage.output_tokens || 0,
      reasoning_tokens: usage.reasoning_output_tokens || 0,
      // The Responses API counts cached tokens as a subset of input_tokens, so the prompt this turn
      // carried is input_tokens itself; adding the cached count would bill the cached prefix twice.
      context_tokens: usage.input_tokens || 0,
    };
  }
  const envelope = claudeEnvelope(raw);
  if (!envelope) return { ...EMPTY_USAGE };
  const usage = envelope?.usage || envelope?.result?.usage || {};
  // Cache writes are priced per TTL tier, so a five-minute write and a one-hour write of the same size
  // are different money. Splitting them here is what lets the report state the cost of continuity rather
  // than assert it.
  const creation = usage.cache_creation || {};
  return {
    ...EMPTY_USAGE,
    input_tokens: usage.input_tokens || usage.inputTokens || 0,
    cached_input_tokens: usage.cache_read_input_tokens || usage.cached_input_tokens || 0,
    cache_creation_input_tokens: usage.cache_creation_input_tokens || usage.cacheCreationInputTokens || 0,
    cache_creation_5m_input_tokens: creation.ephemeral_5m_input_tokens || 0,
    cache_creation_1h_input_tokens: creation.ephemeral_1h_input_tokens || 0,
    output_tokens: usage.output_tokens || usage.outputTokens || 0,
    reasoning_tokens: usage.reasoning_tokens || 0,
    context_tokens: claudeContextTokens(usage),
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

function runProviderSession(input, dependencies = {}) {
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
  const sessionId = sessionIdFromOutput(input.runtime, raw);
  const resumed = Boolean(input.resumeSessionId);
  // Usage is known before any of the failures below, and it used to be discarded with the exception: a
  // review that burned 26k output tokens over six minutes and then failed its schema left the Work's
  // invocation totals untouched, so the cost was real and the accounting said nothing happened. Attaching
  // it to the error lets the caller record the attempt without changing the fact that the loop refuses to
  // advance on a failure.
  const resultRecord = claudeResultRecord(raw);
  const failed = (message) => {
    const error = new Error(message);
    error.pair_invocation = {
      runtime: input.runtime,
      mode: input.mode,
      usage,
      duration_ms: Date.now() - started,
      session_id: sessionId,
      resumed,
      model: modelFromOutput(input.runtime, raw) || input.model || null,
      // The subtype is kept wherever it says something — error_max_structured_output_retries diagnoses far
      // more than a generic 'error' does. It is overridden only where it contradicts itself: claude reports an
      // API failure as subtype 'success' with is_error true, which journaled a 529 as failure:'success', a
      // failure record asserting the run went fine.
      failure: resultRecord?.is_error === true && (!resultRecord.subtype || resultRecord.subtype === 'success')
        ? 'error'
        : (resultRecord?.subtype || null),
    };
    return error;
  };
  // A human interrupt is not a provider failure and not an environment failure. `pair-loop interrupt`
  // signals the child alone, so this process survives to say what happened — and what happened is that a
  // person decided to stop, which spends no correction and blocks nothing. Interrupts used to be
  // journalled as infrastructure faults, which spent the loop's patience on the human's own decision.
  if (result.signal === 'SIGINT') {
    const error = failed(`${input.runtime} ${input.mode} session was interrupted by a human`);
    error.pair_invocation.failure = 'interrupted-by-human';
    error.pair_interrupted = true;
    throw error;
  }
  if (result.error) throw failed(redactString(result.error.message));
  if (result.status !== 0) {
    // stderr first, then what the runtime itself said. A claude API failure writes nothing to stderr and puts
    // the explanation in the result record, so "invocation failed with status 1" was the entire account of a
    // transient 529 — indistinguishable from a broken prompt, a spent budget, or a broken loop. The reason was
    // on disk the whole time; only nothing read it.
    const stated = typeof resultRecord?.result === 'string' ? resultRecord.result : '';
    const detail = redactString(result.stderr || '').trim().slice(0, 1000)
      || redactString(stated).trim().slice(0, 1000);
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
    // Reported even when nothing asked for a warm session: a call that persisted a session it will never
    // reuse should still say which one, because that is what makes an unresumed session visible.
    session_id: sessionId,
    resumed,
  };
}

module.exports = {
  NESTED_SESSION_ENV_KEYS,
  bootDietArguments,
  buildProviderCommand,
  providerEnvironment,
  runProviderSession,
  sessionIdFromOutput,
  structuredOutput,
  modelFromOutput,
  usageFromOutput,
};
