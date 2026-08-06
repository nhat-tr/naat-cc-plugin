const { userConfig } = require('./pair-store');

// Continuity is not the same as growth. A warm session that is never rotated ends up carrying every dead
// end of a long slice, and the human review gap in the middle of a Pair cycle is long enough to outlive a
// prompt cache anyway — so a session that has grown past the budget costs a full cache re-write on its
// next turn and has stopped paying for itself. These are the knobs that bound that, all with safe
// defaults so an absent ~/.config/pair/config.json changes nothing.
const WARM_SESSION_DEFAULTS = {
  warm_session_enabled: true,
  warm_session_context_budget_tokens: 120000,
  review_diff_inline_max_bytes: 24 * 1024,
  dispatch_correction_on_submit: true,
};

function configuredBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function configuredCount(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

// A malformed preference must never stop the loop — userConfig already returns {} for a broken file, and
// each field falls back on its own so one bad key cannot disable the rest.
function warmSessionSettings(env = process.env) {
  const configured = userConfig(env);
  return {
    enabled: configuredBoolean(configured.warm_session_enabled, WARM_SESSION_DEFAULTS.warm_session_enabled),
    contextBudgetTokens: configuredCount(configured.warm_session_context_budget_tokens, WARM_SESSION_DEFAULTS.warm_session_context_budget_tokens),
    reviewDiffInlineMaxBytes: configuredCount(configured.review_diff_inline_max_bytes, WARM_SESSION_DEFAULTS.review_diff_inline_max_bytes),
    dispatchCorrectionOnSubmit: configuredBoolean(configured.dispatch_correction_on_submit, WARM_SESSION_DEFAULTS.dispatch_correction_on_submit),
  };
}

// Answered as a reason rather than a boolean, because "why did this slice start over" is the question the
// telemetry has to answer later. A rotation is never a failure of the design: it is exactly today's
// fresh-spawn path, kept available so continuity can always fall back to what already worked.
function rotationReason(warm, { runtime, model, contextBudgetTokens }) {
  if (warm.runtime !== runtime) return 'runtime-switch';
  // The flag-set of a warm session has to stay constant or its cached prefix is worthless, and the model
  // is the flag that decides the prefix. A Work pins one model at open, so this fires only where a human
  // passed --model mid-Work — which is a deliberate act, and a new session is what it deserves.
  if (model && warm.model && warm.model !== model) return 'model-switch';
  if ((warm.context_tokens || 0) > contextBudgetTokens) return 'context-budget';
  return null;
}

// What the next provider call should do about the session this slice already holds. `persist` says the
// spawned session is worth keeping (implementation only); `resume` names the session to continue;
// `rotation_reason` is non-null exactly when a warm session was available and deliberately abandoned.
function warmSessionPlan(warm, { runtime, model, settings }) {
  if (!settings.enabled) return { resume: null, persist: false, rotation_reason: null };
  if (!warm?.session_id) return { resume: null, persist: true, rotation_reason: null };
  const reason = rotationReason(warm, { runtime, model, contextBudgetTokens: settings.contextBudgetTokens });
  if (reason) return { resume: null, persist: true, rotation_reason: reason };
  return { resume: warm.session_id, persist: true, rotation_reason: null };
}

// The session a Work opened before warm sessions existed is not resumable and was never recorded, so a
// Work carries its own policy pinned at open: no state migration, and a Work already in flight keeps
// spawning fresh for the rest of its life.
function warmSessionPolicy(settings) {
  return { enabled: settings.enabled, context_budget_tokens: settings.contextBudgetTokens };
}

function warmSettingsForWork(state, env = process.env) {
  const settings = warmSessionSettings(env);
  const policy = state?.warm_session_policy;
  if (!policy?.enabled) return { ...settings, enabled: false };
  return { ...settings, contextBudgetTokens: configuredCount(policy.context_budget_tokens, settings.contextBudgetTokens) };
}

module.exports = {
  WARM_SESSION_DEFAULTS,
  rotationReason,
  warmSessionPlan,
  warmSessionPolicy,
  warmSessionSettings,
  warmSettingsForWork,
};
