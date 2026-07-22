const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { pairStatePaths } = require('./pair-state');

function reviewSessionFile(root) {
  return path.join(pairStatePaths(root).directory, 'review-session.json');
}

function readReviewSession(root, runtime = null, snapshotDigest = null) {
  try {
    const state = JSON.parse(fs.readFileSync(reviewSessionFile(root), 'utf8'));
    if (runtime && state.runtime !== runtime) return null;
    if (snapshotDigest && state.snapshot_digest !== snapshotDigest) return null;
    return state;
  } catch {
    return null;
  }
}

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(path.dirname(file), 0o700); } catch {}
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

function buildReviewRuntimeCommand({
  runtime,
  root,
  prompt,
  schemaPath,
  schema,
  outputPath,
  model = null,
  effort = 'medium',
  externalSandbox = false,
  reviewerSessionId = null,
}) {
  if (runtime === 'codex') {
    const resume = Boolean(reviewerSessionId);
    const args = resume
      ? [
          'exec', 'resume', '--json',
          '--output-schema', schemaPath,
          '--output-last-message', outputPath,
          '-c', `model_reasoning_effort="${effort}"`,
        ]
      : [
          'exec', '--json',
          ...(externalSandbox
            ? ['--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check']
            : ['--sandbox', 'read-only']),
          '-C', root,
          '--output-schema', schemaPath,
          '--output-last-message', outputPath,
          '-c', `model_reasoning_effort="${effort}"`,
        ];
    if (resume && externalSandbox) {
      args.push('--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check');
    }
    if (model && model !== 'default') args.push('--model', model);
    if (resume) args.push(reviewerSessionId);
    args.push(prompt);
    return {
      file: 'codex',
      args,
      cwd: root,
      reviewerSessionId,
      resumed: resume,
    };
  }
  if (runtime === 'claude') {
    const sessionId = reviewerSessionId || crypto.randomUUID();
    const args = [
      '-p', prompt,
      '--output-format', 'json',
      ...(reviewerSessionId ? ['--resume', reviewerSessionId] : ['--session-id', sessionId]),
      '--permission-mode', 'dontAsk',
      '--disallowedTools', 'Edit,Write,NotebookEdit,Task',
      '--json-schema', JSON.stringify(schema),
      '--effort', effort,
    ];
    if (model && model !== 'default') args.push('--model', model);
    return {
      file: 'claude',
      args,
      cwd: root,
      reviewerSessionId: sessionId,
      resumed: Boolean(reviewerSessionId),
    };
  }
  throw new Error(`unsupported review runtime ${runtime}`);
}

function observedSessionId(runtime, stdout) {
  if (runtime === 'codex') {
    for (const line of String(stdout || '').split(/\r?\n/u)) {
      try {
        const event = JSON.parse(line);
        if (event.type === 'thread.started' && (event.thread_id || event.session_id)) {
          return event.thread_id || event.session_id;
        }
      } catch {}
    }
    return null;
  }
  try {
    const envelope = JSON.parse(String(stdout || ''));
    return envelope.session_id || envelope.sessionId || null;
  } catch {
    return null;
  }
}

function saveReviewSession(root, {
  runtime,
  stdout = '',
  plannedSessionId = null,
  runSucceeded = true,
  model = null,
  effort = null,
  phase = null,
  snapshotDigest = null,
}) {
  // A planned session id is only the id we *intended* to use; the provider
  // establishes (and can later resume) that conversation only when the run
  // actually completes. Persisting a planned id from a failed run poisons the
  // reusable Review Session: every later resume then fails with "No conversation
  // found with session ID" and hard-blocks the challenge. An observed id is real
  // evidence the provider started the thread, so it stays trusted even on a
  // non-zero exit; only the unconfirmed planned fallback is gated on success.
  const sessionId = observedSessionId(runtime, stdout)
    || (runSucceeded ? plannedSessionId : null);
  if (!sessionId) return null;
  const prior = readReviewSession(root, runtime);
  const state = {
    schema: 1,
    product: 'pair-v4',
    runtime,
    session_id: sessionId,
    model: model || prior?.model || null,
    effort: effort || prior?.effort || null,
    last_phase: phase || prior?.last_phase || null,
    snapshot_digest: snapshotDigest || prior?.snapshot_digest || null,
    created_at: prior?.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  atomicWrite(reviewSessionFile(root), state);
  return state;
}

module.exports = {
  buildReviewRuntimeCommand,
  observedSessionId,
  readReviewSession,
  reviewSessionFile,
  saveReviewSession,
};
