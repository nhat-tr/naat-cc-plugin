const fs = require('node:fs');
const path = require('node:path');

const { appendPairEvent, readPairEvents, reducePairEvents } = require('./pair-state');

const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;

function transcriptRecords(transcriptPath) {
  const resolved = path.resolve(String(transcriptPath || ''));
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('provider transcript must be a regular non-symbolic file');
  if (stat.size > MAX_TRANSCRIPT_BYTES) throw new Error('provider transcript exceeds the bounded telemetry reader limit');
  return fs.readFileSync(resolved, 'utf8')
    .split(/\r?\n/u)
    .filter(Boolean)
    .map(line => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function nonnegative(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function parseCodex(records, expectedSessionId) {
  const sessionId = records.find(record => record.type === 'session_meta')?.payload?.id || null;
  if (!sessionId || sessionId !== expectedSessionId) throw new Error('Codex transcript identity mismatch');
  let model = null;
  let effort = null;
  let usage = null;
  for (const record of records) {
    if (record.type === 'turn_context') {
      model = record.payload?.model || record.model || model;
      effort = record.payload?.effort || record.effort || effort;
    }
    const total = record.type === 'event_msg' && record.payload?.type === 'token_count'
      ? record.payload?.info?.total_token_usage
      : null;
    if (total) usage = total;
  }
  if (!usage) throw new Error('Codex transcript has no cumulative token usage');
  const input = nonnegative(usage.input_tokens);
  const cached = Math.min(input, nonnegative(usage.cached_input_tokens));
  return {
    runtime: 'codex', session_id: sessionId, model, effort,
    input_tokens: input,
    cached_input_tokens: cached,
    uncached_input_tokens: input - cached,
    output_tokens: nonnegative(usage.output_tokens),
    reasoning_tokens: nonnegative(usage.reasoning_output_tokens),
  };
}

function parseClaude(records, expectedSessionId) {
  const messages = new Map();
  for (const record of records) {
    if (record.type !== 'assistant' || !record.message?.id) continue;
    const sessionId = record.sessionId || record.session_id || record.session?.id || null;
    if (sessionId) messages.set(record.message.id, { sessionId, message: record.message });
  }
  const sessionIds = new Set([...messages.values()].map(item => item.sessionId));
  if (sessionIds.size !== 1 || !sessionIds.has(expectedSessionId)) throw new Error('Claude transcript identity mismatch');
  let model = null;
  let input = 0;
  let cached = 0;
  let uncached = 0;
  let output = 0;
  for (const { message } of messages.values()) {
    model = message.model || model;
    const usage = message.usage || {};
    const direct = nonnegative(usage.input_tokens);
    const created = nonnegative(usage.cache_creation_input_tokens);
    const read = nonnegative(usage.cache_read_input_tokens);
    input += direct + created + read;
    cached += read;
    uncached += direct + created;
    output += nonnegative(usage.output_tokens);
  }
  if (messages.size === 0) throw new Error('Claude transcript has no assistant usage records');
  return {
    runtime: 'claude', session_id: expectedSessionId, model, effort: null,
    input_tokens: input, cached_input_tokens: cached, uncached_input_tokens: uncached,
    output_tokens: output, reasoning_tokens: 0,
  };
}

function parseCoordinatorTranscript({ runtime, transcriptPath, expectedSessionId }) {
  if (!['codex', 'claude'].includes(runtime)) throw new Error(`unsupported coordinator runtime ${runtime}`);
  if (!String(expectedSessionId || '').trim()) throw new Error('expected coordinator session identity is required');
  const records = transcriptRecords(transcriptPath);
  return runtime === 'codex'
    ? parseCodex(records, String(expectedSessionId))
    : parseClaude(records, String(expectedSessionId));
}

function latestAttemptMetadata(events, previousTelemetry = null) {
  if (previousTelemetry) {
    const completed = [...events].reverse().find(event =>
      (event.sequence || 0) > (previousTelemetry.sequence || 0)
        && ['attempt.completed', 'attempt.outcome'].includes(event.event)
        && event.terminal !== false,
    );
    if (completed) {
      const completedId = completed.attemptId || completed.attempt_id;
      const started = [...events].reverse().find(event =>
        event.event === 'attempt.started'
          && (event.attemptId || event.attempt_id) === completedId,
      );
      return { ...(started || {}), ...completed };
    }
  }
  const terminal = new Set(events
    .filter(event => ['attempt.completed', 'attempt.outcome'].includes(event.event) && event.terminal !== false)
    .map(event => event.attemptId || event.attempt_id));
  return [...events].reverse().find(event =>
    event.event === 'attempt.started'
      && !terminal.has(event.attemptId || event.attempt_id),
  ) || [...events].reverse().find(event => event.event === 'attempt.started') || null;
}

function delta(current, previous, key) {
  return Math.max(0, current[key] - (previous?.[`cumulative_${key}`] || 0));
}

function recordCoordinatorTelemetry(root, { runtime, transcriptPath, sessionId, now } = {}) {
  const observed = parseCoordinatorTranscript({
    runtime,
    transcriptPath,
    expectedSessionId: sessionId,
  });
  const events = readPairEvents(root);
  const previous = [...events].reverse().find(event =>
    event.event === 'usage.recorded'
      && event.role === 'coordinator'
      && event.telemetry_source === 'provider-transcript'
      && event.runtime === runtime
      && event.session_id === sessionId,
  ) || null;
  const baseline = !previous
    || observed.input_tokens < (previous.cumulative_input_tokens || 0)
    || observed.output_tokens < (previous.cumulative_output_tokens || 0);
  const attempt = latestAttemptMetadata(events, previous);
  // The lifecycle can move past the attempt (cumulative verification/review
  // run after the last slice); cost attribution must follow the Work, not the
  // stale attempt phase, or per-phase spend becomes unattributable.
  const lifecycle = reducePairEvents(events).lifecycle;
  const currentPhase = lifecycle && !['idle', 'ready'].includes(lifecycle) ? lifecycle : null;
  const event = {
    event: 'usage.recorded',
    workId: attempt?.workId || attempt?.work_id || events.at(-1)?.workId || events.at(-1)?.work_id || null,
    attemptId: attempt?.attemptId || attempt?.attempt_id || null,
    taskId: attempt?.taskId || attempt?.task_id || null,
    role: 'coordinator',
    phase: currentPhase || attempt?.phase || 'coordinating',
    runtime,
    session_id: sessionId,
    model: observed.model,
    effort: observed.effort,
    strength: attempt?.recommendedStrength || attempt?.recommended_strength || null,
    recommended_strength: attempt?.recommendedStrength || attempt?.recommended_strength || null,
    cheap_ready: attempt?.cheapReady ?? attempt?.cheap_ready ?? null,
    complexity: attempt?.complexity || attempt?.profile?.complexity || attempt?.taskProfile?.complexity || null,
    risk: attempt?.risk || attempt?.profile?.risk || attempt?.taskProfile?.risk || null,
    routeId: attempt?.routeId || attempt?.route_id || 'inline-coordinator',
    telemetry_source: 'provider-transcript',
    baseline,
    input_tokens: baseline ? 0 : delta(observed, previous, 'input_tokens'),
    cached_input_tokens: baseline ? 0 : delta(observed, previous, 'cached_input_tokens'),
    uncached_input_tokens: baseline ? 0 : delta(observed, previous, 'uncached_input_tokens'),
    output_tokens: baseline ? 0 : delta(observed, previous, 'output_tokens'),
    reasoning_tokens: baseline ? 0 : delta(observed, previous, 'reasoning_tokens'),
    cumulative_input_tokens: observed.input_tokens,
    cumulative_cached_input_tokens: observed.cached_input_tokens,
    cumulative_uncached_input_tokens: observed.uncached_input_tokens,
    cumulative_output_tokens: observed.output_tokens,
    cumulative_reasoning_tokens: observed.reasoning_tokens,
    at: now,
  };
  return appendPairEvent(root, event);
}

module.exports = {
  MAX_TRANSCRIPT_BYTES,
  parseCoordinatorTranscript,
  recordCoordinatorTelemetry,
};
