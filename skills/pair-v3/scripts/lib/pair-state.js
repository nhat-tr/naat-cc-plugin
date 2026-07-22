const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const STATE_SCHEMA = 4;
const PRODUCT = 'pair-v4';
const LOCK_WAIT_MS = 5;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_STALE_MS = 30_000;

const OMITTED_KEYS = new Set([
  'prompt',
  'raw_prompt',
  'system_prompt',
  'transcript',
  'private_reasoning',
  'chain_of_thought',
  'environment',
  'env',
  'credentials',
  'credential',
  'capability_token',
  'authorization',
  'cookie',
]);
const SECRET_VALUE_KEY = /^(?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|password|secret|client[-_]?secret|private[-_]?key|authorization|cookie)$/iu;

function safeWorkSegment(workId) {
  const value = String(workId || '').trim();
  if (!value) return null;
  if (/^[A-Za-z0-9._-]+$/u.test(value)) return value;
  return `work-${crypto.createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
}

function currentWorkId(root) {
  return readJson(path.join(root, '.pair', 'current-run.json'))?.work_id || null;
}

function pairStatePaths(root, workId = undefined) {
  const selectedWorkId = workId === undefined ? currentWorkId(root) : workId;
  const segment = safeWorkSegment(selectedWorkId);
  const pairDirectory = path.join(root, '.pair');
  const directory = segment
    ? path.join(pairDirectory, 'runs', segment)
    : pairDirectory;
  return {
    pairDirectory,
    directory,
    workId: selectedWorkId || null,
    current: path.join(pairDirectory, 'current-run.json'),
    events: path.join(directory, 'events.jsonl'),
    state: path.join(directory, 'state.json'),
    status: path.join(directory, 'status.md'),
    attempts: path.join(directory, 'attempts'),
    lock: path.join(directory, '.state.lock'),
  };
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(directory, 0o700);
  } catch {
    // Permission hardening is best-effort on filesystems that do not expose POSIX modes.
  }
}

function redactString(value) {
  return String(value)
    .replace(/\bBearer\s+[^\s,"']+/giu, 'Bearer [REDACTED]')
    .replace(/((?:--?|\b)(?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|password|secret|client[-_]?secret|private[-_]?key)(?:=|\s+))[^\s,"']+/giu, '$1[REDACTED]')
    .replace(/(["']?(?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|password|secret|client[-_]?secret|private[-_]?key|authorization|cookie)["']?\s*[:=]\s*)(["'])([^"'\r\n]+)\2/giu, '$1$2[REDACTED]$2')
    .replace(/(["']?(?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|password|secret|client[-_]?secret|private[-_]?key|authorization|cookie)["']?\s*[:=]\s*)(?!["'])[^\s,;]+/giu, '$1[REDACTED]')
    .replace(/\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)\s*=\s*[^\s,"']+/gu, '[REDACTED]')
    .replace(/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{8,}|gh[oprsu]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[A-Z0-9]{12,})\b/gu, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu, '[REDACTED]');
}

function sanitizeValue(value, key = '') {
  if (OMITTED_KEYS.has(String(key).toLowerCase())) return undefined;
  if (SECRET_VALUE_KEY.test(String(key))) return '[REDACTED]';
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) {
    return value
      .map(item => sanitizeValue(item))
      .filter(item => item !== undefined);
  }
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    const sanitized = sanitizeValue(childValue, childKey);
    if (sanitized !== undefined) result[childKey] = sanitized;
  }
  return result;
}

function sanitizeText(value) {
  return String(value).split(/(?<=\n)/u).map(part => {
    const hasNewline = part.endsWith('\n');
    const line = hasNewline ? part.slice(0, -1) : part;
    if (!line.trim()) return part;
    try {
      const parsed = JSON.parse(line);
      return `${JSON.stringify(sanitizeValue(parsed))}${hasNewline ? '\n' : ''}`;
    } catch {
      return `${redactString(line)}${hasNewline ? '\n' : ''}`;
    }
  }).join('');
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleepSync(milliseconds) {
  const view = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(view, 0, 0, milliseconds);
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function acquireLock(paths, timeoutMs = LOCK_TIMEOUT_MS) {
  ensurePrivateDirectory(paths.directory);
  const started = Date.now();
  const nonce = crypto.randomUUID();
  while (Date.now() - started < timeoutMs) {
    try {
      fs.mkdirSync(paths.lock, { mode: 0o700 });
      fs.writeFileSync(
        path.join(paths.lock, 'owner.json'),
        `${JSON.stringify({ pid: process.pid, nonce, acquired_at: new Date().toISOString() })}\n`,
        { mode: 0o600 },
      );
      return { nonce };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = readJson(path.join(paths.lock, 'owner.json'));
      let age = 0;
      try {
        age = Date.now() - fs.statSync(paths.lock).mtimeMs;
      } catch {
        continue;
      }
      const ownerIsDead = owner?.pid && !processAlive(owner.pid);
      const abandonedBeforeOwnerWrite = !owner && age > 1_000;
      if (ownerIsDead || abandonedBeforeOwnerWrite || age > LOCK_STALE_MS) {
        try {
          fs.rmSync(paths.lock, { recursive: true, force: true });
        } catch {
          // Another writer recovered it first.
        }
        continue;
      }
      sleepSync(LOCK_WAIT_MS);
    }
  }
  throw new Error(`timed out acquiring repository Pair state lock after ${timeoutMs}ms`);
}

function releaseLock(paths, lock) {
  const owner = readJson(path.join(paths.lock, 'owner.json'));
  if (owner?.nonce === lock?.nonce) {
    fs.rmSync(paths.lock, { recursive: true, force: true });
  }
}

function readPairEvents(root, workId = undefined) {
  const { events } = pairStatePaths(root, workId);
  if (!fs.existsSync(events)) return [];
  return fs.readFileSync(events, 'utf8')
    .split(/\r?\n/u)
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((left, right) => (left.sequence || 0) - (right.sequence || 0));
}

function initialState() {
  return {
    schema: STATE_SCHEMA,
    product: PRODUCT,
    sequence: 0,
    work_id: null,
    plan_digest: null,
    lifecycle: 'idle',
    active: null,
    in_flight_request: null,
    review_session: null,
    attempts: {},
    continuation: {
      owner_session_id: null,
      owner_runtime: null,
      pause_requested: false,
      paused: false,
      resume_target: null,
      human_edit: null,
    },
    warnings: [],
    usage: [],
  };
}

function attemptIdentity(event) {
  return event.attemptId || event.attempt_id || null;
}

function taskIdentity(event) {
  return event.taskId || event.task_id || null;
}

function workIdentity(event) {
  return event.workId || event.work_id || null;
}

function eventPhase(event, fallback = null) {
  return event.phase || event.resume_target || fallback;
}

function reducePairEvents(events) {
  const state = initialState();
  for (const event of events) {
    state.sequence = Math.max(state.sequence, event.sequence || 0);
    state.work_id = workIdentity(event) || state.work_id;
    state.plan_digest = event.planDigest || event.plan_digest || state.plan_digest;
    const attemptId = attemptIdentity(event);
    const taskId = taskIdentity(event);

    if (event.event === 'work.opened') {
      state.lifecycle = event.phase || 'ready';
    } else if (event.event === 'attempt.started') {
      const phase = eventPhase(event, 'implementing');
      const attempt = {
        attempt_id: attemptId,
        task_id: taskId,
        status: 'active',
        phase,
        runtime: event.runtime || null,
        role: event.role || 'coordinator',
        session_id: event.sessionId || event.session_id || null,
        reviewer_session_id: event.reviewerSessionId || event.reviewer_session_id || null,
        plan_digest: event.planDigest || event.plan_digest || state.plan_digest,
        patch_digest: event.patchDigest || event.patch_digest || null,
        worktree_id: event.worktree_id ?? event.worktreeId ?? null,
        base_digest: event.base_digest ?? event.baseDigest ?? null,
        started_at: event.startedAt || event.at,
        last_event_id: event.event_id,
      };
      state.attempts[attemptId] = attempt;
      state.active = { ...attempt };
      state.lifecycle = phase;
    } else if (['phase.entered', 'phase.progressed', 'attempt.recovered', 'infrastructure.failed'].includes(event.event)) {
      const current = attemptId ? state.attempts[attemptId] : state.active;
      if (current) {
        const phase = eventPhase(event, current.phase);
        Object.assign(current, {
          phase,
          status: event.event === 'infrastructure.failed' ? 'recoverable' : 'active',
          session_id: event.sessionId || event.session_id || current.session_id,
          reviewer_session_id: event.reviewerSessionId || event.reviewer_session_id || current.reviewer_session_id,
          patch_digest: event.patchDigest || event.patch_digest || current.patch_digest,
          resume_target: event.resume_target || phase,
          last_event_id: event.event_id,
        });
        state.active = { ...current };
        state.lifecycle = event.event === 'infrastructure.failed' ? 'recovering' : phase;
        if (current.reviewer_session_id) {
          state.review_session = {
            session_id: current.reviewer_session_id,
            runtime: event.runtime || current.runtime || null,
            phase,
            digest: event.patchDigest || event.patch_digest || current.patch_digest || state.plan_digest,
          };
        }
      }
    } else if (['attempt.outcome', 'attempt.completed'].includes(event.event) && attemptId) {
      const current = state.attempts[attemptId] || {
        attempt_id: attemptId,
        task_id: taskId,
        worktree_id: event.worktree_id ?? null,
        base_digest: event.base_digest ?? null,
      };
      Object.assign(current, {
        status: event.status || (event.terminal === false ? 'active' : 'completed'),
        disposition: event.disposition || null,
        action: event.action || null,
        cause: event.cause || null,
        terminal: event.terminal !== false,
        supersedes: event.supersedes || null,
        last_event_id: event.event_id,
        finished_at: event.finishedAt || event.at,
      });
      state.attempts[attemptId] = current;
      if (event.terminal !== false) {
        if (state.active?.attempt_id === attemptId) state.active = null;
        state.lifecycle = ['accepted', 'discarded'].includes(event.disposition) ? 'ready' : 'recovering';
      }
    } else if (event.event === 'pause.requested') {
      state.continuation.pause_requested = true;
    } else if (event.event === 'pause.checkpointed') {
      state.continuation.checkpoint = event.checkpoint || null;
      state.continuation.checkpoint_bytes = event.checkpoint_bytes || null;
      state.continuation.resume_target = event.resume_target || event.checkpoint?.resume_target || state.continuation.resume_target;
    } else if (event.event === 'work.paused') {
      state.continuation.pause_requested = false;
      state.continuation.paused = true;
      state.continuation.resume_target = event.resume_target || state.active?.phase || null;
      state.continuation.owner_session_id = null;
      state.continuation.owner_runtime = null;
      state.lifecycle = 'paused';
    } else if (event.event === 'work.resumed') {
      state.continuation.paused = false;
      state.continuation.pause_requested = false;
      state.lifecycle = event.resume_target || state.continuation.resume_target || state.active?.phase || 'ready';
    } else if (event.event === 'human-edit.started') {
      state.continuation.human_edit = {
        owner: 'human',
        kind: event.kind || 'code',
        base_plan_digest: event.base_plan_digest || null,
        base_plan_bytes_digest: event.base_plan_bytes_digest || null,
        base_patch_digest: event.base_patch_digest || null,
        base_changed_paths: event.base_changed_paths || [],
      };
      state.lifecycle = 'human-editing';
    } else if (event.event === 'human-edit.completed') {
      state.continuation.human_edit = null;
      state.continuation.resume_target = event.resume_target || state.continuation.resume_target;
      state.lifecycle = state.continuation.paused ? 'paused' : state.continuation.resume_target || 'ready';
    } else if (event.event === 'evidence.staled') {
      state.continuation.resume_target = event.resume_target || 'verifying';
      if (state.active) {
        state.active.phase = state.continuation.resume_target;
        state.active.evidence_stale = event.paths || [];
        if (state.attempts[state.active.attempt_id]) {
          Object.assign(state.attempts[state.active.attempt_id], state.active);
        }
      }
    } else if (event.event === 'plan.approval-invalidated') {
      state.plan_digest = event.planDigest || event.plan_digest || state.plan_digest;
      state.plan_approval = 'invalidated';
    } else if (event.event === 'continuation.claimed') {
      state.continuation.owner_session_id = event.session_id || null;
      state.continuation.owner_runtime = event.runtime || null;
    } else if (event.event === 'request.started') {
      state.in_flight_request = {
        request_id: event.request_id || null,
        request_pid: event.request_pid || null,
        request_kind: event.request_kind || null,
        attempt_id: attemptId,
        phase: eventPhase(event, state.active?.phase || state.lifecycle),
        started_at: event.at || null,
      };
      if (state.active && (!attemptId || attemptId === state.active.attempt_id)) {
        state.active.request_id = event.request_id || null;
        state.active.request_pid = event.request_pid || null;
        state.active.request_kind = event.request_kind || null;
        state.active.request_started_at = event.at || null;
        if (state.attempts[state.active.attempt_id]) {
          Object.assign(state.attempts[state.active.attempt_id], state.active);
        }
      }
      state.lifecycle = state.in_flight_request.phase || state.lifecycle;
    } else if (['request.completed', 'request.cancelled'].includes(event.event)) {
      const trackedRequestId = state.in_flight_request?.request_id || state.active?.request_id || null;
      const matchesRequest = !event.request_id || !trackedRequestId || event.request_id === trackedRequestId;
      if (matchesRequest) state.in_flight_request = null;
      const matchesAttempt = state.active && (!attemptId || attemptId === state.active.attempt_id);
      if (matchesAttempt && matchesRequest) {
        state.active.request_id = null;
        state.active.request_pid = null;
        state.active.request_kind = null;
        state.active.request_started_at = null;
        state.continuation.resume_target = event.resume_target || state.active.phase;
        if (state.attempts[state.active.attempt_id]) {
          Object.assign(state.attempts[state.active.attempt_id], state.active);
        }
      }
      if (matchesRequest) {
        state.continuation.resume_target = event.resume_target || state.active?.phase || event.phase || state.continuation.resume_target;
        state.lifecycle = state.active?.phase || state.continuation.resume_target || state.lifecycle;
      }
    } else if (event.event === 'usage.recorded') {
      state.usage.push(event);
      if (state.usage.length > 100) state.usage.shift();
    } else if (event.event === 'warning.recorded') {
      state.warnings.push({
        code: event.code || 'warning',
        detail: event.detail || '',
        at: event.at,
      });
      if (state.warnings.length > 50) state.warnings.shift();
    } else if (event.event === 'plan-review.completed') {
      if (event.reviewerSessionId || event.reviewer_session_id) {
        state.review_session = {
          session_id: event.reviewerSessionId || event.reviewer_session_id,
          runtime: String(event.reviewer || '').split('/')[0] || event.runtime || null,
          phase: 'plan-review',
          digest: event.planDigest || event.plan_digest || state.plan_digest,
        };
      }
    } else if (event.event === 'final-review.completed') {
      if (event.reviewerSessionId || event.reviewer_session_id) {
        state.review_session = {
          session_id: event.reviewerSessionId || event.reviewer_session_id,
          runtime: String(event.reviewer || '').split('/')[0] || event.runtime || null,
          phase: 'cumulative-review',
          digest: event.patchDigest || event.patch_digest || null,
        };
      }
    } else if (event.event === 'work.phase.entered') {
      state.lifecycle = event.phase || state.lifecycle;
      state.continuation.resume_target = event.resume_target || event.phase || state.continuation.resume_target;
    } else if (event.event === 'work.correction-needed') {
      state.lifecycle = event.phase || 'cumulative-correction';
      state.correction_reason = event.reason || 'local correction required';
      state.continuation.resume_target = event.resume_target || event.phase || 'cumulative-correction';
    } else if (event.event === 'work.completed') {
      state.active = null;
      state.lifecycle = 'complete';
      state.correction_reason = null;
      state.continuation.owner_session_id = null;
      state.continuation.owner_runtime = null;
      state.continuation.pause_requested = false;
      state.continuation.paused = false;
      state.continuation.resume_target = null;
    } else if (event.event === 'work.blocked') {
      state.lifecycle = 'blocked';
      state.blocked_reason = event.reason || 'material blocker';
      state.continuation.resume_target = event.phase || event.resume_target || state.continuation.resume_target;
      state.continuation.owner_session_id = null;
      state.continuation.owner_runtime = null;
    }
  }
  return state;
}

function renderStatus(state) {
  const active = state.active;
  const warningLines = state.warnings.length === 0
    ? '- None.'
    : state.warnings.slice(-10).map(warning => `- ${warning.code}: ${warning.detail || 'see event history'}`).join('\n');
  return [
    '# Pair v4 Status',
    '',
    `- **Work:** ${state.work_id || 'none'}`,
    `- **Lifecycle:** ${state.lifecycle}`,
    `- **Task:** ${active?.task_id || 'none'}`,
    `- **Attempt:** ${active?.attempt_id || 'none'}`,
    `- **Phase:** ${active?.phase || state.continuation.resume_target || 'none'}`,
    `- **Runtime session:** ${active?.session_id || 'none'}`,
    `- **Review Session:** ${active?.reviewer_session_id || state.review_session?.session_id || 'none'}`,
    `- **Review binding:** ${state.review_session ? `${state.review_session.phase} @ ${state.review_session.digest || 'unknown digest'}` : 'none'}`,
    `- **Resume target:** ${state.continuation.resume_target || active?.resume_target || 'none'}`,
    `- **Sequence:** ${state.sequence}`,
    '',
    '## Warnings',
    '',
    warningLines,
    '',
  ].join('\n');
}

function atomicWrite(file, content, mode = 0o600) {
  ensurePrivateDirectory(path.dirname(file));
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  fs.writeFileSync(temporary, content, { mode });
  fs.renameSync(temporary, file);
  try {
    fs.chmodSync(file, mode);
  } catch {
    // See ensurePrivateDirectory.
  }
}

function writeProjection(root, state) {
  const paths = pairStatePaths(root);
  atomicWrite(paths.state, `${JSON.stringify(state, null, 2)}\n`);
  atomicWrite(paths.status, renderStatus(state));
  if (state.active?.attempt_id) {
    const attemptDirectory = path.join(paths.attempts, state.active.attempt_id);
    ensurePrivateDirectory(attemptDirectory);
    atomicWrite(
      path.join(attemptDirectory, 'status.json'),
      `${JSON.stringify(state.active, null, 2)}\n`,
    );
  }
  return state;
}

function rebuildProjection(root) {
  return writeProjection(root, reducePairEvents(readPairEvents(root)));
}

function loadPairState(root) {
  const paths = pairStatePaths(root);
  const events = readPairEvents(root);
  const expectedSequence = events.at(-1)?.sequence || 0;
  const state = readJson(paths.state);
  if (!state || state.schema !== STATE_SCHEMA || state.sequence !== expectedSequence) {
    return writeProjection(root, reducePairEvents(events));
  }
  return state;
}

function appendPairEvent(root, event) {
  if (!event || typeof event !== 'object' || typeof event.event !== 'string') {
    throw new TypeError('Pair event must be an object with an event name');
  }
  const eventWorkId = workIdentity(event) || currentWorkId(root);
  const paths = pairStatePaths(root, eventWorkId);
  const lock = acquireLock(paths);
  try {
    ensurePrivateDirectory(paths.pairDirectory);
    ensurePrivateDirectory(paths.directory);
    ensurePrivateDirectory(paths.attempts);
    const events = readPairEvents(root, eventWorkId);
    const sequence = (events.at(-1)?.sequence || 0) + 1;
    const sanitized = sanitizeValue(event) || {};
    const stored = {
      ...sanitized,
      schema: STATE_SCHEMA,
      product: PRODUCT,
      event: event.event,
      event_id: sanitized.event_id || crypto.randomUUID(),
      sequence,
      at: sanitized.at || new Date().toISOString(),
      worktree_id: sanitized.worktree_id ?? sanitized.worktreeId ?? null,
      base_digest: sanitized.base_digest ?? sanitized.baseDigest ?? null,
    };
    fs.appendFileSync(paths.events, `${JSON.stringify(stored)}\n`, { mode: 0o600 });
    try {
      fs.chmodSync(paths.events, 0o600);
    } catch {
      // See ensurePrivateDirectory.
    }
    if (eventWorkId) {
      atomicWrite(
        paths.current,
        `${JSON.stringify({ schema: STATE_SCHEMA, work_id: eventWorkId, run: path.relative(root, paths.directory).split(path.sep).join('/') }, null, 2)}\n`,
      );
    }
    writeProjection(root, reducePairEvents([...events, stored]));
    return stored;
  } finally {
    releaseLock(paths, lock);
  }
}

function effectiveAttemptRecords(root) {
  const terminal = new Map();
  for (const event of readPairEvents(root)) {
    const attemptId = attemptIdentity(event);
    if (!attemptId || !['attempt.outcome', 'attempt.completed'].includes(event.event)) continue;
    if (event.terminal === false) continue;
    terminal.set(attemptId, {
      ...event,
      event: 'attempt.completed',
      attemptId,
      taskId: taskIdentity(event),
      status: event.status || 'completed',
    });
  }
  return [...terminal.values()].sort((left, right) => left.sequence - right.sequence);
}

function importLegacyAttemptHistory(root, legacyFile, workId = null) {
  const sourceReference = crypto.createHash('sha256').update(String(legacyFile || 'none')).digest('hex');
  const warnOnce = (code, detail) => {
    const duplicate = readPairEvents(root).some(event =>
      event.event === 'warning.recorded' &&
      event.code === code &&
      workIdentity(event) === workId &&
      event.source_reference === sourceReference,
    );
    if (!duplicate) {
      appendPairEvent(root, {
        event: 'warning.recorded',
        workId,
        code,
        detail,
        source_reference: sourceReference,
      });
    }
  };
  if (!legacyFile || !fs.existsSync(legacyFile)) {
    warnOnce(
      'legacy-storage-unavailable',
      legacyFile ? 'legacy attempt history is unavailable; new Work continues repository-locally' : 'no legacy attempt history configured',
    );
    return { imported: 0, warning: 'legacy-storage-unavailable' };
  }
  let bytes;
  try {
    bytes = fs.readFileSync(legacyFile);
  } catch {
    warnOnce(
      'legacy-storage-unreadable',
      'legacy attempt history could not be read; new Work continues repository-locally',
    );
    return { imported: 0, warning: 'legacy-storage-unreadable' };
  }
  const sourceDigest = crypto.createHash('sha256').update(bytes).digest('hex');
  if (readPairEvents(root).some(event => event.event === 'legacy.imported' && event.source_digest === sourceDigest)) {
    return { imported: 0, duplicate: true, sourceDigest };
  }
  const rows = bytes.toString('utf8').split(/\r?\n/u).filter(Boolean).map(line => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);
  let imported = 0;
  for (const row of rows) {
    if (!['attempt.started', 'attempt.completed'].includes(row.event)) continue;
    if (workId && row.workId && row.workId !== workId) continue;
    appendPairEvent(root, {
      ...row,
      workId: row.workId || workId,
      legacy: true,
      legacy_source_digest: sourceDigest,
    });
    imported++;
  }
  appendPairEvent(root, {
    event: 'legacy.imported',
    workId,
    source_digest: sourceDigest,
    imported,
    incomplete_history: rows.some(row => !row.event || !row.attemptId),
  });
  return { imported, sourceDigest };
}

module.exports = {
  PRODUCT,
  STATE_SCHEMA,
  appendPairEvent,
  effectiveAttemptRecords,
  importLegacyAttemptHistory,
  loadPairState,
  pairStatePaths,
  readPairEvents,
  rebuildProjection,
  reducePairEvents,
  redactString,
  sanitizeText,
  sanitizeValue,
};
