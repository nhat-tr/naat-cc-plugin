const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  determinePath,
  inspectCheckpointRisks,
  normalizeRisk,
  renderDesignCheckMarkdown,
  validateDesignCheck,
} = require('./architecture-routing');
const { runProviderSession } = require('./provider-runtime');
const {
  correctionPrompt,
  implementationPrompt,
  postDiffDesignPrompt,
  reviewPrompt,
} = require('./pair-prompts');
const {
  warmSessionPlan,
  warmSessionPolicy,
  warmSessionSettings,
  warmSettingsForWork,
} = require('./warm-session');
const {
  appendEvent,
  atomicWrite,
  blobAtCommit,
  git,
  readCurrentWork,
  userConfig,
  readEvents,
  readJson,
  readState,
  safeSegment,
  storeBlob,
  storeJsonBlob,
  updatePairRef,
  withDispatchLease,
  withVerificationLease,
  workPaths,
  writeCurrentWork,
  writeJson,
  writeState,
} = require('./pair-store');
const {
  createPairWorktree,
  defaultScratchDirectory,
  hydrateWorktree,
  removePairWorktree,
  worktreeStatus,
} = require('./pair-worktree');
const {
  acceptanceCriteriaFromSpec,
  loadManifest,
  relevantAcceptanceCriteria,
} = require('./review-slice-manifest');
const {
  HUMAN_TEXT_BOUNDS,
  feedbackForFinding,
  listReviewOutcomes,
  recordReviewFeedback,
  recordReviewOutcome,
} = require('./review-evidence');
const { activeReviewGuidance } = require('./review-guidance');
const { resolveRuntime } = require('./runtime-selection');

const ENGINE_SCHEMA = 1;
const PROOF_METHODS = new Set(['base-reproduction', 'unit', 'integration', 'contract', 'e2e', 'runtime', 'manual']);
const SKILL_DIRECTORY = path.resolve(__dirname, '../..');
const SLICE_SCHEMA_PATH = path.join(SKILL_DIRECTORY, 'schemas', 'slice-result.json');
const REVIEW_SCHEMA_PATH = path.join(SKILL_DIRECTORY, 'schemas', 'precision-review-result.json');
const SLICE_OUTPUT_LIMIT_BYTES = 2 * 1024;
const REVIEW_OUTPUT_LIMIT_BYTES = 6 * 1024;
// Bounded generously and deliberately unlike the 1000-character caps around it: those bound what a model
// may emit, and a cap sized for model output is the wrong shape for a sentence a person types by hand.
// Held as a Git blob rather than in state.json, which has a 16 KiB budget for the whole Work.
const STEER_TEXT_LIMIT_BYTES = 8 * 1024;

function now() {
  return new Date().toISOString();
}

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

// 'default' meant "pass no --model and let the CLI decide", and what the CLI decides is whatever model the
// human last chose for their own interactive sessions. So a Pair round inherited an unrelated preference:
// changing the global model mid-Work changed which model wrote the next checkpoint, with nothing in the
// record to show it. A model is therefore always resolved to a concrete id and always passed. Explicit
// --model wins, then the model pinned to this Work, then the user's Pair config; if none of those exist the
// run is refused rather than left to inherit, because guessing on the human's behalf is the bug itself.
// Resolution only — the refusal lives in buildProviderCommand, where the real command is assembled. Putting
// it here would make opening a Work require a model it does not yet need, and would fire for every test that
// injects a stub provider and never reaches a CLI at all. Returning null lets the one place that can
// actually inherit an ambient model be the one place that refuses to.
function resolvedModel(options = {}, state = null) {
  for (const candidate of [options.model, state?.model, userConfig(process.env).default_model]) {
    const value = String(candidate || '').trim();
    if (value && value !== 'default') return value;
  }
  return null;
}

// Every field the warm-session claim is falsifiable against: which session ran, whether it was resumed,
// why it was not, how big its context had grown, and the cache read/write split that decides the money.
// The result envelope already carries all of it, so none of this costs a round trip.
function invocationSummary(kind, sliceId, run, plan = null) {
  const usage = run.usage || {};
  return {
    kind,
    review_slice_id: sliceId,
    runtime: run.runtime,
    model: run.model,
    effort: run.effort,
    session_id: run.session_id || null,
    resumed: Boolean(run.resumed),
    rotation_reason: plan?.rotation_reason || null,
    input_tokens: usage.input_tokens || 0,
    cached_input_tokens: usage.cached_input_tokens || 0,
    cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
    cache_creation_5m_input_tokens: usage.cache_creation_5m_input_tokens || 0,
    cache_creation_1h_input_tokens: usage.cache_creation_1h_input_tokens || 0,
    output_tokens: usage.output_tokens || 0,
    context_tokens: usage.context_tokens || 0,
    cost_usd: Number.isFinite(usage.cost_usd) ? usage.cost_usd : null,
    duration_ms: run.duration_ms || 0,
    at: now(),
  };
}

function saveState(root, state) {
  state.updated_at = now();
  writeState(root, state.work_id, state);
  return state;
}

function currentState(root, workId = null) {
  const state = readState(root, workId);
  if (!state) throw new Error('no active Pair Work; run pair-loop open first');
  if (state.schema !== ENGINE_SCHEMA) throw new Error(`unsupported Pair state schema ${state.schema}`);
  return state;
}

function workContext(root, state) {
  const paths = workPaths(root, state.work_id);
  const spec = fs.readFileSync(paths.spec, 'utf8');
  const manifest = readJson(paths.manifest);
  const criteria = acceptanceCriteriaFromSpec(spec);
  return { paths, spec, manifest, criteria };
}

function initialSliceState(slice) {
  return {
    id: slice.id,
    status: 'queued',
    correction_count: 0,
  };
}

function openWork(root, options) {
  const workId = safeSegment(options.workId, 'Work ID');
  const loaded = loadManifest(options.manifestPath, options.specPath, workId);
  const worktree = createPairWorktree(root, {
    workId,
    base: options.base || 'HEAD',
    destination: options.destination || null,
  });
  const existing = readState(root, workId);
  if (existing) {
    if (existing.manifest_digest !== loaded.digest) throw new Error(`Pair Work ${workId} already exists with another Review Slice Manifest`);
    writeCurrentWork(root, { schema: 1, work_id: workId, worktree: existing.worktree });
    writeCurrentWork(existing.worktree, { schema: 1, work_id: workId, worktree: existing.worktree });
    return { state: existing, worktree: existing.worktree, created: false };
  }
  const paths = workPaths(root, workId);
  atomicWrite(paths.spec, loaded.spec, 64 * 1024);
  atomicWrite(paths.manifest, loaded.serialized, 16 * 1024);
  const specEvidence = storeBlob(root, workId, 'spec', loaded.spec);
  const manifestEvidence = storeJsonBlob(root, workId, 'manifest', loaded.manifest);
  const baseCommit = git(worktree.path, ['rev-parse', 'HEAD']).stdout;
  updatePairRef(root, workId, 'base', baseCommit);
  updatePairRef(root, workId, 'head', baseCommit);
  const state = {
    schema: ENGINE_SCHEMA,
    product: 'pair-evidence-at-commit',
    work_id: workId,
    lifecycle: 'ready',
    next_action: `run Review Slice ${loaded.manifest.slices[0].id}`,
    worktree: worktree.path,
    branch: worktree.branch,
    base_commit: baseCommit,
    head_commit: baseCommit,
    spec_digest: digest(loaded.spec),
    spec_ref: specEvidence.ref,
    manifest_digest: loaded.digest,
    manifest_ref: manifestEvidence.ref,
    composition_review_required: false,
    completion_review_outcome_id: null,
    // Pinned once, for every round of this Work. Omitting --model let the provider fall back to whatever
    // the human last selected globally, so switching an interactive session to a different model silently
    // changed which model implemented and reviewed the next Review Slice — observed live, where S-05's
    // correction ran fable while every earlier round of the same Work ran opus. A Work that spans hours
    // has to be one model's work unless a human says otherwise.
    model: resolvedModel(options),
    // Pinned at open for the same reason the model is, and it is also what keeps this change inert for
    // Work already in flight: a state written before warm sessions existed carries no policy, and every
    // read of it answers "not enabled". No migration, and the running ParagonAgent Work is untouched.
    warm_session_policy: warmSessionPolicy(warmSessionSettings(process.env)),
    slices: loaded.manifest.slices.map(initialSliceState),
    invocation_totals: { ...EMPTY_TOTALS },
    recent_invocations: [],
    created_at: now(),
    updated_at: now(),
  };
  writeState(root, workId, state);
  writeCurrentWork(root, { schema: 1, work_id: workId, worktree: worktree.path });
  writeCurrentWork(worktree.path, { schema: 1, work_id: workId, worktree: worktree.path });
  appendEvent(root, workId, {
    event: 'work-opened',
    lifecycle: 'ready',
    base_commit: baseCommit,
    branch: worktree.branch,
    spec_ref: specEvidence.ref,
    manifest_ref: manifestEvidence.ref,
    slice_count: state.slices.length,
  });
  return { state, worktree: worktree.path, created: true };
}

function manifestSlice(context, sliceId) {
  const slice = context.manifest.slices.find(item => item.id === sliceId);
  if (!slice) throw new Error(`Review Slice ${sliceId} is absent from the manifest`);
  return slice;
}

function nextQueuedSlice(state, manifest) {
  for (const slice of manifest.slices) {
    const projected = state.slices.find(item => item.id === slice.id);
    if (projected.status !== 'queued') continue;
    if (slice.depends_on.every(id => state.slices.find(item => item.id === id)?.status === 'accepted')) return projected;
  }
  return null;
}

function activeSlice(state, context) {
  const projected = state.slices.find(item => !['queued', 'accepted'].includes(item.status));
  if (projected) return { projected, manifest: manifestSlice(context, projected.id) };
  const queued = nextQueuedSlice(state, context.manifest);
  return queued ? { projected: queued, manifest: manifestSlice(context, queued.id) } : null;
}

function criteriaText(context, slice) {
  return relevantAcceptanceCriteria(context.criteria, slice).map(item => `- ${item.id}: ${item.text}`).join('\n');
}

function recordedDesignCheck(context, slice) {
  const file = path.join(context.paths.designChecks, `${slice.id}.md`);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

// Human steering lives as a blob because state.json budgets 16 KiB for the whole Work and steering
// alone may be 8 KiB. Read back at the moment a prompt is built, so a steer recorded between two runs
// reaches the next turn whether or not that turn resumes a warm session.
function steeringText(root, state, projected) {
  if (!projected.steering_ref) return null;
  return readPairRefText(root, `refs/pair/${state.work_id}`, `steering/${projected.id}`);
}

// The disposition reason is why a human called this finding valid, and it is the most specific
// steering that exists for that finding. Dropping it forced every human note through the single
// 1000-character Correction Direction, or through hand-edits when it would not fit. It travels
// attached to the finding it adjudicates, so it can never be read as evidence of its own.
function correctionEvidence(state, slice, projected) {
  const findings = projected.review_outcome_id
    ? (listReviewOutcomes(state.worktree, state.work_id)
        .find(item => item.review_outcome_id === projected.review_outcome_id)?.findings || [])
      .flatMap(item => {
        const valid = feedbackForFinding(state.worktree, state.work_id, item.finding_id)
          .filter(feedback => feedback.disposition === 'valid');
        if (valid.length === 0) return [];
        return [{ ...item, human_adjudication: valid.map(feedback => feedback.reason).join(' ') }];
      })
    : [];
  const deterministic = projected.verification_failure
    ? [{ claim: 'Declared verification failed.', scenario: projected.verification_failure, pass_condition: `Command succeeds: ${slice.verify}` }]
    : [];
  return [...findings, ...deterministic];
}

function sliceAttemptPrompt(root, state, context, slice, projected, { correction, warm }) {
  const criteria = criteriaText(context, slice);
  const steering = steeringText(root, state, projected);
  if (correction) {
    return correctionPrompt({
      slice, criteria, warm, steering,
      evidence: correctionEvidence(state, slice, projected),
      direction: projected.correction_direction || null,
    });
  }
  // design-ready means the session before this one refused to write code until a decision was recorded.
  // Running the routine prompt because the file is missing would silently discard that refusal.
  const designCheck = projected.status === 'design-ready' ? recordedDesignCheck(context, slice) : null;
  if (projected.status === 'design-ready' && !designCheck) {
    throw new Error(`Review Slice ${slice.id} is design-ready but its Design Check is missing from ${context.paths.designChecks}`);
  }
  return implementationPrompt({ slice, criteria, warm, steering, designCheck });
}

function validateFailureProof(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('completed Review Slice requires one Failure Proof');
  const boundary = String(value.boundary || '').replace(/\s+/gu, ' ').trim();
  const negativeControl = String(value.negative_control || '').replace(/\s+/gu, ' ').trim();
  if (!boundary || boundary.length > 300) throw new Error('Failure Proof boundary must use 1-300 characters');
  if (!PROOF_METHODS.has(value.method)) throw new Error('Failure Proof method is invalid');
  if (!negativeControl || negativeControl.length > 400) throw new Error('Failure Proof negative control must use 1-400 characters');
  return { boundary, method: value.method, negative_control: negativeControl };
}

function validateSliceResult(output) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) throw new Error('implementation returned no structured result');
  const allowed = new Set(['status', 'architecture_risk', 'design_check', 'failure_proof', 'blocker']);
  const unknown = Object.keys(output).filter(key => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`implementation result has unsupported fields: ${unknown.join(', ')}`);
  if (!['completed', 'design-required', 'blocked'].includes(output.status)) throw new Error('implementation status is invalid');
  const architectureRisk = normalizeRisk(output.architecture_risk);
  if (output.status === 'design-required') {
    if (!architectureRisk) throw new Error('design-required implementation must name one architecture risk');
    return { ...output, architecture_risk: architectureRisk, design_check: validateDesignCheck(output.design_check), failure_proof: null, blocker: null };
  }
  if (output.status === 'blocked') {
    const blocker = String(output.blocker || '').trim();
    if (!blocker || blocker.length > 500) throw new Error('blocked implementation requires a bounded blocker');
    return { ...output, architecture_risk: architectureRisk, blocker, design_check: null, failure_proof: null };
  }
  return {
    ...output,
    architecture_risk: architectureRisk,
    design_check: null,
    failure_proof: validateFailureProof(output.failure_proof),
    blocker: null,
  };
}

const EMPTY_TOTALS = {
  calls: 0,
  warm_calls: 0,
  input_tokens: 0,
  cached_input_tokens: 0,
  cache_creation_input_tokens: 0,
  output_tokens: 0,
  cost_usd: 0,
  duration_ms: 0,
};

function accumulatedTotals(state, summary) {
  const totals = { ...EMPTY_TOTALS, ...(state.invocation_totals || {}) };
  return {
    calls: totals.calls + 1,
    warm_calls: totals.warm_calls + (summary.resumed ? 1 : 0),
    input_tokens: totals.input_tokens + summary.input_tokens,
    cached_input_tokens: totals.cached_input_tokens + summary.cached_input_tokens,
    cache_creation_input_tokens: totals.cache_creation_input_tokens + summary.cache_creation_input_tokens,
    output_tokens: totals.output_tokens + summary.output_tokens,
    cost_usd: Number((totals.cost_usd + (summary.cost_usd || 0)).toFixed(6)),
    duration_ms: totals.duration_ms + summary.duration_ms,
  };
}

function recordInvocation(root, state, sliceId, kind, run, plan = null) {
  const summary = invocationSummary(kind, sliceId, run, plan);
  state.invocation_totals = accumulatedTotals(state, summary);
  state.recent_invocations = [...(state.recent_invocations || []), summary].slice(-3);
  appendEvent(root, state.work_id, { event: 'provider-finished', ...summary });
}

// Opt-in live visibility: with a stream log directory configured, each fresh session writes its events
// there as they happen, so a human can watch a 20-minute run instead of waiting blind. Unconfigured,
// nothing about the invocation changes and no provider prose reaches disk. Read from user config as well as
// the environment, because an env-only switch meant runs driven from an editor silently wrote no log at
// all — so the run nobody could watch was exactly the one a human started from the surface they work in.
function streamLogPath(env, workId, sliceId, kind) {
  const directory = String(env.PAIR_STREAM_LOG || userConfig(env).stream_log_dir || '').trim();
  if (!directory) return null;
  return path.join(directory, workId, `${sliceId}-${kind}.jsonl`);
}

// A resumed call that never reached the model spent nothing, and a session id the runtime no longer
// recognises fails exactly that way. Rotating on that is free; rotating on a call that burned a full
// session — a schema it could not satisfy, a refusal, a timeout — would pay for the whole thing twice,
// so the retry is deliberately narrow rather than "the resumed call failed".
function resumeNeverStarted(error) {
  const usage = error?.pair_invocation?.usage;
  if (!usage) return true;
  return (usage.input_tokens || 0) === 0
    && (usage.cached_input_tokens || 0) === 0
    && (usage.output_tokens || 0) === 0;
}

// Exactly once per rotation, from whichever path settled it: the report counts these, so recording the
// same abandonment twice would say a slice started over more often than it did.
function recordRotation(root, state, sliceId, { reason, previous, sessionId = null, detail = null }) {
  appendEvent(root, state.work_id, {
    event: 'warm-session-rotated',
    review_slice_id: sliceId,
    reason,
    retired_session_id: previous?.session_id || null,
    retired_context_tokens: previous?.context_tokens || 0,
    session_id: sessionId,
    ...(detail ? { detail } : {}),
  });
}

// What a slice keeps of the session that implemented it. Recorded after every implementation call, so a
// runtime that forks rather than continues on resume still leaves the chain pointing at a live session.
function adoptWarmSession(root, state, projected, run, { runtime, model, rotated }) {
  const previous = projected.warm_session || null;
  if (!run.session_id) {
    // Nothing resumable came back — an --ephemeral runtime, a stubbed provider, an older CLI. The slice
    // simply stays cold, which is the behavior every Work had before warm sessions existed.
    delete projected.warm_session;
    return;
  }
  const continuing = Boolean(previous) && !rotated;
  projected.warm_session = {
    session_id: run.session_id,
    runtime,
    model: model || run.model || null,
    context_tokens: run.usage?.context_tokens || 0,
    calls: (continuing ? previous.calls || 0 : 0) + 1,
  };
  if (!previous && !rotated) {
    appendEvent(root, state.work_id, {
      event: 'warm-session-opened',
      review_slice_id: projected.id,
      runtime,
      session_id: run.session_id,
    });
  }
}

// `buildPrompt` rather than a prompt string: whether this call resumes is decided here, and a resumed
// call must not carry the slice-stable package the session already holds. A degrade-to-fresh retry then
// rebuilds the full prompt from the same function, so the fresh session is seeded with everything.
function providerCall(root, state, call, options, dependencies) {
  const { sliceId, kind, buildPrompt, mode = 'implementation', reviewSchema = false, warm = null } = call;
  const runtime = options.runtime && options.runtime !== 'auto'
    ? options.runtime
    : resolveRuntime('auto', { env: dependencies.env || process.env, available: dependencies.availableRuntimes });
  const model = resolvedModel(options, state);
  const scratch = defaultScratchDirectory(root, state.work_id);
  fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const schemaPath = reviewSchema ? REVIEW_SCHEMA_PATH : SLICE_SCHEMA_PATH;
  const schema = readJson(schemaPath);
  const runProvider = dependencies.runProvider || runProviderSession;
  const settings = warmSettingsForWork(state, dependencies.env || process.env);
  const previousWarm = warm ? warm.projected.warm_session || null : null;
  let plan = warm
    ? warmSessionPlan(previousWarm, { runtime, model, settings })
    : { resume: null, persist: false, rotation_reason: null };
  let rotationRecorded = false;
  const recordPendingRotation = (sessionId) => {
    if (!plan.rotation_reason || rotationRecorded) return;
    recordRotation(root, state, sliceId, { reason: plan.rotation_reason, previous: previousWarm, sessionId });
    rotationRecorded = true;
  };
  for (;;) {
    const outputPath = path.join(scratch, `${sliceId}-${kind}-${crypto.randomUUID()}.json`);
    let run;
    try {
      run = runProvider({
        runtime,
        mode,
        root: state.worktree,
        prompt: buildPrompt({ warm: Boolean(plan.resume) }),
        schemaPath,
        schema,
        outputPath,
        model,
        effort: options.effort || 'medium',
        maxOutputBytes: reviewSchema ? REVIEW_OUTPUT_LIMIT_BYTES : SLICE_OUTPUT_LIMIT_BYTES,
        streamLog: streamLogPath(dependencies.env || process.env, state.work_id, sliceId, kind),
        resumeSessionId: plan.resume,
        persistSession: plan.persist,
      });
    } catch (error) {
      fs.rmSync(outputPath, { force: true });
      if (plan.resume && !error.pair_interrupted && resumeNeverStarted(error)) {
        recordRotation(root, state, sliceId, {
          reason: 'resume-failed',
          previous: previousWarm,
          detail: String(error.message || '').slice(0, 200),
        });
        rotationRecorded = true;
        // Dropped now rather than on the retry's success: if the fresh retry fails too, the next run must
        // not walk back into the same dead session id.
        delete warm.projected.warm_session;
        plan = { resume: null, persist: true, rotation_reason: 'resume-failed' };
        continue;
      }
      recordPendingRotation(null);
      recordFailedInvocation(root, state, sliceId, kind, error, runtime, plan);
      throw error;
    }
    fs.rmSync(outputPath, { force: true });
    recordPendingRotation(run.session_id || null);
    recordInvocation(root, state, sliceId, kind, run, plan);
    if (warm) adoptWarmSession(root, state, warm.projected, run, { runtime, model, rotated: Boolean(plan.rotation_reason) });
    return run;
  }
}

// A failed provider call used to leave nothing at all: recordInvocation runs after runProvider returns, so
// an exception skipped both the journal entry and the token totals. Observed live — an S-05 review spent
// 6m35s, 27 turns and 25,969 output tokens, exhausted its structured-output retries, and the Work's record
// showed the review had never been attempted. Cost that real cannot be invisible, and a phase that fails
// repeatedly must be countable. The failure is recorded and then re-thrown: the loop still refuses to
// advance, which was always correct.
function recordFailedInvocation(root, state, sliceId, kind, error, runtime, plan = null) {
  const telemetry = error?.pair_invocation || {};
  const usage = telemetry.usage || {};
  const summary = {
    review_slice_id: sliceId,
    kind,
    runtime: telemetry.runtime || runtime,
    session_id: telemetry.session_id || null,
    resumed: Boolean(telemetry.resumed),
    rotation_reason: plan?.rotation_reason || null,
    input_tokens: usage.input_tokens || 0,
    cached_input_tokens: usage.cached_input_tokens || 0,
    cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
    cache_creation_5m_input_tokens: usage.cache_creation_5m_input_tokens || 0,
    cache_creation_1h_input_tokens: usage.cache_creation_1h_input_tokens || 0,
    output_tokens: usage.output_tokens || 0,
    context_tokens: usage.context_tokens || 0,
    cost_usd: Number.isFinite(usage.cost_usd) ? usage.cost_usd : null,
    duration_ms: telemetry.duration_ms || 0,
    failure: telemetry.failure || null,
    // Bounded, and already redacted by the runtime: the reason is a diagnosis, not transcript content.
    error: String(error?.message || 'unknown provider failure').slice(0, 500),
  };
  state.invocation_totals = accumulatedTotals(state, summary);
  state.recent_invocations = [...(state.recent_invocations || []), { ...summary, failed: true }].slice(-3);
  appendEvent(root, state.work_id, {
    event: error?.pair_interrupted ? 'provider-interrupted' : 'provider-failed',
    ...summary,
  });
  saveState(root, state);
}

function saveDesignCheck(root, state, slice, projected, designCheck, risk) {
  const architectureRisk = normalizeRisk(risk);
  const markdown = renderDesignCheckMarkdown(architectureRisk, designCheck);
  fs.mkdirSync(workPaths(root, state.work_id).designChecks, { recursive: true, mode: 0o700 });
  const file = path.join(workPaths(root, state.work_id).designChecks, `${slice.id}.md`);
  atomicWrite(file, markdown, 2048);
  const stored = storeBlob(root, state.work_id, `design-checks/${slice.id}`, markdown);
  projected.design_check_ref = stored.ref;
  projected.design_check_blob = stored.objectId;
  projected.architecture_risk = architectureRisk;
  appendEvent(root, state.work_id, { event: 'design-check-recorded', review_slice_id: slice.id, architecture_risk: architectureRisk, evidence_ref: stored.ref, evidence_blob: stored.objectId });
  return markdown;
}

function changedPaths(worktree) {
  const tracked = git(worktree, ['diff', '--name-only', '--no-renames', '-z'], { trim: false }).stdout.split('\0').filter(Boolean);
  const staged = git(worktree, ['diff', '--cached', '--name-only', '--no-renames', '-z'], { trim: false }).stdout.split('\0').filter(Boolean);
  const untracked = git(worktree, ['ls-files', '--others', '--exclude-standard', '-z'], { trim: false }).stdout.split('\0').filter(Boolean);
  return [...new Set([...tracked, ...staged, ...untracked])].filter(file => !/(?:^|\/)node_modules\//u.test(file));
}

function commitCheckpoint(state, slice, projected) {
  const paths = changedPaths(state.worktree);
  if (paths.length === 0) throw new Error(`Review Slice ${slice.id} produced no repository change`);
  git(state.worktree, ['add', '-A', '--', ...paths]);
  git(state.worktree, ['-c', 'user.name=Pair', '-c', 'user.email=pair@local', 'commit', '-m', `pair(${state.work_id}): ${slice.id} ${slice.outcome.slice(0, 80)}`]);
  const checkpoint = git(state.worktree, ['rev-parse', 'HEAD']).stdout;
  projected.checkpoint_commit = checkpoint;
  state.head_commit = checkpoint;
  updatePairRef(state.worktree, state.work_id, `checkpoints/${slice.id}`, checkpoint);
  updatePairRef(state.worktree, state.work_id, 'head', checkpoint);
  return { checkpoint, paths };
}

function verificationCommand(command, cwd) {
  const started = Date.now();
  const result = childProcess.spawnSync('/bin/sh', ['-lc', command], {
    cwd,
    encoding: 'utf8',
    timeout: Number(process.env.PAIR_VERIFY_COMMAND_TIMEOUT_MS || 45 * 60 * 1000),
    maxBuffer: 8 * 1024 * 1024,
  });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  // Split once and reuse: the two identity scans below would otherwise each re-strip and re-split the
  // same up-to-8 MB verification log.
  const lines = cleanOutputLines(output);
  return {
    status: result.error ? null : result.status,
    duration_ms: Date.now() - started,
    log_digest: digest(output),
    diagnostic: result.error ? String(result.error.message).slice(0, 500) : verificationDiagnostic(result),
    failing_tests: failingTestIdentitiesFromLines(lines),
    warnings: warningIdentitiesFromLines(lines),
  };
}

// An exit status cannot tell "this Review Slice broke something" apart from "this repository already
// had a failing test". Without that distinction one pre-existing failure inside the slice's verify
// scope makes every checkpoint unreachable, the one bounded correction is spent on a failure the
// slice did not cause, and the human abandons the loop for hand-driven edits. Naming the failing
// tests is what makes the distinction possible, so the runner's own failure lines are read back into
// stable identities. Parsing fails closed: an unrecognised runner yields no identities, and no
// identity is ever treated as known.
const ANSI_ESCAPE = /\u001b\[[0-9;]*[A-Za-z]/gu;
const FAILING_TEST_PATTERNS = [
  // VSTest/dotnet: "  Failed Ns.Class.Method [1 s]" and the MTP "  X Ns.Class.Method". The leading
  // character class rejects the "Failed!  - Failed: 1, Passed: 329" summary line.
  /^(?:X|Failed)\s+(?<id>[^\s!][^[]*?)\s*(?:\[[^\]]*\])?$/u,
  // TAP, which node --test speaks.
  /^not ok \d+\s+-\s+(?<id>.+?)$/u,
  /^FAILED\s+(?<id>\S+)/u,
  /^(?:FAIL|✗|×)\s+(?<id>\S.*?)(?:\s+\d+\s*ms)?$/u,
];
const FAILING_TEST_IDENTITY_LIMIT = 300;

// Shared by every identity scan below: strip ANSI, split into lines, and drop blanks once so a caller
// holding an 8 MB verification log never pays for that pass twice on the same output.
function cleanOutputLines(output) {
  return String(output).replaceAll(ANSI_ESCAPE, '').split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
}

// One skeleton for every line-oriented identity scan: try each pattern in order, stop at the first
// match, extract, dedupe, and return sorted. `extract` receives the regexp match and returns the final
// identity string (or a falsy value to treat the pattern as a non-match).
function identitiesFromLines(lines, patterns, extract) {
  const identities = new Set();
  for (const line of lines) {
    for (const pattern of patterns) {
      const match = line.match(pattern);
      if (!match) continue;
      const id = extract(match);
      if (id) { identities.add(id); break; }
    }
  }
  return [...identities].sort();
}

function failingTestIdentitiesFromLines(lines) {
  return identitiesFromLines(lines, FAILING_TEST_PATTERNS, match => match.groups?.id?.trim()?.slice(0, FAILING_TEST_IDENTITY_LIMIT));
}

function failingTestIdentities(output) {
  return failingTestIdentitiesFromLines(cleanOutputLines(output));
}

// MSBuild/dotnet warning lines carry a full source path, which is noisy and machine-specific (a
// sandboxed build and a developer checkout report the same warning under different absolute prefixes).
// The short filename plus the compiler code is the stable part, and it is what a baseline compares run
// over run.
const WARNING_PATTERNS = [
  /^(?<file>.+?)\(\d+,\d+\):\s+warning\s+(?<code>[A-Za-z]+\d+):/u,
];

function warningIdentitiesFromLines(lines) {
  return identitiesFromLines(lines, WARNING_PATTERNS, match => `${match.groups.file.split('/').pop()}:${match.groups.code}`);
}

function warningIdentities(output) {
  return warningIdentitiesFromLines(cleanOutputLines(output));
}

const KNOWN_FAILURE_REASON_LIMIT = 500;
const KNOWN_FAILURE_ENTRY_LIMIT = 32;

// The baseline is a human declaration, never an inference: Pair cannot tell a pre-existing failure
// from a regression, and guessing in either direction is worse than asking. It is recorded with the
// evidence that justified it and with the commit it was declared at, so a later reader can audit
// whether the exemption is still honest.
function knownFailureFile(root, workId) {
  return path.join(workPaths(root, workId).directory, 'known-failures.json');
}

function knownFailures(root, workId) {
  const stored = readJson(knownFailureFile(root, workId));
  return Array.isArray(stored?.entries) ? stored.entries : [];
}

function knownFailureIdentities(root, workId) {
  return new Set(knownFailures(root, workId).map(entry => entry.test));
}

function writeKnownFailures(root, workId, entries) {
  const value = { schema: 1, entries };
  writeJson(knownFailureFile(root, workId), value, 16 * 1024);
  return storeJsonBlob(root, workId, 'known-failures', value);
}

function recordKnownFailure(root, options = {}) {
  const state = currentState(root, options.workId || null);
  const test = String(options.test || '').replace(/\s+/gu, ' ').trim();
  if (!test) throw new Error('a Known Failure requires --test');
  if (test.length > FAILING_TEST_IDENTITY_LIMIT) throw new Error(`a Known Failure identity must use 1-${FAILING_TEST_IDENTITY_LIMIT} characters`);
  const reason = String(options.reason || '').replace(/\s+/gu, ' ').trim();
  if (!reason) throw new Error('a Known Failure requires --reason naming the evidence that it pre-exists this Work');
  if (reason.length > KNOWN_FAILURE_REASON_LIMIT) throw new Error(`a Known Failure reason must use 1-${KNOWN_FAILURE_REASON_LIMIT} characters`);
  const entries = knownFailures(root, state.work_id).filter(entry => entry.test !== test);
  if (entries.length + 1 > KNOWN_FAILURE_ENTRY_LIMIT) throw new Error(`a Known Failure Baseline holds at most ${KNOWN_FAILURE_ENTRY_LIMIT} tests; a larger one is a broken suite, not a baseline`);
  entries.push({ test, reason, declared_at: now(), declared_at_commit: state.head_commit });
  const stored = writeKnownFailures(root, state.work_id, entries);
  appendEvent(root, state.work_id, {
    event: 'known-failure-declared',
    test_digest: digest(test),
    evidence_ref: stored.ref,
    evidence_blob: stored.objectId,
    entry_count: entries.length,
  });
  return { entries, state };
}

function forgetKnownFailure(root, options = {}) {
  const state = currentState(root, options.workId || null);
  const test = String(options.test || '').replace(/\s+/gu, ' ').trim();
  if (!test) throw new Error('forgetting a Known Failure requires --test');
  const existing = knownFailures(root, state.work_id);
  const entries = existing.filter(entry => entry.test !== test);
  if (entries.length === existing.length) throw new Error(`${test} is not in the Known Failure Baseline`);
  const stored = writeKnownFailures(root, state.work_id, entries);
  appendEvent(root, state.work_id, {
    event: 'known-failure-withdrawn',
    test_digest: digest(test),
    evidence_ref: stored.ref,
    evidence_blob: stored.objectId,
    entry_count: entries.length,
  });
  return { entries, state };
}

// A run is clean when it exits zero, or when every test it named as failing was already declared
// pre-existing. An unparsed runner never reaches the second branch: no identities means no exemption.
function applyKnownFailureBaseline(root, workId, result) {
  if (result.status === 0) return result;
  const observed = Array.isArray(result.failing_tests) ? result.failing_tests : [];
  if (observed.length === 0) return result;
  const baseline = knownFailureIdentities(root, workId);
  const introduced = observed.filter(test => !baseline.has(test));
  if (introduced.length > 0) return { ...result, introduced_failing_tests: introduced };
  return { ...result, status: 0, observed_status: result.status, baselined_failing_tests: observed };
}

// Unlike the Known Failure Baseline, no human declares this one: a warning count varies with cache
// state and machine, so the first verification a Work ever runs is captured as its baseline rather
// than compared against one. Every verification after that diffs against exactly that first capture.
function knownWarningFile(root, workId) {
  return path.join(workPaths(root, workId).directory, 'warning-baseline.json');
}

function recordKnownWarnings(root, workId, entries) {
  const value = { schema: 1, entries };
  writeJson(knownWarningFile(root, workId), value, 16 * 1024);
  const stored = storeJsonBlob(root, workId, 'known-warnings', value);
  appendEvent(root, workId, {
    event: 'warning-baseline-captured',
    warnings_digest: digest(JSON.stringify(entries)),
    evidence_ref: stored.ref,
    evidence_blob: stored.objectId,
    entry_count: entries.length,
  });
  return stored;
}

function applyWarningBaseline(root, workId, result) {
  const observed = Array.isArray(result.warnings) ? result.warnings : [];
  const stored = readJson(knownWarningFile(root, workId));
  if (stored === null) {
    recordKnownWarnings(root, workId, observed);
    return { ...result, introduced_warnings: [] };
  }
  const baseline = new Set(Array.isArray(stored.entries) ? stored.entries : []);
  const introduced = observed.filter(warning => !baseline.has(warning));
  return { ...result, introduced_warnings: introduced };
}

const DIAGNOSTIC_LIMIT = 500;
// What names a failure is the assertion, the compiler error, or the exception message. Stack frames
// are the bulk of a runner's output and the least of its meaning, so a tail window returns framework
// plumbing and the one automatic correction still corrects blind.
const STACK_FRAME_LINE = /^\s*(at\s|File\s"|in\s\S+:line\s|--- End of)/u;
// Suffix-matching, not word-bounded: the cause is usually a type name like HttpRequestException.
const FAILURE_SIGNAL_LINE = /error|fail|exception|assert|panic:|Traceback/iu;
const EXPECTATION_LINE = /^\s*(?:Expected|Actual|But was|Message)\s*:/iu;
// A bare "Error Message:" header spends the budget without naming anything.
const CONTENTLESS_HEADER_LINE = /^[A-Za-z][A-Za-z ]{0,30}:$/u;

// Build tools routinely report compiler errors on stdout and leave stderr empty. Reading stderr
// alone hands the correction an empty diagnostic. Prefer stderr, fall back to stdout, keep the
// lines that name the failure, and name the one failure shape that carries no diagnostics at all.
function verificationDiagnostic(result) {
  const stdout = String(result.stdout || '');
  const spoken = String(result.stderr || '').trim() || stdout.trim();
  if (/Build FAILED/u.test(stdout) && /\b0 Error\(s\)/u.test(stdout)) {
    return `${salientFailureLines(spoken, 400)}\nMSBuild reported failure with zero diagnostics: its parallel worker nodes could not start, which a command sandbox commonly causes. Re-run the verification command with -m:1 before treating this as a code failure.`;
  }
  return salientFailureLines(spoken, DIAGNOSTIC_LIMIT);
}

function salientFailureLines(output, limit) {
  const salient = [];
  const seen = new Set();
  for (const line of output.split(/\r?\n/u)) {
    const text = line.trimEnd();
    if (!text.trim() || STACK_FRAME_LINE.test(text)) continue;
    if (CONTENTLESS_HEADER_LINE.test(text.trim())) continue;
    if (!FAILURE_SIGNAL_LINE.test(text) && !EXPECTATION_LINE.test(text)) continue;
    const key = text.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    salient.push(text.trim().slice(0, limit));
  }
  // Nothing announced itself as a failure, so the tail is the best remaining evidence.
  if (salient.length === 0) return output.slice(-limit);
  const kept = [];
  let used = 0;
  for (const line of salient) {
    if (used + line.length > limit && kept.length > 0) break;
    kept.push(line);
    used += line.length + 1;
  }
  return kept.join('\n').slice(0, limit);
}

function verify(root, state, slice, dependencies) {
  const hydrate = dependencies.hydrate || ((input) => hydrateWorktree(root, input));
  hydrate({ workId: state.work_id, worktree: state.worktree, submodules: [] });
  const execute = dependencies.verify || ((input) => verificationCommand(input.command, input.cwd));
  const raw = withVerificationLease(
    root,
    state.work_id,
    { review_slice_id: slice.id, command_digest: digest(slice.verify) },
    () => execute({ command: slice.verify, cwd: state.worktree, workId: state.work_id, sliceId: slice.id }),
  );
  const result = applyWarningBaseline(root, state.work_id, applyKnownFailureBaseline(root, state.work_id, raw));
  appendEvent(root, state.work_id, {
    event: 'verification-finished',
    review_slice_id: slice.id,
    command_digest: digest(slice.verify),
    status: result.status,
    observed_status: result.observed_status ?? result.status,
    baselined_test_count: result.baselined_failing_tests?.length || 0,
    duration_ms: result.duration_ms || 0,
    log_digest: result.log_digest || null,
  });
  return result;
}

function verificationRecord(slice, verification) {
  return {
    status: verification.status,
    duration_ms: verification.duration_ms || 0,
    command_digest: digest(slice.verify),
    log_digest: verification.log_digest || null,
    // Kept out of the status field so a baselined pass never reads as an unconditional green.
    ...(verification.baselined_failing_tests ? { baselined_test_count: verification.baselined_failing_tests.length } : {}),
    // Unconditional, unlike the field above: a warning never flips verification status, so there is no
    // "unconditional green" for this count to be mistaken for.
    introduced_warning_count: (verification.introduced_warnings || []).length,
  };
}

function routineReviewSelected(state, slice, checkpoint, options) {
  const policy = String(options.reviewPolicy || process.env.PAIR_REVIEW_POLICY || 'architecture').toLowerCase();
  if (policy === 'all') return true;
  if (policy !== 'sample') return false;
  const rate = Math.max(0, Math.min(1, Number(options.sampleRate ?? process.env.PAIR_ROUTINE_REVIEW_RATE ?? 0.1)));
  const bucket = Number.parseInt(digest(`${state.work_id}:${slice.id}:${checkpoint}`).slice(0, 8), 16) / 0xffffffff;
  return bucket < rate;
}

function checkpointChangedPaths(worktree, projected) {
  if (!projected.base_commit || !projected.checkpoint_commit) return [];
  return git(worktree, [
    'diff', '--name-only', '--no-renames', '-z',
    `${projected.base_commit}..${projected.checkpoint_commit}`,
  ], { trim: false }).stdout.split('\0').filter(Boolean);
}

function markCompositionRisk(state, projected) {
  const priorPaths = new Set(state.slices
    .filter(item => item.id !== projected.id && item.status === 'accepted')
    .flatMap(item => checkpointChangedPaths(state.worktree, item)));
  const currentPaths = checkpointChangedPaths(state.worktree, projected);
  if (currentPaths.some(file => priorPaths.has(file))) state.composition_review_required = true;
}

function compactAcceptedSlice(projected) {
  // review_outcome_id survives compaction: it is the one pointer that says WHICH review this slice was
  // accepted against. Dropping it left the Review Inbox unable to tell a live outcome from one a later
  // review superseded, so it showed every outcome ever written and a disposition staged on a superseded
  // row recorded feedback the adjudication gate could never see. One id per slice against a 16 KiB
  // budget is cheap for making the reference durable.
  const keep = new Set(['id', 'status', 'base_commit', 'checkpoint_commit', 'route', 'correction_count', 'review_outcome_id']);
  for (const key of Object.keys(projected)) {
    if (!keep.has(key)) delete projected[key];
  }
}

// Pair distinguishes two kinds of guard, and conflating them made the reducer the gatekeeper of the
// human. A POLICY guard is the machine's opinion about order — "review before acceptance", "steer only
// at correction-ready". The human has more context than the reducer and may overrule it. A STRUCTURAL
// guard describes state that cannot exist — accepting a Review Slice that produced no checkpoint would
// record an empty acceptance. Those stay refused.
//
// What Pair actually needs is not that a human cannot act, but that a checkpoint EXPLAINS itself. An
// override therefore satisfies the invariant by being recorded rather than by being forbidden: the
// reason is stored as evidence and the transition is named in the event log, so the acceptance says
// plainly that a human made it and why.
const HUMAN_OVERRIDE_REASON_LIMIT = 1000;

function recordHumanOverride(root, state, projected, action, reason) {
  const text = String(reason || '').replace(/\s+/gu, ' ').trim();
  if (!text) throw new Error(`a human override of ${action} requires --reason: an unexplained override leaves the checkpoint unable to explain itself`);
  if (text.length > HUMAN_OVERRIDE_REASON_LIMIT) {
    throw new Error(`a human override reason must use 1-${HUMAN_OVERRIDE_REASON_LIMIT} characters`);
  }
  const stored = storeBlob(root, state.work_id, `human-overrides/${projected?.id || 'work'}-${action}`, text);
  appendEvent(root, state.work_id, {
    event: 'human-override',
    action,
    review_slice_id: projected?.id || null,
    from_status: projected?.status || state.lifecycle,
    reason: text,
    evidence_ref: stored.ref,
    evidence_blob: stored.objectId,
  });
  return text;
}

// Acceptance is where continuity has done its whole job: the slice is settled, and every later slice
// starts from a codebase this session no longer describes. Keeping it alive would be the bloat the
// rotation budget exists to prevent, so it retires here — on the record, before compaction drops it.
function retireWarmSession(root, state, projected, reason) {
  const warm = projected.warm_session;
  if (!warm) return;
  appendEvent(root, state.work_id, {
    event: 'warm-session-retired',
    review_slice_id: projected.id,
    reason,
    session_id: warm.session_id,
    calls: warm.calls || 0,
    context_tokens: warm.context_tokens || 0,
  });
  delete projected.warm_session;
}

function acceptSlice(root, state, context, projected) {
  markCompositionRisk(state, projected);
  retireWarmSession(root, state, projected, 'acceptance');
  projected.status = 'accepted';
  // An accepted Review Slice is not a blocked one. Override-accept is a real way out of an exhausted
  // correction, and it reached here with the Work still carrying the block that stopped it — so a Work that
  // moved on to its next slice kept a blocked_reason naming a slice already accepted. status renders that
  // reason only while the lifecycle is blocked, which is exactly what made it survive unnoticed in
  // state.json, where a handover or a later session reads it as current.
  state.blocked_reason = null;
  state.blocked_precondition = null;
  appendEvent(root, state.work_id, {
    event: 'slice-accepted',
    review_slice_id: projected.id,
    checkpoint_commit: projected.checkpoint_commit,
    route: projected.route,
    correction_count: projected.correction_count,
  });
  compactAcceptedSlice(projected);
  const next = nextQueuedSlice(state, context.manifest);
  if (next) {
    state.lifecycle = 'ready';
    state.next_action = `run Review Slice ${next.id}`;
    return saveState(root, state);
  }
  state.lifecycle = 'completion-verification-ready';
  state.next_action = 'run cumulative deterministic verification';
  return saveState(root, state);
}

function cumulativeVerification(root, state, context, dependencies) {
  const commands = [...new Set(context.manifest.slices.map(item => item.verify))];
  for (const command of commands) {
    const result = withVerificationLease(root, state.work_id, { review_slice_id: 'completion', command_digest: digest(command) }, () =>
      (dependencies.verify || ((input) => verificationCommand(input.command, input.cwd)))({
        command,
        cwd: state.worktree,
        workId: state.work_id,
        sliceId: 'completion',
      }));
    appendEvent(root, state.work_id, {
      event: 'completion-verification-finished',
      command_digest: digest(command),
      status: result.status,
      duration_ms: result.duration_ms || 0,
      log_digest: result.log_digest || null,
    });
    if (result.status !== 0) {
      state.lifecycle = 'blocked';
      state.blocked_reason = 'cumulative deterministic verification failed';
      state.next_action = 'human diagnosis required';
      return saveState(root, state);
    }
  }
  if (state.composition_review_required) {
    state.lifecycle = 'completion-review-ready';
    state.next_action = 'run fresh combined-diff review';
  } else {
    state.lifecycle = 'complete';
    state.next_action = null;
    updatePairRef(state.worktree, state.work_id, 'completed', state.head_commit);
    appendEvent(root, state.work_id, { event: 'work-completed', head_commit: state.head_commit });
  }
  return saveState(root, state);
}

// The coordinator already holds the two commit ids, so it can hand the reviewer the diff itself instead
// of two ids and an instruction to derive it. Over the cap the reviewer derives it exactly as before —
// an oversized diff inlined would crowd out the code reading that makes the review worth having.
function checkpointDiff(worktree, baseCommit, checkpointCommit, maxBytes) {
  if (!baseCommit || !checkpointCommit) return null;
  const text = git(worktree, ['diff', '--no-color', `${baseCommit}..${checkpointCommit}`], { trim: false }).stdout;
  return Buffer.byteLength(text, 'utf8') <= maxBytes ? text : null;
}

function checkpointReviewPrompt(root, state, context, slice, projected, guidance, dependencies) {
  const settings = warmSettingsForWork(state, dependencies.env || process.env);
  return reviewPrompt({
    slice,
    criteria: criteriaText(context, slice),
    designCheck: projected.design_check_ref ? recordedDesignCheck(context, slice)?.trim() || null : null,
    baseCommit: projected.base_commit,
    checkpointCommit: projected.checkpoint_commit,
    verification: projected.verification,
    architectureRisk: projected.architecture_risk || null,
    guidance,
    diff: checkpointDiff(state.worktree, projected.base_commit, projected.checkpoint_commit, settings.reviewDiffInlineMaxBytes),
  });
}

function runCheckpointReview(root, state, context, slice, projected, options, dependencies) {
  const guidance = activeReviewGuidance(root, state.work_id, [projected.route]);
  const run = providerCall(root, state, {
    sliceId: slice.id,
    kind: 'review',
    mode: 'review',
    reviewSchema: true,
    buildPrompt: () => checkpointReviewPrompt(root, state, context, slice, projected, guidance, dependencies),
  }, options, dependencies);
  const recorded = recordReviewOutcome(root, {
    workId: state.work_id,
    sliceId: slice.id,
    baseCommit: projected.base_commit,
    checkpointCommit: projected.checkpoint_commit,
    runtime: run.runtime,
    model: run.model,
    effort: run.effort,
    usage: run.usage,
    review: run.output,
  });
  projected.review_outcome_id = recorded.outcome.review_outcome_id;
  if (recorded.outcome.findings.length > 0) {
    projected.status = 'awaiting-feedback';
    state.lifecycle = 'awaiting-human';
    state.next_action = `adjudicate ${recorded.outcome.findings.length} finding(s) for ${slice.id}`;
  } else if (projected.route === 'architecture-sensitive') {
    projected.status = 'awaiting-human-review';
    state.lifecycle = 'awaiting-human';
    state.next_action = `human review and accept checkpoint ${projected.checkpoint_commit}`;
  } else {
    acceptSlice(root, state, context, projected);
    if (state.lifecycle === 'completion-verification-ready') {
      return cumulativeVerification(root, state, context, dependencies);
    }
  }
  return saveState(root, state);
}

function handleCompletedImplementation(root, state, context, slice, projected, output, options, dependencies, correction) {
  const verification = verify(root, state, slice, dependencies);
  projected.failure_proof = output.failure_proof;
  projected.verification = verificationRecord(slice, verification);
  if (verification.status !== 0) {
    if (correction || projected.correction_count >= 1) {
      projected.status = 'blocked';
      state.lifecycle = 'blocked';
      state.blocked_reason = `Review Slice ${slice.id} failed after its one bounded correction`;
      state.next_action = 'human diagnosis required';
    } else {
      projected.status = 'correction-ready';
      projected.verification_failure = verification.diagnostic || 'verification command failed';
      state.lifecycle = 'ready';
      state.next_action = `run one deterministic-failure correction for ${slice.id}`;
    }
    return saveState(root, state);
  }
  if (correction) projected.correction_count += 1;
  return checkpointVerifiedSlice(root, state, context, slice, projected, options, dependencies, {
    correction,
    declaredRisk: output.architecture_risk,
    provenance: correction ? 'correction' : 'implementation',
  });
}

// The green tail of a verified Review Slice, shared by the implementation run and by a standalone
// re-verification. Reaching it from re-verification is what lets an environmental failure be cleared
// without spending the one bounded correction on a defect the slice never had.
function checkpointVerifiedSlice(root, state, context, slice, projected, options, dependencies, { correction, declaredRisk, provenance }) {
  const committed = commitCheckpoint(state, slice, projected);
  const checkpointRisks = inspectCheckpointRisks(state.worktree, projected.base_commit, committed.checkpoint);
  const route = determinePath({
    declaredRisk,
    checkpointRisks: checkpointRisks.risks,
  });
  projected.route = route.path;
  projected.architecture_risk = route.risk;
  delete projected.verification_failure;
  // Binds exactly one correction: the direction is spent with the attempt it steered.
  delete projected.correction_direction;
  delete projected.correction_direction_blob;
  appendEvent(root, state.work_id, {
    event: 'checkpoint-created',
    review_slice_id: slice.id,
    base_commit: projected.base_commit,
    checkpoint_commit: projected.checkpoint_commit,
    route: projected.route,
    architecture_risk: projected.architecture_risk,
    changed_path_count: committed.paths.length,
    provenance,
  });
  if (correction) {
    projected.status = 'awaiting-human-review';
    state.lifecycle = 'awaiting-human';
    state.next_action = `human review corrected checkpoint ${projected.checkpoint_commit}`;
  } else if (route.path === 'architecture-sensitive' && !projected.design_check_ref) {
    projected.status = 'post-diff-design';
    state.lifecycle = 'ready';
    state.next_action = `record post-diff Design Check for ${slice.id}`;
  } else if (route.path === 'architecture-sensitive' || routineReviewSelected(state, slice, committed.checkpoint, options)) {
    projected.status = 'review-ready';
    state.lifecycle = 'ready';
    state.next_action = `run fresh review for ${slice.id}`;
  } else {
    acceptSlice(root, state, context, projected);
    if (state.lifecycle === 'completion-verification-ready') {
      return cumulativeVerification(root, state, context, dependencies);
    }
  }
  return saveState(root, state);
}

// A dirty Pair worktree is a precondition, not a verdict: cleaning the tree remedies it. Blocks of
// this class record what they interrupted so a later run can lift them once the tree is verifiably
// clean. Every other block stays latched for human adjudication.
const DIRTY_WORKTREE_PRECONDITION = 'dirty-worktree';
// States written before the precondition field existed are recognised by their reason text.
const LEGACY_DIRTY_WORKTREE_REASONS = ['Pair worktree is dirty before Review Slice', 'provider edited code before Design Check for'];

// Journalled, not only saved. Clearing the block appends an event but entering it did not, so a block was
// visible in state.json and absent from the record — and when state.json was later overwritten by another
// writer, the whole transition became unexplainable after the fact. The journal is what the reducer and
// every audit read, so a state the loop enters has to be in it. The paths themselves stay out: they are
// unreviewed working-tree content, not evidence, and the count is what makes the entry diagnosable.
function blockOnDirtyWorktree(root, state, projected, reason) {
  // Re-entry while already blocked must not overwrite the status the slice will resume into.
  if (projected.status !== 'blocked') projected.blocked_from = projected.status;
  projected.status = 'blocked';
  state.lifecycle = 'blocked';
  state.blocked_precondition = DIRTY_WORKTREE_PRECONDITION;
  state.blocked_reason = reason;
  state.next_action = 'inspect preserved worktree changes';
  // A new block supersedes any earlier recorded acceptance of a differently-dirty tree.
  delete state.dirty_worktree_waiver;
  appendEvent(root, state.work_id, {
    event: 'dirty-worktree-block',
    review_slice_id: projected.id,
    blocked_from: projected.blocked_from,
    blocked_reason: reason,
    dirty_path_count: worktreeStatus(state.worktree).split(/\r?\n/u).filter(line => line.trim()).length,
  });
  return saveState(root, state);
}

function blockedOnDirtyWorktree(state) {
  if (state.lifecycle !== 'blocked') return false;
  if (state.blocked_precondition === DIRTY_WORKTREE_PRECONDITION) return true;
  const reason = String(state.blocked_reason || '');
  return LEGACY_DIRTY_WORKTREE_REASONS.some(prefix => reason.startsWith(prefix));
}

// An unblock that keeps the tree as it is records a waiver naming the exact porcelain output the human
// accepted; any further change to the tree voids it. Without this the recorded decision was a no-op:
// the very next run re-entered the same dirty-worktree block the human had just adjudicated.
function unwaivedDirtyWorktree(state) {
  const status = worktreeStatus(state.worktree);
  if (!status.trim()) return false;
  return state.dirty_worktree_waiver?.digest !== digest(status);
}

function clearedDirtyWorktreeBlock(root, state) {
  if (!blockedOnDirtyWorktree(state)) return false;
  if (worktreeStatus(state.worktree).trim()) return false;
  const projected = state.slices.find(item => item.status === 'blocked');
  if (!projected) return false;
  // Legacy states carry no blocked_from; a recorded Design Check is what re-entry needs to know.
  projected.status = projected.blocked_from || (projected.design_check_blob ? 'design-ready' : 'queued');
  delete projected.blocked_from;
  state.lifecycle = 'ready';
  state.blocked_precondition = null;
  state.blocked_reason = null;
  state.next_action = `run Review Slice ${projected.id}`;
  appendEvent(root, state.work_id, { event: 'dirty-worktree-block-cleared', review_slice_id: projected.id, resumed_status: projected.status });
  saveState(root, state);
  return true;
}

function runSliceImplementation(root, state, context, slice, projected, options, dependencies) {
  const correction = projected.status === 'correction-ready';
  // The gate asks "did something outside this loop leave changes here" — and after an interrupt the
  // answer is no: the changes are the interrupted attempt's own half-finished work, which continuing is
  // supposed to pick up. Blocking on them would make interrupt-then-continue impossible.
  if (!correction && !projected.interrupted_at && unwaivedDirtyWorktree(state)) {
    return blockOnDirtyWorktree(root, state, projected, `Pair worktree is dirty before Review Slice ${slice.id}`);
  }
  if (!projected.base_commit) projected.base_commit = git(state.worktree, ['rev-parse', 'HEAD']).stdout;
  const headBefore = git(state.worktree, ['rev-parse', 'HEAD']).stdout;
  const run = providerCall(root, state, {
    sliceId: slice.id,
    kind: correction ? 'correction' : 'implementation',
    warm: { projected },
    buildPrompt: ({ warm }) => sliceAttemptPrompt(root, state, context, slice, projected, { correction, warm }),
  }, options, dependencies);
  // Spent by the attempt that carried it, exactly as a Correction Direction is: a warm session already
  // remembers the turn it was delivered in, and re-sending it every round would make one sentence read
  // as standing policy.
  spendSteering(root, state, projected);
  delete projected.interrupted_at;
  const output = validateSliceResult(run.output);
  const headAfter = git(state.worktree, ['rev-parse', 'HEAD']).stdout;
  if (headAfter !== headBefore) {
    projected.status = 'blocked';
    state.lifecycle = 'blocked';
    state.blocked_reason = `provider committed inside Review Slice ${slice.id}; Pair preserves it for human inspection`;
    state.next_action = 'human inspection required';
    return saveState(root, state);
  }
  if (output.status === 'blocked') {
    projected.status = 'blocked';
    state.lifecycle = 'blocked';
    state.blocked_reason = output.blocker;
    state.next_action = 'human decision required';
    return saveState(root, state);
  }
  if (output.status === 'design-required') {
    if (unwaivedDirtyWorktree(state)) {
      return blockOnDirtyWorktree(root, state, projected, `provider edited code before Design Check for ${slice.id}`);
    }
    saveDesignCheck(root, state, slice, projected, output.design_check, output.architecture_risk);
    projected.route = 'architecture-sensitive';
    projected.status = 'design-ready';
    state.lifecycle = 'ready';
    state.next_action = `implement thin vertical checkpoint for ${slice.id}`;
    return saveState(root, state);
  }
  return handleCompletedImplementation(root, state, context, slice, projected, output, options, dependencies, correction);
}

function runPostDiffDesign(root, state, context, slice, projected, options, dependencies) {
  const run = providerCall(root, state, {
    sliceId: slice.id,
    kind: 'post-diff-design',
    mode: 'review',
    buildPrompt: () => postDiffDesignPrompt({
      slice,
      criteria: criteriaText(context, slice),
      baseCommit: projected.base_commit,
      checkpointCommit: projected.checkpoint_commit,
    }),
  }, options, dependencies);
  const output = validateSliceResult(run.output);
  if (output.status !== 'design-required') throw new Error('post-diff escalation must return a Design Check without editing');
  saveDesignCheck(root, state, slice, projected, output.design_check, output.architecture_risk || projected.architecture_risk);
  projected.status = 'review-ready';
  state.lifecycle = 'ready';
  state.next_action = `run fresh review for ${slice.id}`;
  return saveState(root, state);
}

function combinedReview(root, state, context, options, dependencies) {
  const synthetic = {
    id: 'work-completion',
    outcome: 'Combined accepted Review Slices compose without new failures.',
    acceptance_criteria: [...context.criteria.keys()],
  };
  const projected = {
    base_commit: state.base_commit,
    checkpoint_commit: state.head_commit,
    route: 'architecture-sensitive',
    architecture_risk: 'Accepted Review Slices overlap and require combined-diff composition review.',
    verification: { status: 0, cumulative: true },
    design_check_ref: null,
  };
  const settings = warmSettingsForWork(state, dependencies.env || process.env);
  const run = providerCall(root, state, {
    sliceId: synthetic.id,
    kind: 'combined-review',
    mode: 'review',
    reviewSchema: true,
    buildPrompt: () => reviewPrompt({
      slice: synthetic,
      criteria: criteriaText(context, synthetic),
      baseCommit: projected.base_commit,
      checkpointCommit: projected.checkpoint_commit,
      verification: projected.verification,
      architectureRisk: projected.architecture_risk,
      guidance: [],
      diff: checkpointDiff(state.worktree, projected.base_commit, projected.checkpoint_commit, settings.reviewDiffInlineMaxBytes),
    }),
  }, options, dependencies);
  const recorded = recordReviewOutcome(root, {
    workId: state.work_id,
    sliceId: synthetic.id,
    baseCommit: state.base_commit,
    checkpointCommit: state.head_commit,
    runtime: run.runtime,
    model: run.model,
    effort: run.effort,
    usage: run.usage,
    review: run.output,
  });
  state.completion_review_outcome_id = recorded.outcome.review_outcome_id;
  if (recorded.outcome.findings.length > 0) {
    state.lifecycle = 'awaiting-human';
    state.next_action = 'adjudicate combined-diff review findings';
  } else {
    state.lifecycle = 'complete';
    state.next_action = null;
    updatePairRef(state.worktree, state.work_id, 'completed', state.head_commit);
    appendEvent(root, state.work_id, { event: 'work-completed', head_commit: state.head_commit, combined_review: recorded.outcome.review_outcome_id });
  }
  return saveState(root, state);
}

// A Review Slice at awaiting-feedback whose every finding already carries Review Feedback is not waiting
// on anything: its status simply fell behind evidence on disk. Repairing that here means the command a
// human already knows fixes it, so nobody has to discover a repair verb — advanceWork used to return
// unchanged at awaiting-human, which made the wedge look like a working loop doing nothing.
function staleAdjudication(root, state) {
  return state.slices.find(projected => {
    if (projected.status !== 'awaiting-feedback' || !projected.review_outcome_id) return false;
    const outcome = listReviewOutcomes(root, state.work_id).find(item => item.review_outcome_id === projected.review_outcome_id);
    return Boolean(outcome)
      && outcome.findings.length > 0
      && outcome.findings.every(finding => feedbackForFinding(root, state.work_id, finding.finding_id).length > 0);
  }) || null;
}

// Held across the whole dispatch, because the damage is not in any single write: two runs share one
// worktree and one state file, so each sweeps the other's half-written files into its checkpoint and
// whichever saves last erases the other's transition. That was observed as a dirty-worktree block which
// then vanished with no exit event. The lease is taken before the state is read, so a refused second run
// cannot even act on a snapshot the first run is already invalidating.
function advanceWork(root, options = {}, dependencies = {}) {
  const state = currentState(root, options.workId || null);
  return withDispatchLease(root, state.work_id, { command: 'run' }, () => advanceHeldWork(root, options, dependencies));
}

// An interrupted attempt is a human decision, not a fault, so it does not block the Work, does not spend
// the one correction, and is never recorded as an environment failure — that misclassification is what
// used to make stopping a run cost the loop its patience. recordFailedInvocation has already journalled
// the attempt by the time this runs; all that is left is to say where the slice stands.
function recordInterruptedAttempt(root, options) {
  const state = currentState(root, options.workId || null);
  const context = workContext(root, state);
  const projected = activeSlice(state, context)?.projected;
  if (projected) {
    projected.interrupted_at = now();
    appendEvent(root, state.work_id, {
      event: 'attempt-interrupted',
      review_slice_id: projected.id,
      status: projected.status,
      warm_session: Boolean(projected.warm_session?.session_id),
    });
  }
  state.lifecycle = 'ready';
  state.next_action = projected
    ? `steer or re-run ${projected.id}: pair-loop steer --text "<direction>" then pair-loop run`
    : 'run again';
  return saveState(root, state);
}

function advanceHeldWork(root, options = {}, dependencies = {}) {
  try {
    return dispatchHeldWork(root, options, dependencies);
  } catch (error) {
    if (!error.pair_interrupted) throw error;
    return recordInterruptedAttempt(root, options);
  }
}

function dispatchHeldWork(root, options = {}, dependencies = {}) {
  const state = currentState(root, options.workId || null);
  const context = workContext(root, state);
  clearedDirtyWorktreeBlock(root, state);
  // One transition per invocation: the repaired position is reported rather than used to spend the one
  // correction in the same breath, so the human sees where the slice landed before steering it. Labelled
  // on the way out — and only on the returned object, after the save, so it never becomes durable state —
  // because a run that dispatched no coding session must not look like one that dispatched a useless one.
  const stale = staleAdjudication(root, state);
  if (stale) return { ...projectAdjudication(root, state, stale), pair_transition: 'projection-repaired' };
  if (state.lifecycle === 'complete' || state.lifecycle === 'blocked' || state.lifecycle === 'awaiting-human') return state;
  if (state.lifecycle === 'completion-verification-ready') return cumulativeVerification(root, state, context, dependencies);
  if (state.lifecycle === 'completion-review-ready') return combinedReview(root, state, context, options, dependencies);
  const active = activeSlice(state, context);
  if (!active) {
    state.lifecycle = 'completion-verification-ready';
    return cumulativeVerification(root, state, context, dependencies);
  }
  const { projected, manifest: slice } = active;
  if (projected.status === 'review-ready') return runCheckpointReview(root, state, context, slice, projected, options, dependencies);
  if (projected.status === 'post-diff-design') return runPostDiffDesign(root, state, context, slice, projected, options, dependencies);
  return runSliceImplementation(root, state, context, slice, projected, options, dependencies);
}

const CORRECTION_DIRECTION_LIMIT = 1000;

// A Correction Direction is admitted at any status: it is stored on the slice and spent by whichever
// attempt runs next, and an out-of-window use is recorded as a human override rather than refused.
function recordCorrectionDirection(root, options = {}) {
  const state = currentState(root, options.workId || null);
  const context = workContext(root, state);
  const active = activeSlice(state, context);
  const projected = options.sliceId
    ? state.slices.find(item => item.id === options.sliceId)
    : active?.projected;
  if (!projected) throw new Error('no Review Slice selected for a Correction Direction');
  // Policy, not structure: the direction is stored on the slice and spent by whichever attempt runs
  // next, so recording it early costs nothing. Refusing it outside correction-ready meant a human who
  // could already see the wrong turn had to wait for the reducer's permission to say so.
  if (projected.status !== 'correction-ready') {
    recordHumanOverride(root, state, projected, 'direct', options.reason || `steer ${projected.id} while ${projected.status}`);
  }
  const text = String(options.text || '').replace(/\s+/gu, ' ').trim();
  if (!text) throw new Error('a Correction Direction requires --text');
  if (text.length > CORRECTION_DIRECTION_LIMIT) {
    throw new Error(`a Correction Direction must use 1-${CORRECTION_DIRECTION_LIMIT} characters`);
  }
  const stored = storeBlob(root, state.work_id, `correction-directions/${projected.id}`, text);
  projected.correction_direction = text;
  projected.correction_direction_blob = stored.objectId;
  appendEvent(root, state.work_id, {
    event: 'correction-direction-recorded',
    review_slice_id: projected.id,
    evidence_ref: stored.ref,
    evidence_blob: stored.objectId,
  });
  return saveState(root, state);
}

function spendSteering(root, state, projected) {
  if (!projected.steering_ref) return;
  appendEvent(root, state.work_id, { event: 'steering-delivered', review_slice_id: projected.id, evidence_ref: projected.steering_ref });
  delete projected.steering_ref;
  delete projected.steering_blob;
  delete projected.steering_bytes;
}

// The human half of a warm session. `direct` writes a Correction Direction — a model-facing field, bound
// at 1000 characters, spent by one correction. This is the other thing a person needs: say something to
// the session that is already carrying this slice, in as many words as it takes, and have it continue.
// Bounded at 8 KiB because that is a bound on typing, not on generation.
function steerWarmSession(root, options = {}, dependencies = {}) {
  const state = currentState(root, options.workId || null);
  const context = workContext(root, state);
  const projected = options.sliceId
    ? state.slices.find(item => item.id === options.sliceId)
    : activeSlice(state, context)?.projected;
  if (!projected) throw new Error('no Review Slice selected to steer');
  // Trimmed at the ends only. Collapsing whitespace is right for a field a model must parse as one
  // claim; a human writing eight kilobytes is writing paragraphs, and reflowing them loses their shape.
  const text = String(options.text || '').trim();
  if (!text) throw new Error('steering requires --text');
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > STEER_TEXT_LIMIT_BYTES) {
    throw new Error(`human steering is bounded at ${STEER_TEXT_LIMIT_BYTES} bytes and this is ${bytes}. Cut ${bytes - STEER_TEXT_LIMIT_BYTES}, or record the longer half as a finding against the checkpoint it concerns.`);
  }
  const stored = storeBlob(root, state.work_id, `steering/${projected.id}`, text);
  projected.steering_ref = stored.ref;
  projected.steering_blob = stored.objectId;
  projected.steering_bytes = bytes;
  const warm = Boolean(projected.warm_session?.session_id);
  appendEvent(root, state.work_id, {
    event: 'steering-recorded',
    review_slice_id: projected.id,
    bytes,
    warm_session: warm,
    evidence_ref: stored.ref,
    evidence_blob: stored.objectId,
  });
  saveState(root, state);
  // Dispatching is what makes this a turn in the warm session rather than a note nobody reads. Only from
  // `ready`: steering a Work that is waiting on adjudication must not jump the gate that is waiting for
  // the human, and the text still reaches whichever attempt runs next.
  if (options.dispatch === false || state.lifecycle !== 'ready') {
    return { state, dispatched: false, warm_session: warm, review_slice_id: projected.id };
  }
  return {
    state: advanceWork(root, options, dependencies),
    dispatched: true,
    warm_session: warm,
    review_slice_id: projected.id,
  };
}

// Re-running the declared verification is not a model action, so it costs no correction. That is the
// point: a Review Slice parked at correction-ready by an environmental failure — a flake, a missing
// build step, a pre-existing failure inside its verify scope — has sound code and no defect for a
// correction to correct. Spending the one correction there is what drove humans off the loop and
// into hand-driven edits that Pair can no longer see.
function verifyActiveSlice(root, options = {}, dependencies = {}) {
  const state = currentState(root, options.workId || null);
  const context = workContext(root, state);
  const active = activeSlice(state, context);
  const projected = options.sliceId
    ? state.slices.find(item => item.id === options.sliceId)
    : active?.projected;
  if (!projected) throw new Error('no Review Slice selected for verification');
  if (projected.status === 'accepted') throw new Error(`Review Slice ${projected.id} is already accepted`);
  const slice = manifestSlice(context, projected.id);
  const verification = verify(root, state, slice, dependencies);
  projected.verification = verificationRecord(slice, verification);
  const report = {
    review_slice_id: projected.id,
    command: slice.verify,
    status: verification.status,
    observed_status: verification.observed_status ?? verification.status,
    failing_tests: verification.failing_tests || [],
    baselined_failing_tests: verification.baselined_failing_tests || [],
    introduced_failing_tests: verification.introduced_failing_tests || [],
    introduced_warnings: verification.introduced_warnings || [],
    diagnostic: verification.status === 0 ? null : verification.diagnostic || null,
    checkpoint_created: false,
  };
  // Only the deterministic-failure road can be cleared by re-verification. A slice sitting at
  // correction-ready because a human called a review finding valid already has a green checkpoint:
  // its verification was never the problem, and promoting again would try to commit an unchanged
  // worktree. That one owes a correction, not another suite run.
  const clearsDeterministicFailure = projected.status === 'correction-ready' && Boolean(projected.verification_failure);
  report.clears_deterministic_failure = clearsDeterministicFailure;
  if (verification.status !== 0) {
    if (clearsDeterministicFailure) projected.verification_failure = verification.diagnostic || 'verification command failed';
    return { report, state: saveState(root, state) };
  }
  if (!clearsDeterministicFailure) return { report, state: saveState(root, state) };
  if (!projected.failure_proof) throw new Error(`Review Slice ${projected.id} has no recorded Failure Proof; a checkpoint cannot be created from re-verification alone`);
  const promoted = checkpointVerifiedSlice(root, state, context, slice, projected, options, dependencies, {
    correction: false,
    declaredRisk: projected.architecture_risk,
    provenance: 'verification',
  });
  report.checkpoint_created = true;
  report.checkpoint_commit = projected.checkpoint_commit;
  return { report, state: promoted };
}

// Pair gates on human acceptance but stored the material for it in refs and blobs a person has to
// discover with git plumbing first. A gate whose evidence is that hard to reach is answered by
// reflex, which is the opposite of what human acceptance is for. This assembles the anchors Pair
// already holds — it reads, decides nothing, and changes no state.
// Reviewing a correction means answering two questions the cumulative diff cannot: which changes answer
// which finding, and which changes nobody asked for. "This file changed" answers neither — a file can
// change far from the anchored line, and the corrector's own additions sit in the same diff as the fixes.
// Findings carry exact line anchors and the diff carries exact hunk ranges, so the attribution is
// derivable rather than guessed. -U0 keeps hunk ranges tight to what actually changed.
function correctionHunks(worktree, priorCheckpoint, checkpointCommit) {
  if (!priorCheckpoint || !checkpointCommit) return null;
  const output = git(worktree, ['diff', '-U0', '--no-color', `${priorCheckpoint}..${checkpointCommit}`], { trim: false }).stdout;
  const files = new Map();
  let current = null;
  for (const line of output.split(/\r?\n/u)) {
    const target = line.match(/^\+\+\+ (?:b\/)?(.+)$/u);
    if (target) {
      current = target[1] === '/dev/null' ? null : target[1];
      if (current && !files.has(current)) files.set(current, []);
      continue;
    }
    const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u);
    if (hunk && current) {
      files.get(current).push({
        old_start: Number(hunk[1]),
        old_lines: hunk[2] === undefined ? 1 : Number(hunk[2]),
        new_start: Number(hunk[3]),
        new_lines: hunk[4] === undefined ? 1 : Number(hunk[4]),
      });
    }
  }
  return files;
}

// "Did the correction change anything" was only answerable by opening a diff and reading it, and the diff a
// human reaches for first — the whole slice — cannot answer it at all when the slice created the file being
// corrected: the file is one added block there, so an edit inside it is invisible as a delta. Observed live on
// S-05, where 9 renamed tests read as no change. The counts come from hunks already parsed, so this costs
// nothing beyond the diff correctionAttribution already ran.
function correctionShape(files) {
  if (!files) return null;
  let hunkCount = 0;
  let added = 0;
  let removed = 0;
  for (const hunks of files.values()) {
    for (const hunk of hunks) {
      hunkCount += 1;
      added += hunk.new_lines;
      removed += hunk.old_lines;
    }
  }
  return { file_count: files.size, hunk_count: hunkCount, lines_added: added, lines_removed: removed };
}

// A pure insertion carries old_lines 0; it still sits at a place in the old file, so it is compared as a
// single line rather than an empty range that can never overlap anything.
function hunkOldRange(hunk) {
  const span = Math.max(hunk.old_lines, 1);
  return { start: hunk.old_start, end: hunk.old_start + span - 1 };
}

// A bounded fix for a finding anchored at one line rarely edits that exact line: it inserts a guard below
// it, or rewrites the few lines around it. Strict overlap therefore reports a real fix as "nothing at your
// lines" AND counts it as scope nobody asked for — wrong twice, in opposite directions. Proximity is the
// only signal available without parsing the language, so it is used and named as proximity, never as proof
// the finding is addressed. The window is reported alongside the result so the rule is never implicit.
const CORRECTION_PROXIMITY_LINES = 10;

function correctionAttribution(worktree, priorCheckpoint, checkpointCommit, findings) {
  const files = correctionHunks(worktree, priorCheckpoint, checkpointCommit);
  if (!files) return null;
  const claimed = new Set();
  const perFinding = new Map();
  for (const finding of findings) {
    const hunks = files.get(finding.evidence.path) || [];
    const anchor = { start: finding.evidence.line_start, end: finding.evidence.line_end };
    const overlapping = [];
    const near = [];
    let nearest = null;
    for (const hunk of hunks) {
      const range = hunkOldRange(hunk);
      const key = `${finding.evidence.path}:${hunk.old_start}:${hunk.old_lines}`;
      if (range.start <= anchor.end && range.end >= anchor.start) {
        overlapping.push(hunk);
        claimed.add(key);
        nearest = 0;
        continue;
      }
      const distance = range.start > anchor.end ? range.start - anchor.end : anchor.start - range.end;
      if (nearest === null || distance < nearest) nearest = distance;
      if (distance <= CORRECTION_PROXIMITY_LINES) {
        near.push({ ...hunk, distance });
        claimed.add(key);
      }
    }
    perFinding.set(finding.finding_id, {
      file_changed: files.has(finding.evidence.path),
      overlapping_hunks: overlapping,
      near_hunks: near,
      nearest_distance: nearest,
      proximity_lines: CORRECTION_PROXIMITY_LINES,
    });
  }
  // Everything the findings do not account for. This is the corrector's own scope, and the bounded
  // correction contract is exactly what it is most likely to have widened.
  const unattributed = [];
  for (const [file, hunks] of files) {
    const loose = hunks.filter(hunk => !claimed.has(`${file}:${hunk.old_start}:${hunk.old_lines}`));

    if (loose.length > 0) {
      unattributed.push({
        path: file,
        hunks: loose.length,
        added_lines: loose.reduce((total, hunk) => total + hunk.new_lines, 0),
        anchored_by_a_finding: findings.some(finding => finding.evidence.path === file),
      });
    }
  }
  return { perFinding, unattributed };
}

function sliceEvidence(root, options = {}) {
  const state = currentState(root, options.workId || null);
  const context = workContext(root, state);
  const active = activeSlice(state, context);
  const projected = options.sliceId
    ? state.slices.find(item => item.id === options.sliceId)
    : active?.projected;
  if (!projected) throw new Error('no Review Slice selected');
  const slice = manifestSlice(context, projected.id);
  const workRef = `refs/pair/${state.work_id}`;
  const checkpoints = readEvents(root, state.work_id)
    .filter(item => item.event === 'checkpoint-created' && item.review_slice_id === projected.id)
    .map(item => item.checkpoint_commit);
  const priorCheckpoint = checkpoints.length > 1 ? checkpoints.at(-2) : null;
  const outcome = projected.review_outcome_id
    ? listReviewOutcomes(root, state.work_id).find(item => item.review_outcome_id === projected.review_outcome_id)
    : null;
  const attribution = correctionAttribution(state.worktree, priorCheckpoint, projected.checkpoint_commit, outcome?.findings || []);
  const shape = correctionShape(correctionHunks(state.worktree, priorCheckpoint, projected.checkpoint_commit));
  return {
    work_id: state.work_id,
    worktree: state.worktree,
    review_slice_id: projected.id,
    status: projected.status,
    route: projected.route || null,
    outcome: slice.outcome,
    acceptance_criteria: relevantAcceptanceCriteria(context.criteria, slice),
    base_commit: projected.base_commit || state.base_commit,
    checkpoint_commit: projected.checkpoint_commit || null,
    prior_checkpoint_commit: priorCheckpoint,
    correction_shape: shape,
    correction_count: projected.correction_count,
    architecture_risk: projected.architecture_risk || null,
    design_check: readPairRefText(root, workRef, `design-checks/${projected.id}`),
    correction_direction: readPairRefText(root, workRef, `correction-directions/${projected.id}`),
    verification: projected.verification || null,
    verify_command: slice.verify,
    findings: (outcome?.findings || []).map(finding => ({
      ...finding,
      feedback: feedbackForFinding(root, state.work_id, finding.finding_id),
      correction: attribution?.perFinding.get(finding.finding_id) || null,
    })),
    correction_unattributed: attribution?.unattributed || [],
  };
}

function readPairRefText(root, workRef, suffix) {
  const ref = `${workRef}/${suffix}`;
  const result = git(root, ['cat-file', '-p', ref], { allowFailure: true });
  return result.status === 0 && result.stdout ? result.stdout : null;
}

function acceptHumanReview(root, options = {}, dependencies = {}) {
  const state = currentState(root, options.workId || null);
  const context = workContext(root, state);
  const projected = state.slices.find(item => item.id === options.sliceId);
  if (!projected) throw new Error('Review Slice is not awaiting human acceptance');
  if (projected.status !== 'awaiting-human-review') {
    if (!options.override) throw new Error('Review Slice is not awaiting human acceptance');
    // Structural, not policy: acceptSlice records checkpoint_commit, so a slice that never produced one
    // would be accepted as an empty acceptance that no diff backs.
    if (!projected.checkpoint_commit) {
      throw new Error(`Review Slice ${projected.id} has no checkpoint to accept; run it before overriding acceptance`);
    }
    recordHumanOverride(root, state, projected, 'accept', options.reason);
  }
  const outcome = projected.review_outcome_id
    ? listReviewOutcomes(root, state.work_id).find(item => item.review_outcome_id === projected.review_outcome_id)
    : null;
  // A human who overrides acceptance has adjudicated the checkpoint themselves; requiring per-finding
  // feedback on top of that would be the reducer second-guessing the decision it was just told to yield.
  if (outcome && !options.override) {
    for (const finding of outcome.findings) {
      const feedback = feedbackForFinding(root, state.work_id, finding.finding_id);
      if (feedback.length === 0) throw new Error(`finding ${finding.finding_id} has no Review Feedback`);
      if (feedback.some(item => item.disposition === 'valid') && projected.correction_count === 0) {
        throw new Error(`valid finding ${finding.finding_id} requires correction`);
      }
    }
  }
  acceptSlice(root, state, context, projected);
  if (state.lifecycle === 'completion-verification-ready') return cumulativeVerification(root, state, context, dependencies);
  return state;
}

// Derived purely from the immutable Review Outcome and its append-only Review Feedback, so it can be
// re-run at any time and always lands on the same answer. Recording and projecting were fused, which
// meant a caller that recorded feedback without the reducer left a Review Slice permanently behind its
// own evidence: the feedback exists, so a second one is refused, and no command could catch the state up.
function projectAdjudication(root, state, projected) {
  const outcome = listReviewOutcomes(root, state.work_id).find(item => item.review_outcome_id === projected.review_outcome_id);
  const unadjudicated = outcome.findings.filter(finding => feedbackForFinding(root, state.work_id, finding.finding_id).length === 0);
  if (unadjudicated.length > 0) {
    // The slice holds until every finding has feedback. Leaving next_action at the submitted count made
    // one-of-three look identical to none-of-three, so the gate that holds the slice was invisible.
    state.next_action = `adjudicate ${unadjudicated.length} of ${outcome.findings.length} remaining finding(s) for ${projected.id}`;
    return saveState(root, state);
  }
  const valid = outcome.findings.some(finding => feedbackForFinding(root, state.work_id, finding.finding_id).some(item => item.disposition === 'valid'));
  // The budget bounds a MODEL loop. A fresh reviewer can always find something, so find → correct → find →
  // correct never terminates on its own, and the block is what puts a human back in it. A human review is
  // already that human: reading the checkpoint the last correction produced, writing a finding against it
  // and submitting it IS the deliberation `unblock --reason "<why a second correction is warranted>"` asks
  // for. Observed live on S-08 — round two of a human review blocked one gesture after the human typed the
  // finding that says why, and the only way forward was to write the same justification again in different
  // words. The failure path in handleCompletedImplementation is deliberately untouched: a correction that
  // fails its own verification still blocks whoever raised it, because that bounds a model that cannot do
  // the work rather than a human who keeps finding more of it.
  const humanReview = Boolean(outcome.reviewer?.human);
  if (valid && projected.correction_count >= 1 && !humanReview) {
    projected.status = 'blocked';
    state.lifecycle = 'blocked';
    state.blocked_reason = `Review Slice ${projected.id} exhausted its one correction`;
    state.next_action = 'human correction required';
  } else if (valid) {
    projected.status = 'correction-ready';
    state.lifecycle = 'ready';
    state.next_action = `run one human-valid correction for ${projected.id}`;
  } else {
    projected.status = 'awaiting-human-review';
    state.lifecycle = 'awaiting-human';
    state.next_action = `human review and accept checkpoint ${projected.checkpoint_commit}`;
  }
  return saveState(root, state);
}

// The one correction is irreversible and the brief that steers it was invisible: correctionPrompt is
// internal, so the only way to know what the correcting session would be told was to spend the correction
// and read the diff afterwards. Reading it changes nothing, which is why it is safe to look first — and
// looking is what makes `direct` a decision rather than a guess.
function correctionBrief(root, options = {}) {
  const state = currentState(root, options.workId || null);
  const context = workContext(root, state);
  const projected = options.sliceId
    ? state.slices.find(item => item.id === options.sliceId)
    : activeSlice(state, context)?.projected;
  if (!projected) throw new Error('no Review Slice selected for a correction brief');
  if (projected.status !== 'correction-ready') {
    throw new Error(`Review Slice ${projected.id} is ${projected.status}; a correction brief exists only at correction-ready`);
  }
  // Shown as the correction would run right now: a slice holding a warm session receives only the
  // call-variable tail, and a brief that pretended otherwise would misrepresent the very thing it exists
  // to make visible.
  const warm = Boolean(projected.warm_session?.session_id);
  return {
    work_id: state.work_id,
    review_slice_id: projected.id,
    correction_direction: projected.correction_direction || null,
    warm_session: warm,
    prompt: sliceAttemptPrompt(root, state, context, manifestSlice(context, projected.id), projected, { correction: true, warm }),
  };
}

// Catches a projection up to evidence already on disk. Restricted to awaiting-feedback because that is
// the only status the reducer can fall behind in: re-deriving an accepted slice would regress it past an
// acceptance that compactAcceptedSlice has already recorded.
function reconcileAdjudication(root, options = {}) {
  const state = currentState(root, options.workId || null);
  const context = workContext(root, state);
  const projected = options.sliceId
    ? state.slices.find(item => item.id === options.sliceId)
    : state.slices.find(item => item.status === 'awaiting-feedback') || activeSlice(state, context)?.projected;
  if (!projected) throw new Error('no Review Slice selected to reconcile');
  if (projected.status !== 'awaiting-feedback') {
    throw new Error(`nothing to reconcile: Review Slice ${projected.id} is ${projected.status}, and only awaiting-feedback can fall behind its Review Feedback`);
  }
  if (!projected.review_outcome_id) throw new Error(`Review Slice ${projected.id} has no Review Outcome to reconcile against`);
  return projectAdjudication(root, state, projected);
}

// The submit IS the human input. Closing adjudication on a valid finding and then waiting to be told
// "now run" is a second gesture asking the human to confirm what they just said — and the wait it
// creates is where a 30-to-55-minute review round is spent.
//
// Called by the human surfaces after their gesture lands, and deliberately NOT folded into
// adjudicateFinding or submitHumanFindings. Those are bookkeeping: a projection repair, a batch, or a
// test that records feedback must not spend a model session as a side effect of writing a row. A
// dispatch belongs to the gesture a person actually made, which is the only place that knows one was
// made — which is also what keeps "never spends autonomously" structural rather than conventional.
function dispatchCorrectionOnSubmit(root, options = {}, dependencies = {}) {
  const state = currentState(root, options.workId || null);
  const settings = warmSettingsForWork(state, dependencies.env || process.env);
  if (!settings.dispatchCorrectionOnSubmit || state.lifecycle !== 'ready') return { state, dispatched: false };
  const context = workContext(root, state);
  const projected = options.sliceId
    ? state.slices.find(item => item.id === options.sliceId)
    : activeSlice(state, context)?.projected;
  if (projected?.status !== 'correction-ready') return { state, dispatched: false };
  return { state: advanceWork(root, { ...options, sliceId: projected.id }, dependencies), dispatched: true };
}

function adjudicateFinding(root, options = {}) {
  const state = currentState(root, options.workId || null);
  const feedback = recordReviewFeedback(root, {
    workId: state.work_id,
    findingId: options.findingId,
    disposition: options.disposition,
    reason: options.reason,
  });
  const projected = state.slices.find(item => item.review_outcome_id === feedback.review_outcome_id);
  if (!projected) {
    state.lifecycle = feedback.disposition === 'valid' ? 'blocked' : 'completion-review-ready';
    state.blocked_reason = feedback.disposition === 'valid' ? 'valid combined-diff finding requires human-scoped correction' : null;
    state.next_action = feedback.disposition === 'valid' ? 'human correction required' : 'resume combined-diff completion';
    return saveState(root, state);
  }
  return projectAdjudication(root, state, projected);
}

// The missing half of review: Pair assumed the model finds and the human adjudicates, so a human who
// reviewed the diff themselves had no way to put a finding into the record — their only routes were to
// accept it anyway or to defer the issue to a later slice's amendment. A human finding is recorded as a
// real Review Outcome against the same immutable commit/blob/line evidence a model finding must anchor,
// marked human in its provenance, so the existing adjudication and one-correction path carries it
// without a second mechanism.
function humanDraftFile(root, workId, sliceId) {
  return path.join(workPaths(root, workId).findingDrafts, `${safeSegment(sliceId, 'Review Slice ID')}.json`);
}

// A pass condition identical to the claim is residue from the version that defaulted one from the other, and
// every draft written then still carries it on disk. Stripping it on read means no surface downstream has to
// decide whether a "passes when" line is a second statement or the first one repeated.
function withoutEchoedPassCondition(finding) {
  const claim = String(finding.claim ?? '').replace(/\s+/gu, ' ').trim();
  const passCondition = String(finding.pass_condition ?? '').replace(/\s+/gu, ' ').trim();
  if (passCondition && passCondition !== claim) return finding;
  const { pass_condition: echoed, ...rest } = finding;
  return rest;
}

function listHumanFindingDraft(root, workId, sliceId) {
  return (readJson(humanDraftFile(root, workId, sliceId))?.findings || []).map(withoutEchoedPassCondition);
}

function selectedSlice(state, context, options) {
  const projected = options.sliceId
    ? state.slices.find(item => item.id === options.sliceId)
    : activeSlice(state, context)?.projected;
  if (!projected) throw new Error('no Review Slice selected for a finding');
  if (!projected.checkpoint_commit) {
    throw new Error(`Review Slice ${projected.id} has no checkpoint to anchor a finding against`);
  }
  return projected;
}

// The submission gate below refuses a pass condition that is MISSING, which leaves a typed placeholder as
// the way through it: a human asked for "the observable state" with no example to hand answers with the
// sentence recordHumanFinding's own comment forbids fabricating — "the human who raised this confirms it is
// addressed" — and a tautology satisfies every check a null fails. A pass condition that defers the verdict
// back to a person is exactly as unfalsifiable to the corrector as none at all, so it is refused where it
// is written rather than discovered when the one bounded correction has already been spent on it.
const DEFERRED_PASS_CONDITION = /\b(?:human|reviewer|author|maintainer|i|we)\b[\s\S]{0,48}?\b(?:confirm|confirms|confirmed|agree|agrees|approve|approves|accept|accepts|signs? off|is satisfied|is happy)\b/iu;

function humanPassCondition(value) {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim();
  if (!text) return null;
  if (DEFERRED_PASS_CONDITION.test(text)) {
    throw new Error([
      `"${text}" defers the verdict to a person, so the correcting session has nothing it can check.`,
      'Name the observable state instead — what is true of the code once this is addressed, that a reader or a',
      'command could confirm without asking you. For example: "Every test in the suite is named',
      'Capability_verb_fact" rather than "the naming is fixed".',
    ].join('\n'));
  }
  return text;
}

// Bounded here, at the gesture still holding the text, and not only in the Review Outcome the submission
// mints. Observed live: four findings drafted against one checkpoint, the fourth 202 characters long, and
// the bound surfaced as a refusal of the whole submission — from a gesture that can edit nothing, naming a
// limit but not the length, for a finding the human had stopped looking at three findings ago.
function humanClaim(value) {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim();
  if (!text) throw new Error('a human finding requires a claim');
  if (text.length > HUMAN_TEXT_BOUNDS.claim) {
    throw new Error([
      `This claim is ${text.length} characters and a finding carries at most ${HUMAN_TEXT_BOUNDS.claim}.`,
      `Cut ${text.length - HUMAN_TEXT_BOUNDS.claim} and it drafts. What does not fit is usually the reasoning`,
      'behind the claim, and the correcting session reads the lines you are anchoring it to anyway.',
    ].join('\n'));
  }
  return text;
}

// Every route to a drafted finding ran through the human's memory: drafting printed the draft once as
// transient output, and status, show, and the Review Inbox never read the draft directory at all. A draft
// is the one piece of review evidence a human authors, so a write-only draft is the one piece they cannot
// re-read before spending a submission on it — and the missing pass condition that submission refuses on
// was invisible until the refusal. Stale drafts are reported rather than hidden: a draft is deleted when it
// is submitted and never otherwise, so a slice accepted by any other route orphans its draft forever.
function humanFindingDrafts(root, workId = null) {
  const state = currentState(root, workId);
  const directory = workPaths(root, state.work_id).findingDrafts;
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter(name => name.endsWith('.json'))
    .sort()
    .map(name => {
      const stored = readJson(path.join(directory, name)) || {};
      const findings = stored.findings || [];
      const slice = state.slices.find(item => item.id === stored.review_slice_id);
      const staleReason = !slice
        ? 'the Review Slice is no longer in the manifest'
        : slice.status === 'accepted'
          ? `Review Slice ${slice.id} is already accepted, so no submission can reach it`
          : slice.checkpoint_commit !== stored.checkpoint_commit
            ? 'the Review Slice has moved to a newer checkpoint, so this anchor is not in it'
            : null;
      return {
        review_slice_id: stored.review_slice_id || path.basename(name, '.json'),
        checkpoint_commit: stored.checkpoint_commit || null,
        findings: findings.map(withoutEchoedPassCondition),
        stale: Boolean(staleReason),
        stale_reason: staleReason,
      };
    });
}

function recordHumanFinding(root, options = {}) {
  const state = currentState(root, options.workId || null);
  const context = workContext(root, state);
  const projected = selectedSlice(state, context, options);
  const lineStart = Number(options.lineStart ?? options.line);
  const lineEnd = Number(options.lineEnd ?? lineStart);
  // Validated here and not only in the CLI: a NaN anchor is stored silently and then makes every
  // hunk-overlap comparison in correctionAttribution false, which reads as "nothing at your lines".
  if (!Number.isInteger(lineStart) || lineStart < 1) throw new Error('a human finding requires an integer line anchor of 1 or greater');
  if (!Number.isInteger(lineEnd) || lineEnd < lineStart) throw new Error('a human finding line end must be an integer at or after its line start');
  // Drafting only: no Review Outcome, no status change. Reading a diff produces findings one at a time,
  // and minting an immutable content-addressed outcome per finding is what filled the Review Inbox with
  // stale duplicates whose dispositions the adjudication gate could never see.
  const claim = humanClaim(options.claim);
  // A pass condition is optional and, when unstated, absent — not a copy of the claim. Requiring one cost a
  // second prompt per finding and bought nothing (the answers it produced live were a null, the phrase
  // "coding convention", and the deferring tautology humanPassCondition refuses); defaulting it to the claim
  // cost nothing but printed every finding twice under two headings. The human raises the issue; working out
  // what "addressed" looks like is the correcting session's job, and the claim is what it goes on. The
  // deferral guard applies only to a condition someone chose to type — a claim is never second-guessed for
  // its wording, because refusing it would block the drafting gesture rather than a placeholder at a gate.
  const passCondition = humanPassCondition(options.passCondition);
  const finding = {
    severity: options.severity || 'MAJOR',
    claim,
    scenario: options.scenario || claim,
    impact: options.impact || claim,
    ...(passCondition && passCondition !== claim ? { pass_condition: passCondition } : {}),
    evidence: {
      commit: projected.checkpoint_commit,
      path: options.file,
      blob: blobAtCommit(state.worktree, projected.checkpoint_commit, options.file),
      line_start: lineStart,
      line_end: lineEnd,
    },
  };
  const file = humanDraftFile(state.worktree, state.work_id, projected.id);
  const existing = listHumanFindingDraft(state.worktree, state.work_id, projected.id);
  // Refused here rather than merely displayed. Observed live: the same anchor was drafted three times, the
  // claim reworded each time, because each refusal named a problem and answered it with a shell command
  // while the only gesture bound to a key was "draft another". A second finding on the same lines is a
  // re-draft far more often than a second concern, so the escape is explicit and the refusal names every
  // way forward — complete the one already there, discard it, or declare this a separate concern.
  if (!options.allowSameAnchor) {
    const clash = existing.findIndex(item => item.evidence?.path === options.file
      && Number(item.evidence?.line_start) <= lineEnd
      && Number(item.evidence?.line_end) >= lineStart);
    if (clash !== -1) {
      throw new Error([
        `Drafted finding ${clash + 1} for ${projected.id} already anchors ${options.file}:${existing[clash].evidence.line_start}-${existing[clash].evidence.line_end}:`,
        `  ${existing[clash].claim}`,
        ...(existing[clash].pass_condition ? [`  passes when: ${existing[clash].pass_condition}`] : []),
        'If this is the same concern, reword or discard that one rather than drafting a second copy:',
        `  pair-loop finding --slice ${projected.id} --index ${clash + 1} --text "<the claim, reworded>"`,
        `  pair-loop finding --slice ${projected.id} --index ${clash + 1} --drop`,
        'If it is genuinely a separate concern on the same lines, say so:',
        `  ...--allow-same-anchor`,
      ].join('\n'));
    }
  }
  const findings = [...existing, finding];
  writeJson(file, { schema: 1, review_slice_id: projected.id, checkpoint_commit: projected.checkpoint_commit, findings });
  return { drafted: finding, findings, file, sliceId: projected.id };
}

// Every gesture that edits a draft resolves the same three things — which slice, which findings, which one
// of them — and defaults to the finding just drafted, because that is the one the human is still looking at.
function draftTarget(root, options, verb) {
  const state = currentState(root, options.workId || null);
  const context = workContext(root, state);
  const projected = selectedSlice(state, context, options);
  const findings = listHumanFindingDraft(state.worktree, state.work_id, projected.id);
  if (findings.length === 0) throw new Error(`Review Slice ${projected.id} has no drafted finding to ${verb}`);
  const index = options.index === undefined || options.index === null ? findings.length : Number(options.index);
  if (!Number.isInteger(index) || index < 1 || index > findings.length) {
    throw new Error(`drafted finding ${options.index} is outside 1-${findings.length} for ${projected.id}`);
  }
  return { state, projected, findings, index };
}

function writeDraft(state, projected, findings) {
  writeJson(humanDraftFile(state.worktree, state.work_id, projected.id), {
    schema: 1,
    review_slice_id: projected.id,
    checkpoint_commit: projected.checkpoint_commit,
    findings,
  });
}

// A draft is the mutable half of review on purpose — a Review Outcome is immutable and content-addressed,
// a draft is where findings gather before they become one. It had no retraction, so the only way out of a
// duplicate was to submit it and disposition it away, which writes the duplicate into the immutable record
// and into the Review Guidance bank that learns from it. Dropping is confined to the draft: nothing already
// recorded can be reached by it.
function dropHumanFindingDraft(root, options = {}) {
  const { state, projected, findings, index } = draftTarget(root, options, 'drop');
  const [dropped] = findings.splice(index - 1, 1);
  // An empty draft file would keep reporting a draft that holds nothing, which is the orphan shape status
  // already had to learn to explain. Removing it means "no draft" and "a draft of nothing" stay the same
  // state rather than two.
  if (findings.length === 0) fs.rmSync(humanDraftFile(state.worktree, state.work_id, projected.id), { force: true });
  else writeDraft(state, projected, findings);
  return { sliceId: projected.id, dropped, findings };
}

// Rewording a drafted claim. The draft was mutable for its pass condition and nothing else, so a claim that
// ran past the bound — or simply came out wrong — could only be dropped and retyped from memory, which is
// how the same anchor came to be drafted three times live. The claim also travels into scenario and impact
// when those were defaulted from it, or a reworded finding would record the old wording twice.
function amendHumanFinding(root, options = {}) {
  const { state, projected, findings, index } = draftTarget(root, options, 'reword');
  const previous = findings[index - 1];
  const claim = humanClaim(options.claim);
  findings[index - 1] = {
    ...previous,
    claim,
    scenario: previous.scenario === previous.claim ? claim : previous.scenario,
    impact: previous.impact === previous.claim ? claim : previous.impact,
  };
  writeDraft(state, projected, findings);
  return { sliceId: projected.id, index, findings };
}

// Stating a pass condition on a draft in place. Optional now — an unstated one is absent rather than an echo
// of the claim — so this is the gesture for the finding whose done-ness is worth naming separately, not a
// gate every finding has to walk through.
function setHumanFindingPassCondition(root, options = {}) {
  const { state, projected, findings, index } = draftTarget(root, options, 'give a pass condition');
  const passCondition = humanPassCondition(options.passCondition);
  if (!passCondition) throw new Error('a pass condition must name the observable state that makes the finding addressed');
  findings[index - 1].pass_condition = passCondition;
  writeDraft(state, projected, findings);
  return { sliceId: projected.id, index, findings };
}

function submitHumanFindings(root, options = {}) {
  const state = currentState(root, options.workId || null);
  const context = workContext(root, state);
  const projected = selectedSlice(state, context, options);
  const findings = listHumanFindingDraft(state.worktree, state.work_id, projected.id);
  if (findings.length === 0) throw new Error(`Review Slice ${projected.id} has no drafted finding to submit`);
  const recorded = recordReviewOutcome(state.worktree, {
    workId: state.work_id,
    sliceId: projected.id,
    baseCommit: projected.base_commit,
    checkpointCommit: projected.checkpoint_commit,
    review: { verdict: 'findings', findings },
    runtime: 'human',
    human: true,
  });
  fs.rmSync(humanDraftFile(state.worktree, state.work_id, projected.id), { force: true });
  projected.review_outcome_id = recorded.outcome.review_outcome_id;
  // Adjudication asks "is this claim real?" — a question only a model finding has open. The human wrote
  // these, read them back in the draft, and chose to submit; asking them to answer it again, once per
  // finding and with a reason, is the reducer second-guessing a verdict it was just handed, which
  // acceptHumanReview already refuses to do for an override. So submission records the verdict it is.
  // The feedback rows are real, not skipped: the acceptance gate and the Review Guidance bank both read
  // dispositions, and an outcome with none would wedge the slice at awaiting-feedback with no gesture
  // left that could clear it.
  for (const finding of recorded.outcome.findings) {
    recordReviewFeedback(root, {
      workId: state.work_id,
      findingId: finding.finding_id,
      disposition: 'valid',
      reason: 'raised by the human reviewing this checkpoint, so submission is the verdict',
    });
  }
  projectAdjudication(root, state, projected);
  return recorded;
}

function unblockWork(root, options = {}) {
  const state = currentState(root, options.workId || null);
  const context = workContext(root, state);
  if (state.lifecycle !== 'blocked') throw new Error(`Pair Work ${state.work_id} is ${state.lifecycle}, not blocked`);
  const blocked = state.slices.find(item => item.status === 'blocked');
  recordHumanOverride(root, state, blocked || null, 'unblock', options.reason);
  if (blockedOnDirtyWorktree(state)) {
    const status = worktreeStatus(state.worktree);
    if (status.trim()) state.dirty_worktree_waiver = { review_slice_id: blocked?.id || null, digest: digest(status) };
  }
  state.blocked_reason = null;
  state.blocked_precondition = null;
  state.lifecycle = 'ready';
  if (blocked) {
    // Mirrors clearedDirtyWorktreeBlock: the slice resumes where the block interrupted it. A slice that
    // already carries review or verification evidence resumes as correction-ready, so a human-granted
    // retry dispatches as a bounded correction instead of an uncounted fresh implementation.
    blocked.status = blocked.blocked_from && blocked.blocked_from !== 'blocked'
      ? blocked.blocked_from
      : blocked.review_outcome_id || blocked.verification_failure
        ? 'correction-ready'
        : blocked.design_check_blob ? 'design-ready' : 'queued';
    delete blocked.blocked_from;
  }
  const next = activeSlice(state, context)?.projected || nextQueuedSlice(state, context.manifest);
  state.next_action = next ? `run Review Slice ${next.id}` : 'run cumulative deterministic verification';
  return saveState(root, state);
}

function removeWorktree(root, options = {}) {
  const state = currentState(root, options.workId || null);
  if (!['complete', 'blocked'].includes(state.lifecycle) && options.allowIncomplete !== true) {
    throw new Error('Pair worktree removal requires complete/blocked Work or explicit allowIncomplete');
  }
  return removePairWorktree(root, { workId: state.work_id, destination: state.worktree });
}

module.exports = {
  DIRTY_WORKTREE_PRECONDITION,
  REVIEW_OUTPUT_LIMIT_BYTES,
  SLICE_OUTPUT_LIMIT_BYTES,
  STEER_TEXT_LIMIT_BYTES,
  checkpointDiff,
  dispatchCorrectionOnSubmit,
  sliceAttemptPrompt,
  steerWarmSession,
  acceptHumanReview,
  activeSlice,
  adjudicateFinding,
  advanceWork,
  amendHumanFinding,
  applyWarningBaseline,
  correctionBrief,
  correctionShape,
  currentState,
  dropHumanFindingDraft,
  failingTestIdentities,
  forgetKnownFailure,
  humanFindingDrafts,
  knownFailures,
  openWork,
  recordCorrectionDirection,
  listHumanFindingDraft,
  recordHumanFinding,
  recordKnownFailure,
  recordKnownWarnings,
  reconcileAdjudication,
  removeWorktree,
  setHumanFindingPassCondition,
  unblockWork,
  sliceEvidence,
  submitHumanFindings,
  validateFailureProof,
  verificationCommand,
  verifyActiveSlice,
  validateSliceResult,
  warningIdentities,
  workContext,
};
