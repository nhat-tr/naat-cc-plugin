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
  git,
  readCurrentWork,
  readJson,
  readState,
  safeSegment,
  storeBlob,
  storeJsonBlob,
  updatePairRef,
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

function now() {
  return new Date().toISOString();
}

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
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
    return `Implement one Architecture-Sensitive Path checkpoint for Review Slice ${slice.id}.\n\nOutcome: ${slice.outcome}\nAcceptance Criteria:\n${mapped}\n\nApproved Design Check for this checkpoint:\n${designCheck}\nRead applicable AGENTS.md and current code at the named seam and callers. Implement the first thin production path through entrypoint, changed boundary, result, and first real usage. Do not expand horizontally, create unused abstractions, copy nearby patterns without matching ownership/lifetime/failure/concurrency, edit Pair files, commit, or run the final verification command. Return completed with the same bounded architecture risk and one risk-appropriate Failure Proof. Pair runs exact verification after handoff.`;
  }
  return `Implement one bounded Review Slice ${slice.id}.\n\nOutcome: ${slice.outcome}\nAcceptance Criteria:\n${mapped}\n\nRead applicable AGENTS.md plus only current code, callers, contracts, and tests needed for this outcome. Before editing, look for a changed or unknown runtime responsibility: owner/lifetime/state, public or data contract, request middleware ordering, remote/distributed boundary, event ordering/idempotency, background-job shutdown, concurrency/transactions/retries, security, replica/load-balancer behavior, deployment topology, or React state ownership. If one exists or remains unknown, do not edit: return design-required with one risk sentence and the compact Design Check. Otherwise return architecture_risk null and implement direct readable code on the Routine Path. Existing code is evidence, not authority. Do not edit Pair files, commit, or run final verification. Return one risk-appropriate Failure Proof; Pair runs exact verification after handoff.`;
}

function correctionPrompt(context, slice, projected, state) {
  const mapped = criteriaText(context, slice);
  const findings = projected.review_outcome_id
    ? listReviewOutcomes(state.worktree, state.work_id)
        .find(item => item.review_outcome_id === projected.review_outcome_id)?.findings
        .filter(item => feedbackForFinding(state.worktree, state.work_id, item.finding_id).some(feedback => feedback.disposition === 'valid')) || []
    : [];
  const deterministic = projected.verification_failure
    ? [{ claim: 'Declared verification failed.', scenario: projected.verification_failure, pass_condition: `Command succeeds: ${slice.verify}` }]
    : [];
  return `Correct Review Slice ${slice.id} once.\n\nOutcome: ${slice.outcome}\nAcceptance Criteria:\n${mapped}\n\nHuman-valid or deterministic evidence:\n${JSON.stringify([...findings, ...deterministic])}\n\nInspect current checkpoint and exact evidence. Make only the bounded correction that satisfies each pass condition. Do not broaden design, edit Pair files, commit, or run final verification. Return completed with the bounded architecture risk and Failure Proof. This is the only automatic correction; another failure pauses for human control.`;
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
  const run = runProvider({
    runtime,
    mode,
    root: state.worktree,
    prompt,
    schemaPath,
    schema,
    outputPath,
    model: options.model || 'default',
    effort: options.effort || 'medium',
    maxOutputBytes: reviewSchema ? REVIEW_OUTPUT_LIMIT_BYTES : SLICE_OUTPUT_LIMIT_BYTES,
  });
  fs.rmSync(outputPath, { force: true });
  recordInvocation(root, state, sliceId, kind, run);
  return run;
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
    diagnostic: result.error ? String(result.error.message).slice(0, 500) : String(result.stderr || '').trim().slice(-500),
  };
}

function verify(root, state, slice, dependencies) {
  const hydrate = dependencies.hydrate || ((input) => hydrateWorktree(root, input));
  hydrate({ workId: state.work_id, worktree: state.worktree, submodules: [] });
  const execute = dependencies.verify || ((input) => verificationCommand(input.command, input.cwd));
  const result = execute({ command: slice.verify, cwd: state.worktree, workId: state.work_id, sliceId: slice.id });
  appendEvent(root, state.work_id, {
    event: 'verification-finished',
    review_slice_id: slice.id,
    command_digest: digest(slice.verify),
    status: result.status,
    duration_ms: result.duration_ms || 0,
    log_digest: result.log_digest || null,
  });
  return result;
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
  const keep = new Set(['id', 'status', 'base_commit', 'checkpoint_commit', 'route', 'correction_count']);
  for (const key of Object.keys(projected)) {
    if (!keep.has(key)) delete projected[key];
  }
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
    const result = (dependencies.verify || ((input) => verificationCommand(input.command, input.cwd)))({
      command,
      cwd: state.worktree,
      workId: state.work_id,
      sliceId: 'completion',
    });
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
  return `Review one immutable checkpoint. Do not edit. Approval must be {"verdict":"approve","findings":[]} with no narrative. Return at most three BLOCKER/MAJOR findings; omit style, preferences, optional hardening, speculative edges, and unsupported architecture claims. Every finding requires a falsifiable claim, reachable scenario, impact, pass condition, and exact checkpoint commit/path/blob/line anchor.\n\nReview Slice: ${slice.id}\nOutcome: ${slice.outcome}\nAcceptance Criteria:\n${criteriaText(context, slice)}\nBase: ${projected.base_commit}\nCheckpoint: ${projected.checkpoint_commit}\nVerification: ${JSON.stringify(verification)}\nDesign Check:\n${design || 'not applicable'}\nArchitecture risk: ${projected.architecture_risk || 'none declared or detected'}${guidanceText}\n\nStart with git diff ${projected.base_commit}..${projected.checkpoint_commit}. Inspect only changed files, named Design Check callers, and exact contracts needed to test reachable behavior. Existing patterns are evidence only; judge responsibility, ownership, lifetime, state, failure ownership, concurrency, contract compatibility, middleware/event ordering, and replica behavior against this change.`;
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
  projected.verification = {
    status: verification.status,
    duration_ms: verification.duration_ms || 0,
    command_digest: digest(slice.verify),
    log_digest: verification.log_digest || null,
  };
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
  const committed = commitCheckpoint(state, slice, projected);
  const checkpointRisks = inspectCheckpointRisks(state.worktree, projected.base_commit, committed.checkpoint);
  const route = determinePath({
    declaredRisk: output.architecture_risk,
    checkpointRisks: checkpointRisks.risks,
  });
  projected.route = route.path;
  projected.architecture_risk = route.risk;
  delete projected.verification_failure;
  appendEvent(root, state.work_id, {
    event: 'checkpoint-created',
    review_slice_id: slice.id,
    base_commit: projected.base_commit,
    checkpoint_commit: projected.checkpoint_commit,
    route: projected.route,
    architecture_risk: projected.architecture_risk,
    changed_path_count: committed.paths.length,
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

function runSliceImplementation(root, state, context, slice, projected, options, dependencies) {
  const correction = projected.status === 'correction-ready';
  if (!correction && worktreeStatus(state.worktree).trim()) {
    projected.status = 'blocked';
    state.lifecycle = 'blocked';
    state.blocked_reason = `Pair worktree is dirty before Review Slice ${slice.id}`;
    state.next_action = 'inspect preserved worktree changes';
    return saveState(root, state);
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
    if (worktreeStatus(state.worktree).trim()) {
      projected.status = 'blocked';
      state.lifecycle = 'blocked';
      state.blocked_reason = `provider edited code before Design Check for ${slice.id}`;
      state.next_action = 'inspect preserved worktree changes';
      return saveState(root, state);
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

function advanceWork(root, options = {}, dependencies = {}) {
  const state = currentState(root, options.workId || null);
  const context = workContext(root, state);
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

function acceptHumanReview(root, options = {}, dependencies = {}) {
  const state = currentState(root, options.workId || null);
  const context = workContext(root, state);
  const projected = state.slices.find(item => item.id === options.sliceId);
  if (!projected || projected.status !== 'awaiting-human-review') throw new Error('Review Slice is not awaiting human acceptance');
  const outcome = projected.review_outcome_id
    ? listReviewOutcomes(root, state.work_id).find(item => item.review_outcome_id === projected.review_outcome_id)
    : null;
  if (outcome) {
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
  const outcome = listReviewOutcomes(root, state.work_id).find(item => item.review_outcome_id === projected.review_outcome_id);
  const allAdjudicated = outcome.findings.every(finding => feedbackForFinding(root, state.work_id, finding.finding_id).length > 0);
  if (!allAdjudicated) return saveState(root, state);
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

function removeWorktree(root, options = {}) {
  const state = currentState(root, options.workId || null);
  if (!['complete', 'blocked'].includes(state.lifecycle) && options.allowIncomplete !== true) {
    throw new Error('Pair worktree removal requires complete/blocked Work or explicit allowIncomplete');
  }
  return removePairWorktree(root, { workId: state.work_id, destination: state.worktree });
}

module.exports = {
  REVIEW_OUTPUT_LIMIT_BYTES,
  SLICE_OUTPUT_LIMIT_BYTES,
  acceptHumanReview,
  adjudicateFinding,
  advanceWork,
  currentState,
  openWork,
  removeWorktree,
  validateFailureProof,
  validateSliceResult,
};
