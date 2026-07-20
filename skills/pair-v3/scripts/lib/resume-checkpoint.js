const { appendPairEvent, readPairEvents } = require('./pair-state');

const MAX_CHECKPOINT_BYTES = 8192;
const MAX_NEXT_ACTION_BYTES = 512;
const MAX_LIST_ITEMS = 32;
const MAX_LIST_ITEM_BYTES = 128;

function truncateUtf8(value, maxBytes) {
  let result = '';
  let bytes = 0;
  for (const character of String(value || '')) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > maxBytes) break;
    result += character;
    bytes += size;
  }
  return result;
}

function identifier(value, name) {
  const normalized = truncateUtf8(value, 256).trim();
  if (!normalized) throw new Error(`Resume Checkpoint requires ${name}`);
  return normalized;
}

function artifact(value, name) {
  if (!value) return null;
  const artifactPath = String(value.path || '').split('\\').join('/');
  if (!artifactPath || artifactPath.startsWith('/') || artifactPath.split('/').includes('..')) {
    throw new Error(`${name} path must be repository-relative`);
  }
  if (!/^[a-f0-9]{64}$/u.test(value.sha256 || '')) {
    throw new Error(`${name} requires a SHA-256 digest`);
  }
  return { path: artifactPath, sha256: value.sha256 };
}

function boundedList(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(value => truncateUtf8(value, MAX_LIST_ITEM_BYTES).trim())
    .filter(Boolean))]
    .slice(0, MAX_LIST_ITEMS);
}

function serializeResumeCheckpoint(checkpoint) {
  const serialized = JSON.stringify(checkpoint);
  const size = Buffer.byteLength(serialized, 'utf8');
  if (size > MAX_CHECKPOINT_BYTES) {
    throw new Error(`Resume Checkpoint is ${size} bytes; maximum is ${MAX_CHECKPOINT_BYTES}`);
  }
  return serialized;
}

function createResumeCheckpoint(input) {
  const checkpoint = {
    schema: 1,
    product: 'pair-v4',
    work_id: identifier(input.workId, 'work identity'),
    runtime: identifier(input.runtime, 'runtime'),
    role: identifier(input.role, 'role'),
    phase: identifier(input.phase, 'phase'),
    session_id: identifier(input.sessionId, 'session identity'),
    attempt_id: input.attemptId ? identifier(input.attemptId, 'attempt identity') : null,
    task_id: input.taskId ? identifier(input.taskId, 'task identity') : null,
    plan: artifact(input.plan, 'plan artifact'),
    patch: artifact(input.patch, 'patch artifact'),
    resume_target: identifier(input.resumeTarget, 'resume target'),
    next_action: truncateUtf8(input.nextAction, MAX_NEXT_ACTION_BYTES),
    acceptance_criteria: boundedList(input.acceptanceCriteria),
    finding_ids: boundedList(input.findingIds),
  };
  while (Buffer.byteLength(JSON.stringify(checkpoint), 'utf8') > MAX_CHECKPOINT_BYTES) {
    if (checkpoint.finding_ids.length > 0) checkpoint.finding_ids.pop();
    else if (checkpoint.acceptance_criteria.length > 0) checkpoint.acceptance_criteria.pop();
    else if (checkpoint.next_action) {
      checkpoint.next_action = truncateUtf8(
        checkpoint.next_action,
        Math.max(0, Buffer.byteLength(checkpoint.next_action, 'utf8') - 128),
      );
    } else {
      throw new Error('Resume Checkpoint identity and artifact references exceed 8192 bytes');
    }
  }
  serializeResumeCheckpoint(checkpoint);
  return checkpoint;
}

function median(values) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function recordResumedTurn(root, { checkpoint, usage, runtime, role, phase }) {
  const inputTokens = finiteOrNull(usage?.inputTokens);
  const cachedInputTokens = finiteOrNull(usage?.cachedInputTokens);
  const uncachedInputTokens = inputTokens === null || cachedInputTokens === null
    ? null
    : Math.max(0, inputTokens - cachedInputTokens);
  const prior = readPairEvents(root)
    .filter(event =>
      event.event === 'usage.recorded' &&
      event.resumed === true &&
      event.runtime === runtime &&
      event.role === role &&
      event.phase === phase &&
      Number.isFinite(event.uncached_input_tokens),
    )
    .slice(-3)
    .map(event => event.uncached_input_tokens);
  const priorMedian = prior.length === 3 ? median(prior) : null;
  const efficiencyWarning = uncachedInputTokens !== null && priorMedian !== null && uncachedInputTokens > priorMedian * 2;
  const record = {
    event: 'usage.recorded',
    workId: checkpoint.work_id,
    attemptId: checkpoint.attempt_id,
    runtime,
    role,
    phase,
    resumed: true,
    checkpoint_bytes: Buffer.byteLength(serializeResumeCheckpoint(checkpoint), 'utf8'),
    input_tokens: inputTokens,
    cached_input_tokens: cachedInputTokens,
    uncached_input_tokens: uncachedInputTokens,
    cache_hit_ratio: inputTokens && cachedInputTokens !== null ? cachedInputTokens / inputTokens : null,
    output_tokens: finiteOrNull(usage?.outputTokens),
    reasoning_tokens: finiteOrNull(usage?.reasoningTokens),
    prior_three_median_uncached: priorMedian,
    telemetry: inputTokens === null ? 'unknown' : 'observed',
    efficiency_warning: efficiencyWarning,
  };
  appendPairEvent(root, record);
  if (efficiencyWarning) {
    appendPairEvent(root, {
      event: 'warning.recorded',
      workId: checkpoint.work_id,
      attemptId: checkpoint.attempt_id,
      code: 'resume-uncached-input-regression',
      detail: `resumed uncached input ${uncachedInputTokens} exceeded twice the prior three-turn median ${priorMedian}; correctness is unaffected`,
    });
  }
  return record;
}

module.exports = {
  MAX_CHECKPOINT_BYTES,
  MAX_NEXT_ACTION_BYTES,
  createResumeCheckpoint,
  recordResumedTurn,
  serializeResumeCheckpoint,
  truncateUtf8,
};
