const childProcess = require('node:child_process');

const SUPPORTED_RUNTIMES = ['codex', 'claude'];

function commandExists(command) {
  return childProcess.spawnSync('sh', ['-c', `command -v ${command}`], {
    stdio: 'ignore',
  }).status === 0;
}

function installedRuntimes() {
  return SUPPORTED_RUNTIMES.filter(commandExists);
}

function isNestedCodexSandbox(env = process.env) {
  return Boolean(env.CODEX_THREAD_ID && env.CODEX_SANDBOX);
}

function resolveRuntimeCandidates(requested, options = {}) {
  const env = options.env || process.env;
  const allowCrossRuntimeFallback = options.allowCrossRuntimeFallback
    ?? env.PAIR_ALLOW_CROSS_RUNTIME_FALLBACK === '1';
  const available = [...new Set(options.available || installedRuntimes())]
    .filter(runtime => SUPPORTED_RUNTIMES.includes(runtime));

  if (requested !== 'auto') {
    if (!SUPPORTED_RUNTIMES.includes(requested)) {
      throw new Error(`unsupported runtime ${requested}`);
    }
    if (!available.includes(requested)) throw new Error(`${requested} is not on PATH`);
    return [requested];
  }

  if (available.length === 0) throw new Error('neither codex nor claude is on PATH');

  const coordinatorRuntime = (env.CLAUDECODE || env.CLAUDE_CODE || env.CLAUDE_CODE_SESSION_ID)
    ? 'claude'
    : env.CODEX_THREAD_ID
      ? 'codex'
      : SUPPORTED_RUNTIMES.includes(env.PAIR_DEFAULT_RUNTIME)
        ? env.PAIR_DEFAULT_RUNTIME
        : available[0];

  const viable = available;

  const preferred = [];
  if (viable.includes(coordinatorRuntime)) {
    preferred.push(coordinatorRuntime);
  } else if (!allowCrossRuntimeFallback) {
    throw new Error(
      `${coordinatorRuntime} is not available for auto routing, and Pair will not switch providers without --allow-cross-runtime-fallback`,
    );
  }
  for (const runtime of viable) {
    if (!preferred.includes(runtime)) preferred.push(runtime);
  }
  if (preferred.length === 0) throw new Error('neither codex nor claude is on PATH');
  return allowCrossRuntimeFallback ? preferred : preferred.slice(0, 1);
}

function resolveRuntime(requested, options = {}) {
  return resolveRuntimeCandidates(requested, options)[0];
}

module.exports = {
  SUPPORTED_RUNTIMES,
  commandExists,
  installedRuntimes,
  isNestedCodexSandbox,
  resolveRuntime,
  resolveRuntimeCandidates,
};
