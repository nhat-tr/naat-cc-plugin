const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MODEL_RATES,
  attributeSessionUsage,
  estimateCostUsd,
  resolveRate,
  summarizeWorkCost,
  sumTranscriptUsage,
} = require('../scripts/lib/pair-cost');

test('attributeSessionUsage never bills one reviewer session more than once', () => {
  // A single reviewer session can back several plan-review records (retries
  // against an unchanged digest). Charging each record the whole session
  // would multiply the reported spend by the retry count.
  const events = [
    { event: 'plan-review.completed', reviewerSessionId: 's1' },
    { event: 'plan-review.completed', reviewerSessionId: 's1' },
    { event: 'plan-review.completed', reviewerSessionId: 's2' },
    { event: 'plan-review.completed', reviewerSessionId: null },
  ];
  const usageBySession = {
    s1: { turns: 4, model: 'claude-opus-5', inputTokens: 0, cachedInputTokens: 1_000_000, cacheCreationTokens: 0, outputTokens: 0, costUsd: null },
    s2: { turns: 2, model: 'claude-opus-5', inputTokens: 0, cachedInputTokens: 1_000_000, cacheCreationTokens: 0, outputTokens: 0, costUsd: null },
  };

  const priced = attributeSessionUsage(events, usageBySession);

  // s1's 1M cached tokens split across its two records, not counted twice.
  assert.equal(priced[0].usage.cachedInputTokens, 500_000);
  assert.equal(priced[1].usage.cachedInputTokens, 500_000);
  assert.equal(priced[2].usage.cachedInputTokens, 1_000_000);
  // An event with no session keeps whatever the ledger recorded.
  assert.equal(priced[3].usage, undefined);
  assert.equal(priced[0].model, 'claude-opus-5');
});

test('estimateCostUsd prefers a provider-reported cost over a derived one', () => {
  const usage = {
    inputTokens: 1_000_000,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    costUsd: 0.07,
  };

  assert.deepEqual(estimateCostUsd(usage, 'claude-opus-5'), {
    usd: 0.07,
    source: 'provider',
  });
});

test('estimateCostUsd derives Opus spend with cache writes billed above input', () => {
  // 1h-TTL cache writes bill at 2x input; cache reads at 0.1x.
  const usage = {
    inputTokens: 1_000_000,
    cachedInputTokens: 1_000_000,
    cacheCreationTokens: 1_000_000,
    outputTokens: 1_000_000,
    costUsd: null,
  };

  const derived = estimateCostUsd(usage, 'claude-opus-5', { cacheTtl: '1h' });
  // 5 (input) + 0.5 (cache read) + 10 (cache write @2x) + 25 (output)
  assert.equal(derived.source, 'derived');
  assert.equal(Number(derived.usd.toFixed(2)), 40.5);
});

test('estimateCostUsd bills 5m cache writes at the lower multiplier', () => {
  const usage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 1_000_000,
    outputTokens: 0,
    costUsd: null,
  };

  const derived = estimateCostUsd(usage, 'claude-opus-5', { cacheTtl: '5m' });
  assert.equal(Number(derived.usd.toFixed(2)), 6.25);
});

test('resolveRate matches a model family without needing every exact id', () => {
  assert.equal(resolveRate('claude-opus-5').input, MODEL_RATES.opus.input);
  assert.equal(resolveRate('claude-opus-5[1m]').input, MODEL_RATES.opus.input);
  assert.equal(resolveRate('claude-sonnet-5').input, MODEL_RATES.sonnet.input);
  assert.equal(resolveRate('claude-haiku-4-5').input, MODEL_RATES.haiku.input);
  assert.equal(resolveRate('claude-fable-5').input, MODEL_RATES.fable.input);
});

test('resolveRate returns null for an unknown model rather than guessing', () => {
  assert.equal(resolveRate('some-other-provider-model'), null);
  assert.equal(estimateCostUsd({ inputTokens: 10, costUsd: null }, 'some-other-provider-model'), null);
});

test('sumTranscriptUsage totals assistant usage and ignores records without it', () => {
  const records = [
    { type: 'user', message: { role: 'user', content: 'hi' } },
    {
      message: {
        role: 'assistant',
        model: 'claude-opus-5',
        usage: {
          input_tokens: 2,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 50,
          output_tokens: 10,
        },
      },
    },
    {
      message: {
        role: 'assistant',
        model: 'claude-opus-5',
        usage: {
          input_tokens: 3,
          cache_read_input_tokens: 200,
          cache_creation_input_tokens: 0,
          output_tokens: 20,
        },
      },
    },
  ];

  assert.deepEqual(sumTranscriptUsage(records), {
    turns: 2,
    model: 'claude-opus-5',
    inputTokens: 5,
    cachedInputTokens: 300,
    cacheCreationTokens: 50,
    outputTokens: 30,
    costUsd: null,
  });
});

test('summarizeWorkCost separates coordinator spend from reviewer spend', () => {
  const events = [
    {
      event: 'plan-review.completed',
      workId: 'work-1',
      classification: 'plan-findings',
      model: 'claude-opus-5',
      usage: {
        inputTokens: 0,
        cachedInputTokens: 2_000_000,
        cacheCreationTokens: 0,
        outputTokens: 0,
        costUsd: null,
      },
    },
    {
      event: 'plan-review.completed',
      workId: 'work-1',
      classification: 'environment-failure',
      model: 'claude-opus-5',
      usage: {
        inputTokens: 0,
        cachedInputTokens: 1_000_000,
        cacheCreationTokens: 0,
        outputTokens: 0,
        costUsd: null,
      },
    },
  ];
  const coordinator = {
    turns: 10,
    model: 'claude-opus-5',
    inputTokens: 0,
    cachedInputTokens: 10_000_000,
    cacheCreationTokens: 0,
    outputTokens: 0,
    costUsd: null,
  };

  const summary = summarizeWorkCost({ workId: 'work-1', events, coordinator });

  assert.equal(summary.reviews.length, 2);
  assert.equal(Number(summary.reviewerUsd.toFixed(2)), 1.5);
  assert.equal(Number(summary.coordinatorUsd.toFixed(2)), 5);
  assert.equal(Number(summary.totalUsd.toFixed(2)), 6.5);
  // Wasted spend is the part that produced no verdict.
  assert.equal(Number(summary.wastedUsd.toFixed(2)), 0.5);
});
