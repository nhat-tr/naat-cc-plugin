const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { redactString } = require('./pair-store');

const NESTED_SESSION_ENV_KEYS = [
  'CODEX_THREAD_ID',
  'CLAUDECODE',
  'CLAUDE_CODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_PARENT_SESSION_ID',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_SESSION_ID',
  'CLAUDE_SESSION_ID_OVERRIDE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SSE_PORT',
];

function providerEnvironment(source = process.env) {
  const env = {
    ...source,
    PATH: String(source.PATH || '').split(path.delimiter).filter(entry => entry && !entry.includes('cmux-cli-shims')).join(path.delimiter),
    PAIR_STOP_GATE: 'off',
    CLAUDE_STOP_GATE: 'off',
  };
  for (const key of NESTED_SESSION_ENV_KEYS) delete env[key];
  return env;
}

function buildProviderCommand({ runtime, mode, root, prompt, schemaPath, schema, outputPath, model = null, effort = 'medium' }) {
  if (!['implementation', 'review'].includes(mode)) throw new Error(`unsupported provider mode ${mode}`);
  if (runtime === 'codex') {
    const args = [
      'exec',
      '--json',
      '--ephemeral',
      '--sandbox', mode === 'review' ? 'read-only' : 'workspace-write',
      '-C', root,
      '--output-schema', schemaPath,
      '--output-last-message', outputPath,
    ];
    if (model && model !== 'default') args.push('--model', model);
    if (effort && effort !== 'default') args.push('-c', `model_reasoning_effort="${effort}"`);
    args.push(prompt);
    return { file: 'codex', args, cwd: root };
  }
  if (runtime === 'claude') {
    const args = [
      '-p', prompt,
      '--output-format', 'json',
      '--no-session-persistence',
      '--permission-mode', mode === 'review' ? 'dontAsk' : 'acceptEdits',
    ];
    if (mode === 'review') args.push('--disallowedTools', 'Edit,Write,NotebookEdit,Task');
    args.push('--json-schema', JSON.stringify(schema));
    if (model && model !== 'default') args.push('--model', model);
    if (effort && effort !== 'default') args.push('--effort', effort);
    return { file: 'claude', args, cwd: root };
  }
  throw new Error(`unsupported runtime ${runtime}`);
}

function usageFromOutput(runtime, raw) {
  const empty = { input_tokens: 0, cached_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, cost_usd: null };
  if (!String(raw || '').trim()) return empty;
  if (runtime === 'codex') {
    const events = String(raw).split(/\r?\n/u).filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
    const usage = [...events].reverse().find(event => event.type === 'turn.completed')?.usage || {};
    return {
      input_tokens: usage.input_tokens || 0,
      cached_input_tokens: usage.cached_input_tokens || 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
      output_tokens: usage.output_tokens || 0,
      reasoning_tokens: usage.reasoning_output_tokens || 0,
      cost_usd: null,
    };
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return empty; }
  const envelope = Array.isArray(parsed) ? parsed.findLast(item => item?.type === 'result') || parsed.at(-1) : parsed;
  const usage = envelope?.usage || envelope?.result?.usage || {};
  return {
    input_tokens: usage.input_tokens || usage.inputTokens || 0,
    cached_input_tokens: usage.cache_read_input_tokens || usage.cached_input_tokens || 0,
    cache_creation_input_tokens: usage.cache_creation_input_tokens || usage.cacheCreationInputTokens || 0,
    output_tokens: usage.output_tokens || usage.outputTokens || 0,
    reasoning_tokens: usage.reasoning_tokens || 0,
    cost_usd: Number.isFinite(envelope?.total_cost_usd) ? envelope.total_cost_usd : null,
  };
}

function structuredOutput(runtime, raw, outputPath) {
  if (runtime === 'codex') {
    if (!fs.existsSync(outputPath)) throw new Error('Codex produced no structured result');
    return JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  }
  const parsed = JSON.parse(raw);
  const envelope = Array.isArray(parsed) ? parsed.findLast(item => item?.type === 'result') || parsed.at(-1) : parsed;
  const candidate = envelope?.structured_output ?? envelope?.result?.structured_output ?? envelope?.result;
  if (!candidate || typeof candidate !== 'object') throw new Error('Claude produced no structured result');
  return candidate;
}

function runFreshProvider(input, dependencies = {}) {
  const started = Date.now();
  const command = buildProviderCommand(input);
  const spawnSync = dependencies.spawnSync || childProcess.spawnSync;
  const result = spawnSync(command.file, command.args, {
    cwd: command.cwd,
    env: providerEnvironment(dependencies.env || process.env),
    encoding: 'utf8',
    timeout: input.timeoutMs || 45 * 60 * 1000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const raw = result.stdout || '';
  const usage = usageFromOutput(input.runtime, raw);
  if (result.error) throw new Error(redactString(result.error.message));
  if (result.status !== 0) {
    const detail = redactString(result.stderr || '').trim().slice(0, 1000);
    throw new Error(`${input.runtime} ${input.mode} invocation failed with status ${result.status}${detail ? `: ${detail}` : ''}`);
  }
  const output = structuredOutput(input.runtime, raw, input.outputPath);
  const outputBytes = Buffer.byteLength(JSON.stringify(output), 'utf8');
  if (outputBytes > (input.maxOutputBytes || 16 * 1024)) {
    throw new Error(`${input.mode} structured result exceeds ${input.maxOutputBytes || 16 * 1024} UTF-8 bytes`);
  }
  return {
    output,
    usage,
    duration_ms: Date.now() - started,
    runtime: input.runtime,
    model: input.model || 'default',
    effort: input.effort || 'medium',
  };
}

module.exports = {
  NESTED_SESSION_ENV_KEYS,
  buildProviderCommand,
  providerEnvironment,
  runFreshProvider,
  structuredOutput,
  usageFromOutput,
};
