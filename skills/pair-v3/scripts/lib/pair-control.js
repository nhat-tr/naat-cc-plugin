const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { planContractDigest, parsePlan, validatePlan } = require('./pair-core');
const { appendPairEvent, loadPairState, pairStatePaths } = require('./pair-state');
const {
  createResumeCheckpoint,
  serializeResumeCheckpoint,
} = require('./resume-checkpoint');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function changedPaths(root) {
  const tracked = childProcess.spawnSync('git', ['diff', '--name-only', 'HEAD', '--'], {
    cwd: root,
    encoding: 'utf8',
  });
  const untracked = childProcess.spawnSync('git', ['ls-files', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
  });
  return [...new Set([
    ...(tracked.status === 0 ? tracked.stdout.split(/\r?\n/u).filter(Boolean) : []),
    ...(untracked.status === 0 ? untracked.stdout.split(/\r?\n/u).filter(Boolean) : []),
  ])].sort();
}

function patchDigest(root) {
  const files = changedPaths(root);
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    hash.update(`${file}\0`);
    try {
      const stat = fs.lstatSync(path.join(root, file));
      if (stat.isFile()) hash.update(fs.readFileSync(path.join(root, file)));
      else if (stat.isSymbolicLink()) hash.update(fs.readlinkSync(path.join(root, file)));
    } catch {
      hash.update('[deleted]');
    }
    hash.update('\0');
  }
  return { digest: hash.digest('hex'), files };
}

function recordPauseCheckpoint(root, state, resumeTarget) {
  const planPath = path.join(root, '.pair', 'plan.md');
  const plan = fs.existsSync(planPath) ? fs.readFileSync(planPath, 'utf8') : null;
  const checkpointWorkId = state.work_id
    || (plan ? `plan-${planContractDigest(plan).slice(0, 16)}` : `unbound-${sha256(path.resolve(root)).slice(0, 16)}`);
  const attemptId = state.active?.attempt_id || null;
  const completePatchPath = attemptId
    ? path.join(pairStatePaths(root).attempts, attemptId, 'complete.patch')
    : null;
  const completePatch = completePatchPath && fs.existsSync(completePatchPath)
    ? fs.readFileSync(completePatchPath)
    : null;
  const task = plan && state.active?.task_id
    ? parsePlan(plan).tasks.find(candidate => candidate.id === state.active.task_id)
    : null;
  const checkpoint = createResumeCheckpoint({
    workId: checkpointWorkId,
    runtime: state.continuation.owner_runtime || state.active?.runtime || state.review_session?.runtime || 'unknown',
    role: 'coordinator',
    phase: resumeTarget,
    sessionId: state.continuation.owner_session_id || state.active?.session_id || 'unclaimed',
    attemptId,
    taskId: state.active?.task_id || null,
    plan: plan
      ? { path: '.pair/plan.md', sha256: planContractDigest(plan) }
      : null,
    patch: completePatch
      ? {
          path: path.relative(root, completePatchPath).split(path.sep).join('/'),
          sha256: sha256(completePatch),
        }
      : null,
    resumeTarget,
    nextAction: attemptId
      ? `Resume attempt ${attemptId} at the exact saved ${resumeTarget} phase using repository-local status and evidence.`
      : `Resume Work ${checkpointWorkId} at the exact saved ${resumeTarget} phase using repository-local status and evidence.`,
    acceptanceCriteria: task?.acceptanceCriteria || [],
    findingIds: [],
  });
  appendPairEvent(root, {
    event: 'pause.checkpointed',
    workId: state.work_id,
    attemptId,
    phase: resumeTarget,
    resume_target: resumeTarget,
    checkpoint,
    checkpoint_bytes: Buffer.byteLength(serializeResumeCheckpoint(checkpoint), 'utf8'),
  });
  return checkpoint;
}

function pauseWork(root) {
  const state = loadPairState(root);
  const resumeTarget = state.active?.phase || state.continuation.resume_target || state.lifecycle;
  recordPauseCheckpoint(root, state, resumeTarget);
  appendPairEvent(root, {
    event: 'pause.requested',
    workId: state.work_id,
    attemptId: state.active?.attempt_id || null,
    phase: resumeTarget,
  });
  if (state.in_flight_request?.request_pid) {
    return loadPairState(root);
  }
  appendPairEvent(root, {
    event: 'work.paused',
    workId: state.work_id,
    attemptId: state.active?.attempt_id || null,
    resume_target: resumeTarget,
  });
  return loadPairState(root);
}

function resumeWork(root, sessionId = null, runtime = null) {
  const state = loadPairState(root);
  if (state.continuation.human_edit) {
    throw new Error('human edit is active; end it before resuming Pair');
  }
  if (!state.continuation.paused) throw new Error('Work is not paused');
  if (sessionId) takeoverWork(root, sessionId, runtime);
  appendPairEvent(root, {
    event: 'work.resumed',
    workId: state.work_id,
    attemptId: state.active?.attempt_id || null,
    resume_target: state.continuation.resume_target || state.active?.phase || 'ready',
    dispatch_reason: 'explicit-resume-to-saved-phase',
  });
  return loadPairState(root);
}

function takeoverWork(root, sessionId, runtime = null, options = {}) {
  if (!String(sessionId || '').trim()) throw new Error('takeover requires a session ID');
  const state = loadPairState(root);
  if (
    Object.prototype.hasOwnProperty.call(options, 'expectedWorkId') &&
    state.work_id !== options.expectedWorkId
  ) throw new Error('Pair Work changed before continuation ownership transfer');
  if (
    state.continuation.owner_session_id === String(sessionId) &&
    (runtime === null || state.continuation.owner_runtime === runtime)
  ) return state;
  appendPairEvent(root, {
    event: 'continuation.claimed',
    workId: Object.prototype.hasOwnProperty.call(options, 'expectedWorkId')
      ? options.expectedWorkId
      : state.work_id,
    attemptId: state.active?.attempt_id || null,
    session_id: String(sessionId),
    runtime: runtime || null,
  });
  return loadPairState(root);
}

function cancelInFlight(root) {
  const state = loadPairState(root);
  const request = state.in_flight_request || state.active;
  const pid = request?.request_pid;
  const requestId = request?.request_id || null;
  if (!Number.isInteger(pid) || pid <= 0) {
    appendPairEvent(root, {
      event: 'warning.recorded',
      workId: state.work_id,
      attemptId: state.active?.attempt_id || null,
      code: 'cancel-no-in-flight-request',
      detail: 'Cancel now found no tracked in-flight request; the saved phase is unchanged',
    });
    return { cancelled: false, state: loadPairState(root) };
  }
  try {
    if (process.platform !== 'win32') process.kill(-pid, 'SIGTERM');
    else process.kill(pid, 'SIGTERM');
  } catch (error) {
    if (error.code !== 'ESRCH') {
      try {
        process.kill(pid, 'SIGTERM');
      } catch (fallbackError) {
        if (fallbackError.code !== 'ESRCH') throw fallbackError;
      }
    }
  }
  appendPairEvent(root, {
    event: 'request.cancelled',
    workId: state.work_id,
    attemptId: state.active?.attempt_id || null,
    phase: request?.phase || state.active?.phase || state.continuation.resume_target,
    request_pid: pid,
    request_id: requestId,
    resume_target: request?.phase || state.active?.phase || state.continuation.resume_target,
  });
  return { cancelled: true, pid, state: loadPairState(root) };
}

function beginHumanEdit(root, kind) {
  if (!['plan', 'code'].includes(kind)) throw new Error('human edit kind must be plan or code');
  const state = loadPairState(root);
  if (!state.continuation.paused) throw new Error('pause Work before beginning a human edit');
  if (state.continuation.human_edit) throw new Error(`human edit ${state.continuation.human_edit.kind} is already active`);
  const planPath = path.join(root, '.pair', 'plan.md');
  const plan = fs.existsSync(planPath) ? fs.readFileSync(planPath, 'utf8') : '';
  const patch = patchDigest(root);
  appendPairEvent(root, {
    event: 'human-edit.started',
    workId: state.work_id,
    attemptId: state.active?.attempt_id || null,
    kind,
    base_plan_digest: plan ? planContractDigest(plan) : null,
    base_plan_bytes_digest: plan ? sha256(plan) : null,
    base_patch_digest: patch.digest,
    base_changed_paths: patch.files,
    resume_target: state.continuation.resume_target || state.active?.phase || 'ready',
  });
  return loadPairState(root);
}

function endHumanEdit(root) {
  const state = loadPairState(root);
  const edit = state.continuation.human_edit;
  if (!edit) throw new Error('no human edit is active');
  let semanticChange = false;
  let affectedPaths = [];
  if (edit.kind === 'plan') {
    const planPath = path.join(root, '.pair', 'plan.md');
    if (!fs.existsSync(planPath)) throw new Error('.pair/plan.md is missing');
    const plan = fs.readFileSync(planPath, 'utf8');
    const validation = validatePlan(plan);
    if (!validation.valid) throw new Error(`plan validation failed: ${validation.errors.join('; ')}`);
    const digest = planContractDigest(plan);
    semanticChange = digest !== edit.base_plan_digest;
    if (semanticChange) {
      appendPairEvent(root, {
        event: 'plan.approval-invalidated',
        workId: state.work_id,
        prior_plan_digest: edit.base_plan_digest,
        planDigest: digest,
        cause: 'human-semantic-edit',
      });
    }
  } else {
    const patch = patchDigest(root);
    affectedPaths = [...new Set([...(edit.base_changed_paths || []), ...patch.files])].sort();
    appendPairEvent(root, {
      event: 'evidence.staled',
      workId: state.work_id,
      attemptId: state.active?.attempt_id || null,
      paths: affectedPaths,
      patch_digest: patch.digest,
      resume_target: 'verifying',
    });
  }
  appendPairEvent(root, {
    event: 'human-edit.completed',
    workId: state.work_id,
    attemptId: state.active?.attempt_id || null,
    kind: edit.kind,
    semantic_change: semanticChange,
    affected_paths: affectedPaths,
    resume_target: edit.kind === 'code' ? 'verifying' : state.continuation.resume_target,
  });
  return loadPairState(root);
}

module.exports = {
  beginHumanEdit,
  cancelInFlight,
  changedPaths,
  endHumanEdit,
  patchDigest,
  pauseWork,
  recordPauseCheckpoint,
  resumeWork,
  takeoverWork,
};
