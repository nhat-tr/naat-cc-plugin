const { userConfig } = require('./pair-store');

// Who the loop stops for. Every gate in this reducer was written for a human reading each checkpoint as it
// lands, and that is the right shape for the Review Slice a person actually wants to see — and pure ceremony
// for the eight around it, where "run", read a status line, "run" again is the entire human contribution.
// So the loop drives itself by default and a human marks the slices they want to stand in. The gates
// themselves are unchanged: a marked slice meets exactly the ones it always did.
const HUMAN_LOOP_DEFAULTS = {
  human_in_the_loop_default: false,
  // A bound on what one gesture may spend, not on how far the loop may get: hitting it stops the run with
  // the next action still named, so `run` continues from there. A Work of forty slices is forty of these.
  autonomous_actions_per_run: 40,
  // How many times a red gate may be corrected before a human is needed. This is NOT the one-correction bound
  // on findings, and it is deliberately larger: a fresh reviewer can always find something, so find → correct
  // → find never terminates on its own and one is the right number. A failing test is the opposite — it is
  // falsifiable, the same suite decides every round, and the loop is the only thing touching this code, so
  // "make the tests pass" is work it can be trusted to keep at. What bounds it is progress, not permission:
  // an attempt that leaves the identical set of tests failing has stopped making progress and stops here.
  deterministic_correction_attempts: 3,
};

function configuredBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function configuredCount(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function humanLoopSettings(env = process.env) {
  const configured = userConfig(env);
  return {
    humanInTheLoopByDefault: configuredBoolean(configured.human_in_the_loop_default, HUMAN_LOOP_DEFAULTS.human_in_the_loop_default),
    actionsPerRun: configuredCount(configured.autonomous_actions_per_run, HUMAN_LOOP_DEFAULTS.autonomous_actions_per_run),
  };
}

// `override` is `pair-loop open --hitl` (or `--off`): one Work driven differently from the preference, said
// once at open rather than marked slice by slice afterwards.
function humanLoopPolicy(settings, override = undefined) {
  return {
    default: typeof override === 'boolean' ? override : settings.humanInTheLoopByDefault,
    actions_per_run: settings.actionsPerRun,
  };
}

// Pinned at open, exactly as the warm-session policy is, so a preference change never re-decides a Work in
// flight — and so a Work opened before this existed keeps every human gate it was opened with rather than
// silently starting to drive itself.
function humanLoopDefault(state) {
  return state?.human_loop_policy ? state.human_loop_policy.default === true : true;
}

// A per-slice mark wins over the Work's default in both directions: mark the risky slice hitl inside an
// autonomous Work, or hand one slice to the loop inside a Work you are otherwise reading yourself.
function inHumanLoop(state, projected = null) {
  if (typeof projected?.hitl === 'boolean') return projected.hitl;
  return humanLoopDefault(state);
}

// Read live rather than pinned at open, unlike the two policies above: this one answers "how hard should the
// loop try before it needs me", and a human who changes their mind about that means it for the Work they are
// standing in, not only for the next one.
function deterministicAttemptBudget(env = process.env) {
  return configuredCount(userConfig(env).deterministic_correction_attempts, HUMAN_LOOP_DEFAULTS.deterministic_correction_attempts);
}

function autonomousActionCap(state, env = process.env) {
  const pinned = state?.human_loop_policy?.actions_per_run;
  return configuredCount(pinned, humanLoopSettings(env).actionsPerRun);
}

module.exports = {
  HUMAN_LOOP_DEFAULTS,
  autonomousActionCap,
  deterministicAttemptBudget,
  humanLoopDefault,
  humanLoopPolicy,
  humanLoopSettings,
  inHumanLoop,
};
