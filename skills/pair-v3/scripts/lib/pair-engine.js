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
const { runFreshProvider } = require('./provider-runtime');
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
// This session's Bash tool is sandboxed independently of the parent that spawned it, and the sandbox
// denies the socket bind MSBuild's parallel worker nodes need. A parallel build then stalls for
// minutes and reports "Build FAILED" with 0 errors, leaving the session iterating with no diagnostics.
const SANDBOXED_BUILD_NOTE = ' If this repository builds with MSBuild, pass `-m:1` to every `dotnet build` and `dotnet test`; without it a sandboxed build stalls for minutes and then reports `Build FAILED` with 0 errors instead of the real compiler output.';

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

function invocationSummary(kind, sliceId, run) {
  return {
    kind,
    review_slice_id: sliceId,
    runtime: run.runtime,
    model: run.model,
    effort: run.effort,
    input_tokens: run.usage?.input_tokens || 0,
    cached_input_tokens: run.usage?.cached_input_tokens || 0,
    output_tokens: run.usage?.output_tokens || 0,
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
    slices: loaded.manifest.slices.map(initialSliceState),
    invocation_totals: { calls: 0, input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, duration_ms: 0 },
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

function implementationPrompt(context, slice, projected) {
  const mapped = criteriaText(context, slice);
  if (projected.status === 'design-ready') {
    const designCheck = fs.readFileSync(path.join(context.paths.designChecks, `${slice.id}.md`), 'utf8');
    return `Implement one Architecture-Sensitive Path checkpoint for Review Slice ${slice.id}.\n\nOutcome: ${slice.outcome}\nAcceptance Criteria:\n${mapped}\n\nApproved Design Check for this checkpoint:\n${designCheck}\nRead applicable AGENTS.md and current code at the named seam and callers. Implement the first thin production path through entrypoint, changed boundary, result, and first real usage. Do not expand horizontally, create unused abstractions, copy nearby patterns without matching ownership/lifetime/failure/concurrency, edit Pair files, commit, or run the final verification command. Return completed with the same bounded architecture risk and one risk-appropriate Failure Proof. Pair runs exact verification after handoff.${SANDBOXED_BUILD_NOTE}`;
  }
  return `Implement one bounded Review Slice ${slice.id}.\n\nOutcome: ${slice.outcome}\nAcceptance Criteria:\n${mapped}\n\nRead applicable AGENTS.md plus only current code, callers, contracts, and tests needed for this outcome. Before editing, look for a changed or unknown runtime responsibility: owner/lifetime/state, public or data contract, request middleware ordering, remote/distributed boundary, event ordering/idempotency, background-job shutdown, concurrency/transactions/retries, security, replica/load-balancer behavior, deployment topology, or React state ownership. If one exists or remains unknown, do not edit: return design-required with one risk sentence and the compact Design Check. Otherwise return architecture_risk null and implement direct readable code on the Routine Path. Existing code is evidence, not authority. Do not edit Pair files, commit, or run final verification. Return one risk-appropriate Failure Proof; Pair runs exact verification after handoff.${SANDBOXED_BUILD_NOTE}`;
}

function correctionPrompt(context, slice, projected, state) {
  const mapped = criteriaText(context, slice);
  // The disposition reason is why a human called this finding valid, and it is the most specific
  // steering that exists for that finding. Dropping it forced every human note through the single
  // 1000-character Correction Direction, or through hand-edits when it would not fit. It travels
  // attached to the finding it adjudicates, so it can never be read as evidence of its own.
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
  // Kept out of the evidence array: a Correction Direction is human intent, not a falsifiable finding,
  // and conflating the two would let it be read as evidence the checkpoint already contradicts.
  const direction = projected.correction_direction
    ? `\n\nCorrection Direction (bounded, human-authored, binding for this correction):\n${projected.correction_direction}`
    : '';
  return `Correct Review Slice ${slice.id} once.\n\nOutcome: ${slice.outcome}\nAcceptance Criteria:\n${mapped}\n\nHuman-valid or deterministic evidence:\n${JSON.stringify([...findings, ...deterministic])}${direction}\n\nInspect current checkpoint and exact evidence. Make only the bounded correction that satisfies each pass condition. Do not broaden design, edit Pair files, commit, or run final verification. Return completed with the bounded architecture risk and Failure Proof. This is the only automatic correction; another failure pauses for human control.${SANDBOXED_BUILD_NOTE}`;
}

function postDiffDesignPrompt(context, slice, projected) {
  return `Inspect immutable checkpoint ${projected.checkpoint_commit} for Review Slice ${slice.id}. Do not edit.\nOutcome: ${slice.outcome}\nAcceptance Criteria:\n${criteriaText(context, slice)}\nRun git diff ${projected.base_commit}..${projected.checkpoint_commit} and inspect changed seams plus exact callers. Return design-required with one bounded architecture risk and the compact Design Check grounded in actual code. Use failure_proof null and blocker null.`;
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

function recordInvocation(root, state, sliceId, kind, run) {
  const summary = invocationSummary(kind, sliceId, run);
  const totals = state.invocation_totals || { calls: 0, input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, duration_ms: 0 };
  state.invocation_totals = {
    calls: totals.calls + 1,
    input_tokens: totals.input_tokens + summary.input_tokens,
    cached_input_tokens: totals.cached_input_tokens + summary.cached_input_tokens,
    output_tokens: totals.output_tokens + summary.output_tokens,
    duration_ms: totals.duration_ms + summary.duration_ms,
  };
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

function providerCall(root, state, sliceId, kind, prompt, options, dependencies, mode = 'implementation', reviewSchema = false) {
  const runtime = options.runtime && options.runtime !== 'auto'
    ? options.runtime
    : resolveRuntime('auto', { env: dependencies.env || process.env, available: dependencies.availableRuntimes });
  const scratch = defaultScratchDirectory(root, state.work_id);
  fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const outputPath = path.join(scratch, `${sliceId}-${kind}-${crypto.randomUUID()}.json`);
  const schemaPath = reviewSchema ? REVIEW_SCHEMA_PATH : SLICE_SCHEMA_PATH;
  const schema = readJson(schemaPath);
  const runProvider = dependencies.runProvider || runFreshProvider;
  let run;
  try {
    run = runProvider({
      runtime,
      mode,
      root: state.worktree,
      prompt,
      schemaPath,
      schema,
      outputPath,
      model: resolvedModel(options, state),
      effort: options.effort || 'medium',
      maxOutputBytes: reviewSchema ? REVIEW_OUTPUT_LIMIT_BYTES : SLICE_OUTPUT_LIMIT_BYTES,
      streamLog: streamLogPath(dependencies.env || process.env, state.work_id, sliceId, kind),
    });
  } catch (error) {
    fs.rmSync(outputPath, { force: true });
    recordFailedInvocation(root, state, sliceId, kind, error, runtime);
    throw error;
  }
  fs.rmSync(outputPath, { force: true });
  recordInvocation(root, state, sliceId, kind, run);
  return run;
}

// A failed provider call used to leave nothing at all: recordInvocation runs after runProvider returns, so
// an exception skipped both the journal entry and the token totals. Observed live — an S-05 review spent
// 6m35s, 27 turns and 25,969 output tokens, exhausted its structured-output retries, and the Work's record
// showed the review had never been attempted. Cost that real cannot be invisible, and a phase that fails
// repeatedly must be countable. The failure is recorded and then re-thrown: the loop still refuses to
// advance, which was always correct.
function recordFailedInvocation(root, state, sliceId, kind, error, runtime) {
  const telemetry = error?.pair_invocation || {};
  const usage = telemetry.usage || {};
  const summary = {
    review_slice_id: sliceId,
    kind,
    runtime: telemetry.runtime || runtime,
    input_tokens: usage.input_tokens || 0,
    cached_input_tokens: usage.cached_input_tokens || 0,
    output_tokens: usage.output_tokens || 0,
    duration_ms: telemetry.duration_ms || 0,
    failure: telemetry.failure || null,
    // Bounded, and already redacted by the runtime: the reason is a diagnosis, not transcript content.
    error: String(error?.message || 'unknown provider failure').slice(0, 500),
  };
  const totals = state.invocation_totals || { calls: 0, input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, duration_ms: 0 };
  state.invocation_totals = {
    calls: totals.calls + 1,
    input_tokens: totals.input_tokens + summary.input_tokens,
    cached_input_tokens: totals.cached_input_tokens + summary.cached_input_tokens,
    output_tokens: totals.output_tokens + summary.output_tokens,
    duration_ms: totals.duration_ms + summary.duration_ms,
  };
  state.recent_invocations = [...(state.recent_invocations || []), { ...summary, failed: true }].slice(-3);
  appendEvent(root, state.work_id, { event: 'provider-failed', ...summary });
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
  return {
    status: result.error ? null : result.status,
    duration_ms: Date.now() - started,
    log_digest: digest(output),
    diagnostic: result.error ? String(result.error.message).slice(0, 500) : verificationDiagnostic(result),
    failing_tests: failingTestIdentities(output),
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

function failingTestIdentities(output) {
  const identities = new Set();
  for (const raw of String(output).replaceAll(ANSI_ESCAPE, '').split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line) continue;
    for (const pattern of FAILING_TEST_PATTERNS) {
      const id = line.match(pattern)?.groups?.id?.trim();
      if (id) { identities.add(id.slice(0, FAILING_TEST_IDENTITY_LIMIT)); break; }
    }
  }
  return [...identities].sort();
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
  const result = applyKnownFailureBaseline(root, state.work_id, raw);
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

function acceptSlice(root, state, context, projected) {
  markCompositionRisk(state, projected);
  projected.status = 'accepted';
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

function reviewPrompt(context, slice, projected, verification, guidance) {
  const design = projected.design_check_ref ? fs.readFileSync(path.join(context.paths.designChecks, `${slice.id}.md`), 'utf8').trim() : null;
  const guidanceText = guidance.length > 0 ? `\nApplicable approved Review Guidance:\n${guidance.map(item => `- ${item.rule}`).join('\n')}` : '';
  return `Review one immutable checkpoint. Do not edit. Approval must be {"verdict":"approve","findings":[]} with no narrative. Return at most three BLOCKER/MAJOR findings; omit style, preferences, optional hardening, speculative edges, and unsupported architecture claims. Every finding requires a falsifiable claim, reachable scenario, impact, pass condition, and exact checkpoint commit/path/blob/line anchor.\n\nReview Slice: ${slice.id}\nOutcome: ${slice.outcome}\nAcceptance Criteria:\n${criteriaText(context, slice)}\nBase: ${projected.base_commit}\nCheckpoint: ${projected.checkpoint_commit}\nVerification: ${JSON.stringify(verification)}\nDesign Check:\n${design || 'not applicable'}\nArchitecture risk: ${projected.architecture_risk || 'none declared or detected'}${guidanceText}\n\nStart with git diff ${projected.base_commit}..${projected.checkpoint_commit}. Inspect only changed files, named Design Check callers, and exact contracts needed to test reachable behavior. Existing patterns are evidence only; judge responsibility, ownership, lifetime, state, failure ownership, concurrency, contract compatibility, middleware/event ordering, and replica behavior against this change.${SANDBOXED_BUILD_NOTE}`;
}

function runCheckpointReview(root, state, context, slice, projected, options, dependencies) {
  const guidance = activeReviewGuidance(root, state.work_id, [projected.route]);
  const run = providerCall(root, state, slice.id, 'review', reviewPrompt(context, slice, projected, projected.verification, guidance), options, dependencies, 'review', true);
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
  if (!correction && unwaivedDirtyWorktree(state)) {
    return blockOnDirtyWorktree(root, state, projected, `Pair worktree is dirty before Review Slice ${slice.id}`);
  }
  if (!projected.base_commit) projected.base_commit = git(state.worktree, ['rev-parse', 'HEAD']).stdout;
  const headBefore = git(state.worktree, ['rev-parse', 'HEAD']).stdout;
  const prompt = correction ? correctionPrompt(context, slice, projected, state) : implementationPrompt(context, slice, projected);
  const run = providerCall(root, state, slice.id, correction ? 'correction' : 'implementation', prompt, options, dependencies);
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
  const run = providerCall(root, state, slice.id, 'post-diff-design', postDiffDesignPrompt(context, slice, projected), options, dependencies, 'review');
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
  const run = providerCall(root, state, synthetic.id, 'combined-review', reviewPrompt(context, synthetic, projected, projected.verification, []), options, dependencies, 'review', true);
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

function advanceHeldWork(root, options = {}, dependencies = {}) {
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
  if (valid && projected.correction_count >= 1) {
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
  return {
    work_id: state.work_id,
    review_slice_id: projected.id,
    correction_direction: projected.correction_direction || null,
    prompt: correctionPrompt(context, manifestSlice(context, projected.id), projected, state),
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

function listHumanFindingDraft(root, workId, sliceId) {
  return readJson(humanDraftFile(root, workId, sliceId))?.findings || [];
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
        findings,
        unstated_count: findings.filter(finding => !finding.pass_condition).length,
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
  const finding = {
    severity: options.severity || 'MAJOR',
    claim: options.claim,
    scenario: options.scenario || options.claim,
    impact: options.impact || options.claim,
    // Left unstated rather than fabricated: correctionPrompt tells the corrector to satisfy each pass
    // condition and nothing else says when a human finding is done, so a placeholder like "the human who
    // raised this confirms it is addressed" is unfalsifiable by the corrector and unbounds the one
    // bounded correction. Drafting still allows it to be missing — reading produces the claim before the
    // remedy — and submission is where it becomes required.
    pass_condition: humanPassCondition(options.passCondition),
    evidence: {
      commit: projected.checkpoint_commit,
      path: options.file,
      blob: blobAtCommit(state.worktree, projected.checkpoint_commit, options.file),
      line_start: lineStart,
      line_end: lineEnd,
    },
  };
  const file = humanDraftFile(state.worktree, state.work_id, projected.id);
  const findings = [...listHumanFindingDraft(state.worktree, state.work_id, projected.id), finding];
  writeJson(file, { schema: 1, review_slice_id: projected.id, checkpoint_commit: projected.checkpoint_commit, findings });
  return { drafted: finding, findings, file, sliceId: projected.id };
}

// Completing a draft in place: the submission gate below refuses a finding with no pass condition, and a
// refusal whose only escape is to re-draft the finding would leave a duplicate in the outcome. Default
// target is the finding just drafted, because that is the one the human is still looking at.
function setHumanFindingPassCondition(root, options = {}) {
  const state = currentState(root, options.workId || null);
  const context = workContext(root, state);
  const projected = selectedSlice(state, context, options);
  const findings = listHumanFindingDraft(state.worktree, state.work_id, projected.id);
  if (findings.length === 0) throw new Error(`Review Slice ${projected.id} has no drafted finding to give a pass condition`);
  const index = options.index === undefined || options.index === null ? findings.length : Number(options.index);
  if (!Number.isInteger(index) || index < 1 || index > findings.length) {
    throw new Error(`drafted finding ${options.index} is outside 1-${findings.length} for ${projected.id}`);
  }
  const passCondition = humanPassCondition(options.passCondition);
  if (!passCondition) throw new Error('a pass condition must name the observable state that makes the finding addressed');
  findings[index - 1].pass_condition = passCondition;
  writeJson(humanDraftFile(state.worktree, state.work_id, projected.id), {
    schema: 1,
    review_slice_id: projected.id,
    checkpoint_commit: projected.checkpoint_commit,
    findings,
  });
  return { sliceId: projected.id, index, findings };
}

function submitHumanFindings(root, options = {}) {
  const state = currentState(root, options.workId || null);
  const context = workContext(root, state);
  const projected = selectedSlice(state, context, options);
  const findings = listHumanFindingDraft(state.worktree, state.work_id, projected.id);
  if (findings.length === 0) throw new Error(`Review Slice ${projected.id} has no drafted finding to submit`);
  // A draft may be half-written; a Review Outcome may not. This is the seam where a human finding gains
  // the force to steer a correction, so it is the seam that requires something falsifiable to satisfy.
  const unstated = findings.filter(finding => !finding.pass_condition);
  if (unstated.length > 0) {
    throw new Error([
      `${unstated.length} of ${findings.length} drafted finding(s) for ${projected.id} state no pass condition, so the correction has nothing falsifiable to satisfy:`,
      ...findings
        .map((finding, index) => ({ finding, position: index + 1 }))
        .filter(item => !item.finding.pass_condition)
        .map(item => `  ${item.position}. ${item.finding.evidence.path}:${item.finding.evidence.line_start}  ${item.finding.claim}`),
      `Name the observable state that makes each one addressed: pair-loop finding --slice ${projected.id} --index <n> --pass-condition "<observable state>"`,
    ].join('\n'));
  }
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
  projected.status = 'awaiting-feedback';
  state.lifecycle = 'awaiting-human';
  state.next_action = `adjudicate ${recorded.outcome.findings.length} finding(s) for ${projected.id}`;
  saveState(root, state);
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
  acceptHumanReview,
  adjudicateFinding,
  advanceWork,
  correctionBrief,
  currentState,
  failingTestIdentities,
  forgetKnownFailure,
  humanFindingDrafts,
  knownFailures,
  openWork,
  recordCorrectionDirection,
  listHumanFindingDraft,
  recordHumanFinding,
  recordKnownFailure,
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
};
