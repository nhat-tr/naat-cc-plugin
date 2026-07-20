#!/usr/bin/env node

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  appendPairEvent,
  loadPairState,
  redactString,
  sanitizeText,
  sanitizeValue,
} = require('./pair-state');
const { runInPaneSync } = require('./tmux-host');

const PAIR_RUNTIME_ENV_KEYS = [
  'CODEX_THREAD_ID',
  'CLAUDECODE',
  'CLAUDE_CODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_PARENT_SESSION_ID',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SSE_PORT',
];

function childEnvironment(mode, environmentPath = null) {
  const env = { ...process.env };
  if (environmentPath !== null) env.PATH = environmentPath;
  if (mode !== 'pair-runtime') return env;
  env.PATH = (env.PATH || '')
    .split(path.delimiter)
    .filter(entry => entry && !entry.includes('cmux-cli-shims'))
    .join(path.delimiter);
  env.PAIR_STOP_GATE = 'off';
  env.CLAUDE_STOP_GATE = 'off';
  for (const key of PAIR_RUNTIME_ENV_KEYS) delete env[key];
  return env;
}

function killProcessGroup(child, signal) {
  if (!child?.pid) return;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try { child.kill(signal); } catch { /* already exited */ }
  }
}

function sanitizeStructuredOutput(command) {
  const index = Array.isArray(command?.args)
    ? command.args.indexOf('--output-last-message')
    : -1;
  if (index < 0 || !command.args[index + 1]) return;
  const file = command.args[index + 1];
  if (!fs.existsSync(file)) return;
  const raw = fs.readFileSync(file, 'utf8');
  let safe = redactString(raw);
  try {
    safe = `${JSON.stringify(sanitizeValue(JSON.parse(raw)), null, 2)}\n`;
  } catch {
    // Non-JSON structured output is still text-redacted.
  }
  fs.writeFileSync(file, safe, { mode: 0o600 });
}

function runChild(requestPath, resultPath) {
  const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
  const {
    command,
    label,
    outputFile,
    stderrFile,
    hardTimeoutMs,
    stallTimeoutMs,
    heartbeatMs,
    environmentMode,
    environmentPath,
    mirrorOutput,
    stateContext,
  } = request;
  fs.mkdirSync(path.dirname(outputFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(outputFile, '', { mode: 0o600 });
  fs.writeFileSync(stderrFile, '', { mode: 0o600 });

  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let termination = null;
  let spawnError = null;
  let settled = false;
  let forceKillTimer = null;
  let stallTimer = null;
  const pendingOutput = { stdout: '', stderr: '' };

  console.error(
    `pair-loop: started ${label}; hard timeout ${hardTimeoutMs}ms, no-output stall ${stallTimeoutMs}ms; evidence ${outputFile}`,
  );

  let child;
  try {
    child = childProcess.spawn(command.file, command.args, {
      cwd: command.cwd,
      env: childEnvironment(environmentMode, environmentPath),
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    fs.writeFileSync(resultPath, JSON.stringify({
      status: null,
      signal: null,
      error: { message: error.message, code: error.code || null },
      termination: null,
      elapsedMs: Date.now() - startedMs,
      stdoutBytes,
      stderrBytes,
      startedAt,
      finishedAt: new Date().toISOString(),
    }), { mode: 0o600 });
    return;
  }

  const requestId = stateContext?.requestId || crypto.randomUUID();
  if (stateContext?.root) {
    try {
      appendPairEvent(stateContext.root, {
        event: 'request.started',
        workId: stateContext.workId || null,
        attemptId: stateContext.attemptId || null,
        phase: stateContext.phase || null,
        request_id: requestId,
        request_pid: child.pid,
        request_kind: stateContext.requestKind || label,
        resume_target: stateContext.phase || null,
      });
    } catch (error) {
      killProcessGroup(child, 'SIGTERM');
      fs.writeFileSync(resultPath, JSON.stringify({
        status: null,
        signal: null,
        error: { message: `could not journal in-flight request: ${error.message}`, code: error.code || null },
        termination: 'state-tracking-failure',
        elapsedMs: Date.now() - startedMs,
        stdoutBytes,
        stderrBytes,
        startedAt,
        finishedAt: new Date().toISOString(),
      }), { mode: 0o600 });
      return;
    }
  }

  const terminate = (kind, signal = 'SIGTERM') => {
    if (settled || termination) return;
    termination = kind;
    const elapsed = Date.now() - startedMs;
    const reason = kind === 'stall-timeout'
      ? `produced no output for ${stallTimeoutMs}ms`
      : kind === 'interrupted'
        ? `was interrupted by ${signal}`
        : `reached its ${hardTimeoutMs}ms hard timeout`;
    console.error(`pair-loop: ${label} ${reason} after ${elapsed}ms; terminating`);
    killProcessGroup(child, signal);
    forceKillTimer = setTimeout(
      () => killProcessGroup(child, 'SIGKILL'),
      Number(process.env.PAIR_TERMINATE_GRACE_MS || 1000),
    );
    forceKillTimer.unref?.();
  };

  const armStall = () => {
    clearTimeout(stallTimer);
    if (stallTimeoutMs > 0) {
      stallTimer = setTimeout(() => terminate('stall-timeout'), stallTimeoutMs);
    }
  };
  armStall();
  const hardTimer = setTimeout(() => terminate('hard-timeout'), hardTimeoutMs);
  const heartbeatTimer = heartbeatMs > 0
    ? setInterval(() => {
        console.error(
          `pair-loop: still waiting for ${label} after ${Date.now() - startedMs}ms; output ${stdoutBytes + stderrBytes} bytes`,
        );
      }, heartbeatMs)
    : null;
  const onSigint = () => terminate('interrupted', 'SIGINT');
  const onSigterm = () => terminate('interrupted', 'SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);

  const emit = (file, value, kind) => {
    if (!value) return;
    const sanitized = sanitizeText(value);
    const bytes = Buffer.byteLength(sanitized);
    if (kind === 'stdout') stdoutBytes += bytes;
    else stderrBytes += bytes;
    fs.appendFileSync(file, sanitized);
    if (mirrorOutput) {
      if (kind === 'stdout') process.stdout.write(sanitized);
      else process.stderr.write(sanitized);
    }
  };
  const append = (file, chunk, kind) => {
    pendingOutput[kind] += chunk.toString();
    const boundary = pendingOutput[kind].lastIndexOf('\n');
    if (boundary >= 0) {
      emit(file, pendingOutput[kind].slice(0, boundary + 1), kind);
      pendingOutput[kind] = pendingOutput[kind].slice(boundary + 1);
    }
    if (pendingOutput[kind].length > 16_384) {
      emit(file, pendingOutput[kind].slice(0, -4_096), kind);
      pendingOutput[kind] = pendingOutput[kind].slice(-4_096);
    }
    armStall();
  };
  child.stdout.on('data', chunk => append(outputFile, chunk, 'stdout'));
  child.stderr.on('data', chunk => append(stderrFile, chunk, 'stderr'));
  child.on('error', error => { spawnError = error; });
  child.on('close', (status, signal) => {
    if (settled) return;
    settled = true;
    clearTimeout(stallTimer);
    clearTimeout(hardTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    clearTimeout(forceKillTimer);
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    emit(outputFile, pendingOutput.stdout, 'stdout');
    emit(stderrFile, pendingOutput.stderr, 'stderr');
    sanitizeStructuredOutput(command);
    const error = spawnError || (termination
      ? {
          message: termination === 'stall-timeout'
            ? `${label} produced no output for ${stallTimeoutMs}ms`
            : termination === 'interrupted'
              ? `${label} was interrupted`
              : `${label} exceeded ${hardTimeoutMs}ms`,
          code: termination === 'interrupted' ? 'EINTR' : 'ETIMEDOUT',
        }
      : null);
    fs.writeFileSync(resultPath, JSON.stringify({
      status,
      signal,
      error,
      termination,
      elapsedMs: Date.now() - startedMs,
      stdoutBytes,
      stderrBytes,
      startedAt,
      finishedAt: new Date().toISOString(),
    }), { mode: 0o600 });
    if (stateContext?.root) {
      try {
        appendPairEvent(stateContext.root, {
          event: 'request.completed',
          workId: stateContext.workId || null,
          attemptId: stateContext.attemptId || null,
          phase: stateContext.phase || null,
          request_id: requestId,
          request_pid: child.pid,
          request_kind: stateContext.requestKind || label,
          status,
          signal: signal || null,
          termination,
          resume_target: stateContext.phase || null,
        });
        const state = loadPairState(stateContext.root);
        if (state.continuation.pause_requested && !state.continuation.paused) {
          appendPairEvent(stateContext.root, {
            event: 'work.paused',
            workId: stateContext.workId || state.work_id || null,
            attemptId: stateContext.attemptId || state.active?.attempt_id || null,
            resume_target: stateContext.phase || state.active?.phase || state.continuation.resume_target,
          });
        }
      } catch (error) {
        console.error(`pair-v4: could not journal request completion: ${error.message}`);
      }
    }
  });
}

function runObservableCommandSync({
  command,
  label,
  outputFile,
  hardTimeoutMs,
  stallTimeoutMs,
  heartbeatMs,
  environmentMode = 'inherit',
  visible = null,
  stateContext = null,
}) {
  const token = crypto.randomUUID();
  const requestPath = `${outputFile}.${token}.request.json`;
  const resultPath = `${outputFile}.${token}.result.json`;
  const stderrFile = `${outputFile}.stderr`;
  fs.mkdirSync(path.dirname(outputFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(requestPath, JSON.stringify({
    command,
    label,
    outputFile,
    stderrFile,
    hardTimeoutMs,
    stallTimeoutMs,
    heartbeatMs,
    environmentMode,
    environmentPath: process.env.PATH || '',
    mirrorOutput: Boolean(visible),
    stateContext: stateContext
      ? { ...stateContext, requestId: token }
      : null,
  }), { mode: 0o600 });
  const helperTimeout = hardTimeoutMs + Number(process.env.PAIR_TERMINATE_GRACE_MS || 1000) + 5000;
  let helper;
  if (visible) {
    try {
      runInPaneSync(
        visible.root,
        visible.role || 'reviewer',
        [process.execPath, __filename, '--child', requestPath, resultPath],
        helperTimeout,
      );
      helper = { status: 0, signal: null, error: null };
    } catch (error) {
      helper = { status: null, signal: null, error };
    }
  } else {
    helper = childProcess.spawnSync(
      process.execPath,
      [__filename, '--child', requestPath, resultPath],
      {
        cwd: command.cwd,
        stdio: ['ignore', 'inherit', 'inherit'],
        timeout: helperTimeout,
      },
    );
  }
  let metadata;
  try {
    metadata = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  } catch {
    metadata = {
      status: helper.status,
      signal: helper.signal || null,
      error: {
        message: helper.error?.message || 'observable command helper exited without metadata',
        code: helper.error?.code || null,
      },
      termination: helper.error?.code === 'ETIMEDOUT' ? 'hard-timeout' : null,
      elapsedMs: null,
      stdoutBytes: 0,
      stderrBytes: 0,
    };
  }
  fs.rmSync(requestPath, { force: true });
  fs.rmSync(resultPath, { force: true });
  fs.writeFileSync(
    `${outputFile}.metadata.json`,
    `${JSON.stringify(metadata, null, 2)}\n`,
    { mode: 0o600 },
  );
  const stdout = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, 'utf8') : '';
  const stderr = fs.existsSync(stderrFile) ? fs.readFileSync(stderrFile, 'utf8') : '';
  return {
    ...metadata,
    error: metadata.error ? Object.assign(new Error(metadata.error.message), metadata.error) : undefined,
    stdout,
    stderr,
    evidence: { stdout: outputFile, stderr: stderrFile, metadata: `${outputFile}.metadata.json` },
  };
}

if (require.main === module) {
  if (process.argv[2] !== '--child') {
    console.error('Usage: observable-command.js --child REQUEST RESULT');
    process.exitCode = 2;
  } else {
    runChild(process.argv[3], process.argv[4]);
  }
}

module.exports = { runObservableCommandSync };
