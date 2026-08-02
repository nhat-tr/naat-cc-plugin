'use strict';

// Per-million-token list rates. Cache reads bill at 0.1x input; cache writes
// bill at 1.25x (5m TTL) or 2x (1h TTL). Claude Code sessions use the 1h TTL,
// so that is the default here.
const MODEL_RATES = {
  fable: { input: 10, output: 50 },
  opus: { input: 5, output: 25 },
  sonnet: { input: 3, output: 15 },
  haiku: { input: 1, output: 5 },
};

const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = { '5m': 1.25, '1h': 2 };

function resolveRate(model) {
  if (!model || typeof model !== 'string') return null;
  const id = model.toLowerCase();
  if (id.includes('fable') || id.includes('mythos')) return MODEL_RATES.fable;
  if (id.includes('opus')) return MODEL_RATES.opus;
  if (id.includes('sonnet')) return MODEL_RATES.sonnet;
  if (id.includes('haiku')) return MODEL_RATES.haiku;
  return null;
}

// Returns { usd, source } or null when the model is unknown and the provider
// reported nothing. A null result means "unmeasured", never "free".
function estimateCostUsd(usage, model, { cacheTtl = '1h' } = {}) {
  if (!usage) return null;
  if (Number.isFinite(usage.costUsd)) return { usd: usage.costUsd, source: 'provider' };
  const rate = resolveRate(model);
  if (!rate) return null;
  const writeMultiplier = CACHE_WRITE_MULTIPLIER[cacheTtl] ?? CACHE_WRITE_MULTIPLIER['1h'];
  const usd =
    ((usage.inputTokens || 0) * rate.input
      + (usage.cachedInputTokens || 0) * rate.input * CACHE_READ_MULTIPLIER
      + (usage.cacheCreationTokens || 0) * rate.input * writeMultiplier
      + (usage.outputTokens || 0) * rate.output) / 1e6;
  return { usd, source: 'derived' };
}

// Accepts already-parsed transcript records (one per JSONL line) so the caller
// owns file IO and this stays testable.
function sumTranscriptUsage(records) {
  const total = {
    turns: 0,
    model: null,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    costUsd: null,
  };
  for (const record of records || []) {
    const usage = record?.message?.usage;
    if (!usage) continue;
    total.turns += 1;
    total.model = record.message.model || total.model;
    total.inputTokens += usage.input_tokens || 0;
    total.cachedInputTokens += usage.cache_read_input_tokens || 0;
    total.cacheCreationTokens += usage.cache_creation_input_tokens || 0;
    total.outputTokens += usage.output_tokens || 0;
  }
  return total;
}

// One reviewer session can back several plan-review records when an unchanged
// digest is retried. Split each session's measured usage evenly across the
// records that reference it so the session is billed exactly once.
function attributeSessionUsage(events = [], usageBySession = {}) {
  const shares = {};
  for (const event of events) {
    const id = event?.reviewerSessionId;
    if (id && usageBySession[id]) shares[id] = (shares[id] || 0) + 1;
  }
  return events.map((event) => {
    const id = event?.reviewerSessionId;
    const usage = id ? usageBySession[id] : null;
    if (!usage) return event;
    const share = shares[id] || 1;
    return {
      ...event,
      model: usage.model || event.model,
      usage: {
        inputTokens: (usage.inputTokens || 0) / share,
        cachedInputTokens: (usage.cachedInputTokens || 0) / share,
        cacheCreationTokens: (usage.cacheCreationTokens || 0) / share,
        outputTokens: (usage.outputTokens || 0) / share,
        costUsd: Number.isFinite(usage.costUsd) ? usage.costUsd / share : null,
      },
    };
  });
}

function summarizeWorkCost({ workId, events = [], coordinator = null, cacheTtl = '1h' }) {
  const reviews = events
    .filter((event) => event.event === 'plan-review.completed' && event.workId === workId)
    .map((event) => {
      const cost = estimateCostUsd(event.usage, event.model, { cacheTtl });
      return {
        classification: event.classification || null,
        model: event.model || null,
        usd: cost ? cost.usd : null,
        costSource: cost ? cost.source : 'unmeasured',
        // An environment failure produced no verdict, so its spend bought nothing.
        wasted: event.classification === 'environment-failure',
      };
    });

  const sum = (list) => list.reduce((acc, item) => acc + (item.usd || 0), 0);
  const reviewerUsd = sum(reviews);
  const wastedUsd = sum(reviews.filter((review) => review.wasted));
  const coordinatorCost = coordinator
    ? estimateCostUsd(coordinator, coordinator.model, { cacheTtl })
    : null;
  const coordinatorUsd = coordinatorCost ? coordinatorCost.usd : 0;

  return {
    workId,
    reviews,
    reviewerUsd,
    wastedUsd,
    coordinatorUsd,
    coordinatorTurns: coordinator ? coordinator.turns : 0,
    totalUsd: reviewerUsd + coordinatorUsd,
    unmeasured: reviews.some((review) => review.costSource === 'unmeasured')
      || (Boolean(coordinator) && !coordinatorCost),
  };
}

module.exports = {
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_MULTIPLIER,
  MODEL_RATES,
  attributeSessionUsage,
  estimateCostUsd,
  resolveRate,
  summarizeWorkCost,
  sumTranscriptUsage,
};
