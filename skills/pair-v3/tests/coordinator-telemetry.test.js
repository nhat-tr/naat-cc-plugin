const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  parseCoordinatorTranscript,
  recordCoordinatorTelemetry,
} = require('../scripts/lib/coordinator-telemetry');
const { appendPairEvent, readPairEvents } = require('../scripts/lib/pair-state');

function scratch(t) {
  const scratchRoot = process.env.CLAUDE_SCRATCH_DIR || path.join(os.homedir(), '.claude-scratch');
  const base = path.join(scratchRoot, 'my-claude-code', 'coordinator-telemetry-tests');
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'repo-'));
  fs.mkdirSync(path.join(root, '.pair'), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeJsonl(file, records) {
  fs.writeFileSync(file, `${records.map(record => JSON.stringify(record)).join('\n')}\n`, { mode: 0o600 });
}

test('Codex transcript parser verifies identity and reads observed model, effort, and cumulative usage', t => {
  const root = scratch(t);
  const transcript = path.join(root, 'codex.jsonl');
  writeJsonl(transcript, [
    { type: 'session_meta', payload: { id: 'codex-session' } },
    { type: 'turn_context', payload: { model: 'gpt-5.6-terra', effort: 'medium' } },
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: {
      input_tokens: 1200, cached_input_tokens: 900, output_tokens: 140, reasoning_output_tokens: 40,
    } } } },
  ]);

  assert.deepEqual(parseCoordinatorTranscript({
    runtime: 'codex', transcriptPath: transcript, expectedSessionId: 'codex-session',
  }), {
    runtime: 'codex', session_id: 'codex-session', model: 'gpt-5.6-terra', effort: 'medium',
    input_tokens: 1200, cached_input_tokens: 900, uncached_input_tokens: 300,
    output_tokens: 140, reasoning_tokens: 40,
  });
  assert.throws(
    () => parseCoordinatorTranscript({ runtime: 'codex', transcriptPath: transcript, expectedSessionId: 'wrong' }),
    /identity mismatch/i,
  );
});

test('Claude transcript parser de-duplicates message IDs and includes cache creation/read input', t => {
  const root = scratch(t);
  const transcript = path.join(root, 'claude.jsonl');
  const assistant = (id, usage) => ({
    sessionId: 'claude-session', type: 'assistant',
    message: { id, model: 'claude-sonnet-4-5', usage },
  });
  writeJsonl(transcript, [
    assistant('msg-1', { input_tokens: 100, cache_creation_input_tokens: 500, cache_read_input_tokens: 200, output_tokens: 50 }),
    assistant('msg-1', { input_tokens: 100, cache_creation_input_tokens: 500, cache_read_input_tokens: 200, output_tokens: 50 }),
    assistant('msg-2', { input_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 600, output_tokens: 30 }),
  ]);

  assert.deepEqual(parseCoordinatorTranscript({
    runtime: 'claude', transcriptPath: transcript, expectedSessionId: 'claude-session',
  }), {
    runtime: 'claude', session_id: 'claude-session', model: 'claude-sonnet-4-5', effort: null,
    input_tokens: 1420, cached_input_tokens: 800, uncached_input_tokens: 620,
    output_tokens: 80, reasoning_tokens: 0,
  });
});

test('coordinator telemetry records a baseline then only safe cumulative deltas for the active attempt', t => {
  const root = scratch(t);
  appendPairEvent(root, { event: 'work.opened', workId: 'work-20260727-telemetry', phase: 'ready' });
  appendPairEvent(root, {
    event: 'attempt.started', workId: 'work-20260727-telemetry', attemptId: 'attempt-1', taskId: '1.1',
    phase: 'implementing', profile: { type: 'feature', complexity: 'M', risk: 'medium' }, routeId: 'inline-coordinator',
    cheapReady: true, recommendedStrength: 2,
  });
  const transcript = path.join(root, 'codex.jsonl');
  const records = [
    { type: 'session_meta', payload: { id: 'owner-session' } },
    { type: 'turn_context', payload: { model: 'gpt-5.6-terra', effort: 'medium' } },
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: {
      input_tokens: 1000, cached_input_tokens: 700, output_tokens: 100, reasoning_output_tokens: 20,
    } } } },
  ];
  writeJsonl(transcript, records);

  const baseline = recordCoordinatorTelemetry(root, {
    runtime: 'codex', transcriptPath: transcript, sessionId: 'owner-session', now: '2026-07-27T10:00:00.000Z',
  });
  assert.equal(baseline.baseline, true);
  assert.equal(baseline.input_tokens, 0);

  records[2].payload.info.total_token_usage = {
    input_tokens: 1600, cached_input_tokens: 1100, output_tokens: 180, reasoning_output_tokens: 35,
  };
  writeJsonl(transcript, records);
  const delta = recordCoordinatorTelemetry(root, {
    runtime: 'codex', transcriptPath: transcript, sessionId: 'owner-session', now: '2026-07-27T10:05:00.000Z',
  });

  assert.equal(delta.baseline, false);
  assert.equal(delta.attemptId, 'attempt-1');
  assert.equal(delta.input_tokens, 600);
  assert.equal(delta.cached_input_tokens, 400);
  assert.equal(delta.uncached_input_tokens, 200);
  assert.equal(delta.output_tokens, 80);
  assert.equal(delta.reasoning_tokens, 15);
  assert.equal(delta.model, 'gpt-5.6-terra');
  assert.equal(delta.strength, 2);
  assert.equal(delta.cheap_ready, true);
  assert.equal(delta.complexity, 'M');
  assert.equal(delta.risk, 'medium');
  assert.equal(readPairEvents(root).filter(event => event.event === 'usage.recorded').length, 2);
  assert.doesNotMatch(JSON.stringify(delta), /transcriptPath|prompt|message/i);
});

test('coordinator telemetry attributes a completed slice before a newly opened next slice', t => {
  const root = scratch(t);
  appendPairEvent(root, { event: 'work.opened', workId: 'work-20260727-attribution', phase: 'ready' });
  appendPairEvent(root, {
    event: 'attempt.started', workId: 'work-20260727-attribution', attemptId: 'attempt-1', taskId: '1.1',
    phase: 'implementing', recommendedStrength: 2, cheapReady: true,
  });
  const transcript = path.join(root, 'codex-attribution.jsonl');
  const writeUsage = inputTokens => writeJsonl(transcript, [
    { type: 'session_meta', payload: { id: 'owner-session' } },
    { type: 'turn_context', payload: { model: 'gpt-5.6-terra', effort: 'medium' } },
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: {
      input_tokens: inputTokens, cached_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0,
    } } } },
  ]);
  writeUsage(100);
  recordCoordinatorTelemetry(root, { runtime: 'codex', transcriptPath: transcript, sessionId: 'owner-session' });
  appendPairEvent(root, {
    event: 'attempt.completed', workId: 'work-20260727-attribution', attemptId: 'attempt-1', taskId: '1.1',
    terminal: true, status: 'completed', disposition: 'accepted',
  });
  appendPairEvent(root, {
    event: 'attempt.started', workId: 'work-20260727-attribution', attemptId: 'attempt-2', taskId: '1.2',
    phase: 'implementing', recommendedStrength: 2, cheapReady: true,
  });
  writeUsage(250);

  const recorded = recordCoordinatorTelemetry(root, {
    runtime: 'codex', transcriptPath: transcript, sessionId: 'owner-session',
  });
  assert.equal(recorded.attemptId, 'attempt-1');
  assert.equal(recorded.taskId, '1.1');
  assert.equal(recorded.input_tokens, 150);
});

test('coordinator telemetry stamps the current Work lifecycle, not the stale attempt phase', t => {
  const root = scratch(t);
  appendPairEvent(root, { event: 'work.opened', workId: 'work-20260729-lifecycle', phase: 'ready' });
  appendPairEvent(root, {
    event: 'attempt.started', workId: 'work-20260729-lifecycle', attemptId: 'attempt-1', taskId: '3.3',
    phase: 'implementing', recommendedStrength: 2, cheapReady: true,
  });
  appendPairEvent(root, {
    event: 'work.phase.entered', workId: 'work-20260729-lifecycle', phase: 'cumulative-verification',
  });
  const transcript = path.join(root, 'codex-lifecycle.jsonl');
  writeJsonl(transcript, [
    { type: 'session_meta', payload: { id: 'owner-session' } },
    { type: 'turn_context', payload: { model: 'gpt-5.6-terra', effort: 'medium' } },
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: {
      input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0,
    } } } },
  ]);

  const recorded = recordCoordinatorTelemetry(root, {
    runtime: 'codex', transcriptPath: transcript, sessionId: 'owner-session',
  });
  assert.equal(recorded.phase, 'cumulative-verification');
  assert.equal(recorded.attemptId, 'attempt-1', 'attempt attribution is preserved even when the lifecycle moved on');
});
