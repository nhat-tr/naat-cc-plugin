// AC-3: the warm session retires at slice acceptance; a fresh rotated session with full carryover starts
// when the last call's context exceeded the configured budget, the runtime switched, or resume failed —
// and every rotation is recorded with its reason.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { advanceWork } = require('../scripts/lib/pair-engine');
const { readEvents, readState } = require('../scripts/lib/pair-store');
const { rotationReason, warmSessionPlan, warmSessionSettings } = require('../scripts/lib/warm-session');
const { completedSlice, greenVerification, openTestWork, withPairConfig } = require('./helpers/warm-work');

const SETTINGS = { enabled: true, contextBudgetTokens: 120000 };

test('rotation names its reason rather than answering yes or no', () => {
  const warm = { session_id: 's', runtime: 'claude', model: 'opus', context_tokens: 1000 };
  assert.equal(rotationReason(warm, { runtime: 'claude', model: 'opus', contextBudgetTokens: 120000 }), null);
  assert.equal(rotationReason(warm, { runtime: 'codex', model: 'opus', contextBudgetTokens: 120000 }), 'runtime-switch');
  assert.equal(rotationReason(warm, { runtime: 'claude', model: 'sonnet', contextBudgetTokens: 120000 }), 'model-switch');
  assert.equal(rotationReason({ ...warm, context_tokens: 120001 }, { runtime: 'claude', model: 'opus', contextBudgetTokens: 120000 }), 'context-budget');

  assert.deepEqual(warmSessionPlan(warm, { runtime: 'claude', model: 'opus', settings: SETTINGS }),
    { resume: 's', persist: true, rotation_reason: null });
  assert.deepEqual(warmSessionPlan(warm, { runtime: 'codex', model: 'opus', settings: SETTINGS }),
    { resume: null, persist: true, rotation_reason: 'runtime-switch' },
    'a rotation is exactly the fresh-spawn path, which is why it is always available as a fallback');
  assert.deepEqual(warmSessionPlan(null, { runtime: 'claude', model: 'opus', settings: SETTINGS }),
    { resume: null, persist: true, rotation_reason: null });
  assert.deepEqual(warmSessionPlan(warm, { runtime: 'claude', model: 'opus', settings: { ...SETTINGS, enabled: false } }),
    { resume: null, persist: false, rotation_reason: null });
});

test('the configured budget is read from user config and defaults safely', t => {
  withPairConfig(t, { warm_session_context_budget_tokens: 40000, review_diff_inline_max_bytes: 1024 });
  const configured = warmSessionSettings(process.env);
  assert.equal(configured.contextBudgetTokens, 40000);
  assert.equal(configured.reviewDiffInlineMaxBytes, 1024);
  assert.equal(configured.enabled, true, 'every new key has a safe default');
  assert.equal(configured.dispatchCorrectionOnSubmit, true);

  withPairConfig(t, { warm_session_context_budget_tokens: 'not a number' });
  assert.equal(warmSessionSettings(process.env).contextBudgetTokens, 120000,
    'a broken preference must not stop the loop');
});

// The correction that follows an over-budget implementation starts over rather than resuming, because a
// session past the budget costs a full cache re-write on its next turn and has stopped paying for itself.
test('a context past the budget rotates, and the fresh session gets the full carryover', t => {
  const opened = openTestWork(t, { prefix: 'rotate', workId: 'work-rotate', config: { warm_session_context_budget_tokens: 10000 } });
  const calls = [];
  const dependencies = {
    runProvider(input) {
      calls.push(input);
      fs.writeFileSync(path.join(input.root, 'value.js'), `module.exports = ${calls.length + 1};\n`);
      return {
        output: completedSlice(),
        usage: { input_tokens: 10, cached_input_tokens: 50000, output_tokens: 100, context_tokens: 50001 },
        duration_ms: 4, runtime: 'claude', model: 'test-model', effort: 'medium',
        session_id: `sess-${calls.length}`,
        resumed: Boolean(input.resumeSessionId),
      };
    },
    verify: () => (calls.length === 1 ? { status: 1, duration_ms: 2, diagnostic: 'still red' } : greenVerification()),
    hydrate: () => ({ hydrated: false }),
  };
  advanceWork(opened.worktree, { runtime: 'claude' }, dependencies);
  advanceWork(opened.worktree, { runtime: 'claude' }, dependencies);

  assert.equal(calls[1].resumeSessionId, null, 'a session past the budget is not resumed');
  assert.equal(calls[1].persistSession, true, 'but the replacement is still worth keeping');
  assert.match(calls[1].prompt, /Acceptance Criteria/u, 'a rotated session is seeded with the full carryover package');
  assert.match(calls[1].prompt, /Declared verification failed\./u);

  const rotations = readEvents(opened.worktree, opened.workId).filter(event => event.event === 'warm-session-rotated');
  assert.equal(rotations.length, 1, 'one abandonment is one rotation; the report counts these');
  const [rotation] = rotations;
  assert.equal(rotation.reason, 'context-budget');
  assert.equal(rotation.retired_session_id, 'sess-1');
  assert.equal(rotation.retired_context_tokens, 50001);
  assert.equal(rotation.session_id, 'sess-2');
  assert.equal(readState(opened.worktree, opened.workId).slices[0].warm_session.calls, 1,
    'the replacement counts from one; it carries none of the old session history');
});

// A session id the runtime no longer recognises fails before the model is reached, so the retry costs
// nothing. A call that burned a real session is not retried — paying for the whole thing twice would be
// worse than the failure it is trying to recover from.
test('a resume that never reached the model degrades to a fresh session; one that spent tokens does not', t => {
  const opened = openTestWork(t, { prefix: 'resumefail', workId: 'work-resume-fail' });
  const calls = [];
  const dependencies = {
    runProvider(input) {
      calls.push(input);
      if (input.resumeSessionId) {
        const error = new Error('No conversation found with session ID: sess-1');
        error.pair_invocation = { usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 }, runtime: 'claude' };
        throw error;
      }
      fs.writeFileSync(path.join(input.root, 'value.js'), `module.exports = ${calls.length + 1};\n`);
      return {
        output: completedSlice(),
        usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 100, context_tokens: 900 },
        duration_ms: 4, runtime: 'claude', model: 'test-model', effort: 'medium',
        session_id: `sess-${calls.length}`,
      };
    },
    verify: () => (calls.length === 1 ? { status: 1, duration_ms: 2, diagnostic: 'still red' } : greenVerification()),
    hydrate: () => ({ hydrated: false }),
  };
  advanceWork(opened.worktree, { runtime: 'claude' }, dependencies);
  advanceWork(opened.worktree, { runtime: 'claude' }, dependencies);

  assert.equal(calls.length, 3, 'the failed resume is retried once, fresh');
  assert.equal(calls[1].resumeSessionId, 'sess-1');
  assert.equal(calls[2].resumeSessionId, null);
  assert.match(calls[2].prompt, /Acceptance Criteria/u, 'and the fresh session is seeded with everything');
  const rotations = readEvents(opened.worktree, opened.workId).filter(event => event.event === 'warm-session-rotated');
  assert.equal(rotations.length, 1, 'the degrade-to-fresh path records the rotation once, not once per code path');
  assert.equal(rotations[0].reason, 'resume-failed');
  assert.equal(rotations[0].retired_session_id, 'sess-1');
});

test('a resumed call that spent a whole session is not retried behind the human back', t => {
  const opened = openTestWork(t, { prefix: 'expensive', workId: 'work-expensive-fail' });
  const calls = [];
  const dependencies = {
    runProvider(input) {
      calls.push(input);
      if (input.resumeSessionId) {
        const error = new Error('Claude ended with error_max_structured_output_retries after 27 turns');
        error.pair_invocation = { usage: { input_tokens: 900, cached_input_tokens: 40000, output_tokens: 25969 }, runtime: 'claude' };
        throw error;
      }
      fs.writeFileSync(path.join(input.root, 'value.js'), `module.exports = ${calls.length + 1};\n`);
      return {
        output: completedSlice(),
        usage: { input_tokens: 10, output_tokens: 100, context_tokens: 900 },
        duration_ms: 4, runtime: 'claude', model: 'test-model', effort: 'medium', session_id: 'sess-1',
      };
    },
    verify: () => (calls.length === 1 ? { status: 1, duration_ms: 2, diagnostic: 'still red' } : greenVerification()),
    hydrate: () => ({ hydrated: false }),
  };
  advanceWork(opened.worktree, { runtime: 'claude' }, dependencies);
  assert.throws(() => advanceWork(opened.worktree, { runtime: 'claude' }, dependencies),
    /error_max_structured_output_retries/u);
  assert.equal(calls.length, 2, 'a session that reached the model is not silently paid for twice');
});

test('the warm session retires when the Review Slice is accepted', t => {
  const opened = openTestWork(t, { prefix: 'retire', workId: 'work-retire' });
  advanceWork(opened.worktree, { runtime: 'claude' }, {
    runProvider(input) {
      fs.writeFileSync(path.join(input.root, 'value.js'), 'module.exports = 2;\n');
      return {
        output: completedSlice(),
        usage: { input_tokens: 10, output_tokens: 100, context_tokens: 4200 },
        duration_ms: 4, runtime: 'claude', model: 'test-model', effort: 'medium', session_id: 'sess-accept',
      };
    },
    verify: greenVerification,
    hydrate: () => ({ hydrated: false }),
  });

  const state = readState(opened.worktree, opened.workId);
  assert.equal(state.slices[0].status, 'accepted');
  assert.equal(state.slices[0].warm_session, undefined, 'a settled slice keeps no session alive');
  const retired = readEvents(opened.worktree, opened.workId).find(event => event.event === 'warm-session-retired');
  assert.equal(retired.reason, 'acceptance');
  assert.equal(retired.session_id, 'sess-accept');
  assert.equal(retired.context_tokens, 4200);
});
