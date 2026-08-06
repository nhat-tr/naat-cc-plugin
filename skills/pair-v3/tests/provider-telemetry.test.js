// AC-8: every provider call record includes session id, resumed flag, rotation reason, cache-read /
// cache-write / input / output tokens and cost; pair-report shows warm-vs-fresh counts and per-slice
// context growth. This is what makes the optimization falsifiable rather than asserted — the mined
// baseline was 541M cached tokens across 62 calls, with one slice growing 837K → 2.77M → 5.97M.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { advanceWork } = require('../scripts/lib/pair-engine');
const { readEvents, readState } = require('../scripts/lib/pair-store');
const { summarize } = require('../scripts/pair-report');
const { completedSlice, greenVerification, openTestWork } = require('./helpers/warm-work');

const CALL_FIELDS = [
  'session_id', 'resumed', 'rotation_reason',
  'input_tokens', 'cached_input_tokens', 'cache_creation_input_tokens',
  'cache_creation_5m_input_tokens', 'cache_creation_1h_input_tokens',
  'output_tokens', 'context_tokens', 'cost_usd',
];

function run(session, contextTokens, resumed) {
  return {
    output: completedSlice(),
    usage: {
      input_tokens: 90,
      cached_input_tokens: contextTokens - 5000,
      cache_creation_input_tokens: 5000,
      cache_creation_5m_input_tokens: 0,
      cache_creation_1h_input_tokens: 5000,
      output_tokens: 300,
      context_tokens: contextTokens,
      cost_usd: 0.02,
    },
    duration_ms: 7,
    runtime: 'claude',
    model: 'test-model',
    effort: 'medium',
    session_id: session,
    resumed,
  };
}

test('every provider call record carries the fields the warm-session claim is judged on', t => {
  const opened = openTestWork(t, { prefix: 'telemetry', workId: 'work-telemetry' });
  const calls = [];
  const dependencies = {
    runProvider(input) {
      calls.push(input);
      fs.writeFileSync(path.join(input.root, 'value.js'), `module.exports = ${calls.length + 1};\n`);
      return run(`sess-${calls.length === 1 ? 1 : 1}`, calls.length === 1 ? 22000 : 26000, Boolean(input.resumeSessionId));
    },
    verify: () => (calls.length === 1 ? { status: 1, duration_ms: 2, diagnostic: 'still red' } : greenVerification()),
    hydrate: () => ({ hydrated: false }),
  };
  advanceWork(opened.worktree, { runtime: 'claude' }, dependencies);
  advanceWork(opened.worktree, { runtime: 'claude' }, dependencies);

  const finished = readEvents(opened.worktree, opened.workId).filter(event => event.event === 'provider-finished');
  assert.equal(finished.length, 2);
  for (const record of finished) {
    for (const field of CALL_FIELDS) {
      assert.ok(Object.hasOwn(record, field), `provider call record is missing ${field}`);
    }
  }
  assert.equal(finished[0].resumed, false);
  assert.equal(finished[1].resumed, true, 'and the record says which calls actually reused a session');
  assert.equal(finished[1].session_id, 'sess-1');
  assert.equal(finished[1].cache_creation_1h_input_tokens, 5000);

  const totals = readState(opened.worktree, opened.workId).invocation_totals;
  assert.equal(totals.calls, 2);
  assert.equal(totals.warm_calls, 1, 'warm-vs-fresh is countable from the totals alone');
  assert.equal(totals.cache_creation_input_tokens, 10000);
  assert.equal(totals.cost_usd, 0.04);
});

test('a failed call keeps its telemetry, including which session it was', t => {
  const opened = openTestWork(t, { prefix: 'failtel', workId: 'work-fail-telemetry' });
  assert.throws(() => advanceWork(opened.worktree, { runtime: 'claude' }, {
    runProvider() {
      const error = new Error('Claude ended with error_max_structured_output_retries after 27 turns');
      error.pair_invocation = {
        runtime: 'claude', session_id: 'sess-dead', resumed: false, failure: 'error_max_structured_output_retries',
        duration_ms: 395000,
        usage: { input_tokens: 900, cached_input_tokens: 88000, cache_creation_input_tokens: 12000, cache_creation_1h_input_tokens: 12000, output_tokens: 25969, context_tokens: 100900, cost_usd: 1.2 },
      };
      throw error;
    },
    verify: greenVerification,
    hydrate: () => ({ hydrated: false }),
  }), /error_max_structured_output_retries/u);

  const failed = readEvents(opened.worktree, opened.workId).findLast(event => event.event === 'provider-failed');
  assert.equal(failed.session_id, 'sess-dead');
  assert.equal(failed.output_tokens, 25969, 'cost that real cannot be invisible');
  assert.equal(failed.context_tokens, 100900);
  assert.equal(failed.cost_usd, 1.2);
  assert.equal(readState(opened.worktree, opened.workId).invocation_totals.calls, 1);
});

test('pair-report states warm-vs-fresh counts and the per-slice context growth curve', t => {
  const opened = openTestWork(t, { prefix: 'report', workId: 'work-report', config: { warm_session_context_budget_tokens: 25000 } });
  const calls = [];
  const dependencies = {
    runProvider(input) {
      calls.push(input);
      fs.writeFileSync(path.join(input.root, 'value.js'), `module.exports = ${calls.length + 1};\n`);
      // 20K, then 30K past the 25K budget, so the third call is a rotation with a reason to report.
      return run(`sess-${calls.length}`, calls.length === 1 ? 20000 : 30000, Boolean(input.resumeSessionId));
    },
    verify: () => (calls.length >= 3 ? greenVerification() : { status: 1, duration_ms: 2, diagnostic: 'still red' }),
    hydrate: () => ({ hydrated: false }),
  };
  advanceWork(opened.worktree, { runtime: 'claude' }, dependencies);
  advanceWork(opened.worktree, { runtime: 'claude' }, dependencies);

  const report = summarize(opened.worktree, opened.workId);
  assert.equal(report.warm_sessions.warm_calls, 1);
  assert.equal(report.warm_sessions.fresh_calls, 1);
  assert.equal(report.warm_sessions.sessions_opened, 1);
  assert.deepEqual(report.warm_sessions.context_growth.S1, [20000, 30000],
    'the growth curve is the whole claim: a warm slice that grows like the fresh-spawn loop has fixed nothing');
  assert.equal(report.totals.warm_calls, 1);
});
