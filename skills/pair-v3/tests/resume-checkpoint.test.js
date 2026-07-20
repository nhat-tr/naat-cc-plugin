const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createResumeCheckpoint,
  recordResumedTurn,
  serializeResumeCheckpoint,
} = require('../scripts/lib/resume-checkpoint');
const { appendPairEvent, readPairEvents } = require('../scripts/lib/pair-state');

function fixture(t) {
  const base = process.env.CLAUDE_SCRATCH_DIR || path.join(os.homedir(), '.claude-scratch');
  const root = fs.mkdtempSync(path.join(base, 'pair-v4-checkpoint-'));
  appendPairEvent(root, { event: 'work.opened', workId: 'work-checkpoint' });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function input(overrides = {}) {
  return {
    workId: 'work-checkpoint',
    runtime: 'codex',
    role: 'reviewer',
    phase: 'reviewing',
    sessionId: '01900000-0000-7000-8000-000000000001',
    attemptId: '1.1-one',
    taskId: '1.1',
    plan: { path: '.pair/plan.md', sha256: 'a'.repeat(64) },
    patch: { path: '.pair/runs/work-checkpoint/attempts/1.1-one/complete.patch', sha256: 'b'.repeat(64) },
    resumeTarget: 'reviewing',
    nextAction: 'Resume the saved read-only review and return one digest-bound verdict.',
    acceptanceCriteria: ['AC-1', 'AC-2'],
    findingIds: ['finding-1'],
    prompt: 'must never survive the allowlist',
    transcript: 'must never survive the allowlist',
    ...overrides,
  };
}

test('checkpoint allowlist and 8192-byte cap exclude prompt, transcript, logs, and diffs', () => {
  const checkpoint = createResumeCheckpoint(input({
    acceptanceCriteria: Array.from({ length: 100 }, (_value, index) => `AC-${index}-${'x'.repeat(100)}`),
    findingIds: Array.from({ length: 100 }, (_value, index) => `finding-${index}-${'y'.repeat(100)}`),
  }));
  const serialized = serializeResumeCheckpoint(checkpoint);
  assert.ok(Buffer.byteLength(serialized, 'utf8') <= 8192);
  assert.doesNotMatch(serialized, /must never survive|prompt|transcript|diff|log/i);
  assert.deepEqual(Object.keys(checkpoint).sort(), [
    'acceptance_criteria', 'attempt_id', 'finding_ids', 'next_action', 'patch', 'phase',
    'plan', 'product', 'resume_target', 'role', 'runtime', 'schema', 'session_id', 'task_id', 'work_id',
  ]);
});

test('next action has a hard 512-byte UTF-8 cap', () => {
  const checkpoint = createResumeCheckpoint(input({ nextAction: '🧭'.repeat(400) }));
  assert.ok(Buffer.byteLength(checkpoint.next_action, 'utf8') <= 512);
  assert.doesNotThrow(() => Buffer.from(checkpoint.next_action, 'utf8').toString('utf8'));
});

test('first resumed turn records cached and uncached telemetry and warns above twice the prior median', t => {
  const root = fixture(t);
  for (const uncached of [100, 120, 110]) {
    appendPairEvent(root, {
      event: 'usage.recorded', workId: 'work-checkpoint', runtime: 'codex', role: 'reviewer',
      phase: 'reviewing', resumed: true, input_tokens: uncached + 50, cached_input_tokens: 50,
      uncached_input_tokens: uncached,
    });
  }
  const result = recordResumedTurn(root, {
    checkpoint: createResumeCheckpoint(input()),
    usage: { inputTokens: 400, cachedInputTokens: 50, outputTokens: 20, reasoningTokens: 5 },
    runtime: 'codex', role: 'reviewer', phase: 'reviewing',
  });
  assert.equal(result.uncached_input_tokens, 350);
  assert.equal(result.prior_three_median_uncached, 110);
  assert.equal(result.efficiency_warning, true);
  assert.ok(readPairEvents(root).some(event => event.code === 'resume-uncached-input-regression'));
});

test('missing resumed telemetry is unknown and never a correctness gate', t => {
  const root = fixture(t);
  const result = recordResumedTurn(root, {
    checkpoint: createResumeCheckpoint(input()), usage: null,
    runtime: 'claude', role: 'reviewer', phase: 'reviewing',
  });
  assert.equal(result.input_tokens, null);
  assert.equal(result.cache_hit_ratio, null);
  assert.equal(result.telemetry, 'unknown');
  assert.equal(result.efficiency_warning, false);
});
