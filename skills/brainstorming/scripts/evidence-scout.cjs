#!/usr/bin/env node
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAX_BRIEF_BYTES = 4_000;
const MAX_PACKET_BYTES = 6_000;
const EVIDENCE_KINDS = new Set(['symbol', 'caller', 'dependency', 'framework', 'test', 'configuration']);

const EVIDENCE_PACKET_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  additionalProperties: false,
  required: ['version', 'summary', 'evidence', 'unknowns'],
  properties: {
    version: { const: 1 },
    summary: { type: 'string', minLength: 1, maxLength: 500 },
    evidence: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'path', 'startLine', 'endLine', 'observation'],
        properties: {
          kind: { enum: [...EVIDENCE_KINDS] },
          path: { type: 'string', minLength: 1, maxLength: 300 },
          startLine: { type: 'integer', minimum: 1 },
          endLine: { type: 'integer', minimum: 1 },
          observation: { type: 'string', minLength: 1, maxLength: 400 },
        },
      },
    },
    unknowns: {
      type: 'array',
      maxItems: 12,
      items: { type: 'string', minLength: 1, maxLength: 300 },
    },
  },
};

function fail(message) {
  throw new Error(message);
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
}

function rejectUnknown(value, allowed, label) {
  const unknown = Object.keys(value).find(key => !allowed.includes(key));
  if (unknown) fail(`unsupported field ${label}.${unknown}`);
}

function text(value, maximum, label, required = false) {
  if (value == null) {
    if (required) fail(`${label} is required`);
    return '';
  }
  if (typeof value !== 'string') fail(`${label} must be text`);
  const normalized = value.trim();
  if (required && !normalized) fail(`${label} is required`);
  if (normalized.length > maximum) fail(`${label} must be at most ${maximum} characters`);
  return normalized;
}

function textList(value, label, maximumItems, maximumLength, required = false) {
  if (value == null) value = [];
  if (!Array.isArray(value) || value.length > maximumItems || (required && value.length === 0)) {
    fail(`${label} must contain ${required ? `1-${maximumItems}` : `0-${maximumItems}`} items`);
  }
  return value.map((item, index) => text(item, maximumLength, `${label}[${index}]`, true));
}

function enforceBytes(value, maximum, label) {
  const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (bytes > maximum) fail(`${label} exceeds ${maximum} bytes`);
  return bytes;
}

function normalizeBrief(value) {
  assertObject(value, 'scout brief');
  enforceBytes(value, MAX_BRIEF_BYTES, 'scout brief');
  rejectUnknown(value, ['version', 'purpose', 'targets', 'questions', 'constraints'], 'scout brief');
  if (value.version !== 1) fail('scout brief.version must be 1');
  const brief = {
    version: 1,
    purpose: text(value.purpose, 600, 'scout brief.purpose', true),
    targets: textList(value.targets, 'scout brief.targets', 12, 240, true),
    questions: textList(value.questions, 'scout brief.questions', 8, 300, true),
    constraints: textList(value.constraints, 'scout brief.constraints', 8, 300),
  };
  enforceBytes(brief, MAX_BRIEF_BYTES, 'normalized scout brief');
  return brief;
}

function evidenceFile(root, inputPath, label) {
  const rootPath = path.resolve(root);
  const candidate = text(inputPath, 300, `${label}.path`, true);
  const resolved = path.resolve(rootPath, candidate);
  if (resolved !== rootPath && !resolved.startsWith(`${rootPath}${path.sep}`)) {
    fail(`${label}.path must stay inside the repository root`);
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) fail(`${label}.path does not name an observed file`);
  return {
    resolved,
    relative: path.relative(rootPath, resolved).split(path.sep).join('/'),
  };
}

function fileLineCount(file) {
  const contents = fs.readFileSync(file, 'utf8');
  if (!contents) return 0;
  const lines = contents.split(/\r\n|\n|\r/).length;
  return /(?:\r\n|\n|\r)$/.test(contents) ? lines - 1 : lines;
}

function normalizeEvidencePacket(value, options = {}) {
  const root = path.resolve(options.root || process.cwd());
  assertObject(value, 'evidence packet');
  enforceBytes(value, MAX_PACKET_BYTES, 'evidence packet');
  rejectUnknown(value, ['version', 'summary', 'evidence', 'unknowns'], 'evidence packet');
  if (value.version !== 1) fail('evidence packet.version must be 1');
  if (!Array.isArray(value.evidence) || value.evidence.length > 20) fail('evidence packet.evidence must contain 0-20 items');

  const evidence = value.evidence.map((item, index) => {
    const label = `evidence packet.evidence[${index}]`;
    assertObject(item, label);
    rejectUnknown(item, ['kind', 'path', 'startLine', 'endLine', 'observation'], label);
    if (!EVIDENCE_KINDS.has(item.kind)) fail(`${label}.kind is unsupported`);
    const source = evidenceFile(root, item.path, label);
    const startLine = Number(item.startLine);
    const endLine = Number(item.endLine);
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
      fail(`${label} has an invalid line range`);
    }
    if (endLine - startLine + 1 > 12) fail(`${label} line range must contain at most 12 lines`);
    const lineCount = fileLineCount(source.resolved);
    if (endLine > lineCount) fail(`${label} is outside the observed file line range`);
    return {
      kind: item.kind,
      path: source.relative,
      startLine,
      endLine,
      observation: text(item.observation, 400, `${label}.observation`, true),
    };
  });
  const packet = {
    version: 1,
    summary: text(value.summary, 500, 'evidence packet.summary', true),
    evidence,
    unknowns: textList(value.unknowns, 'evidence packet.unknowns', 12, 300),
  };
  enforceBytes(packet, MAX_PACKET_BYTES, 'normalized evidence packet');
  return packet;
}

function buildScoutPrompt(brief) {
  return [
    'Act only as a repository evidence scout, not as a designer or implementation worker.',
    'Inspect the working repository read-only. Do not edit files, use the web, delegate, or propose architecture.',
    'Search before reading. Read only exact symbol ranges needed for the brief.',
    'Report only facts directly observed in repository files. Cite repository-relative paths and exact line ranges of at most 12 lines.',
    'If evidence is absent or ambiguous, add an unknown instead of inferring a capability.',
    'Return only the requested structured evidence packet.',
    `Scout brief: ${JSON.stringify(brief)}`,
  ].join('\n');
}

function buildRuntimeCommand({ runtime, root, prompt, model, effort, schemaPath, outputPath, schema }) {
  if (runtime === 'codex') {
    return {
      file: process.env.BRAINSTORM_SCOUT_CODEX_BIN || 'codex',
      args: [
        'exec', '--json', '--ephemeral', '--sandbox', 'read-only', '-C', root,
        '--skip-git-repo-check', '--model', model,
        '-c', `model_reasoning_effort="${effort}"`,
        '--output-schema', schemaPath,
        '--output-last-message', outputPath,
        prompt,
      ],
      cwd: root,
    };
  }
  if (runtime === 'claude') {
    return {
      file: process.env.BRAINSTORM_SCOUT_CLAUDE_BIN || 'claude',
      args: [
        '-p', prompt,
        '--output-format', 'json',
        '--no-session-persistence',
        '--permission-mode', 'dontAsk',
        '--disable-slash-commands',
        '--tools', 'Read,Glob,Grep',
        '--json-schema', JSON.stringify(schema),
        '--model', model,
        '--effort', effort,
      ],
      cwd: root,
    };
  }
  fail(`unsupported scout runtime ${runtime}`);
}

function parseOptions(values) {
  const options = {};
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (!flag?.startsWith('--') || value == null || value.startsWith('--')) fail(`invalid option ${flag || ''}`.trim());
    const key = flag.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    options[key] = value;
  }
  return options;
}

function parsePositiveInteger(value, label, fallback) {
  if (value == null) return fallback;
  if (!/^\d+$/.test(String(value)) || Number(value) < 1) fail(`${label} must be a positive integer`);
  return Number(value);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readJsonString(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

function parseWorkerPacket(runtime, stdout, rawOutput) {
  if (runtime === 'codex') return readJson(rawOutput);
  const envelope = readJsonString(stdout);
  const candidate = envelope?.structured_output || envelope?.result || envelope;
  if (typeof candidate === 'string') return readJsonString(candidate) || fail('Claude scout returned unstructured text');
  return candidate || fail('Claude scout returned no structured output');
}

function parseUsage(runtime, stdout) {
  if (runtime === 'codex') {
    const events = stdout.split(/\r?\n/).filter(Boolean).map(readJsonString).filter(Boolean);
    const usage = [...events].reverse().find(event => event.type === 'turn.completed')?.usage || {};
    return {
      input_tokens: usage.input_tokens || 0,
      cached_input_tokens: usage.cached_input_tokens || 0,
      output_tokens: usage.output_tokens || 0,
      reasoning_output_tokens: usage.reasoning_output_tokens || 0,
    };
  }
  const envelope = readJsonString(stdout) || {};
  const usage = envelope.usage || envelope.result?.usage || {};
  return {
    input_tokens: usage.input_tokens || usage.inputTokens || 0,
    cached_input_tokens: usage.cache_read_input_tokens || usage.cached_input_tokens || 0,
    output_tokens: usage.output_tokens || usage.outputTokens || 0,
    reasoning_output_tokens: usage.reasoning_tokens || 0,
  };
}

function sanitizeDiagnostic(value) {
  return String(value || '')
    .replace(/([?&\s]token=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function summarizeRuntimeFailure(runtime, stdout, stderr) {
  if (runtime === 'codex') {
    const events = stdout.split(/\r?\n/).filter(Boolean).map(readJsonString).filter(Boolean);
    const failed = [...events].reverse().find(event => event.type === 'turn.failed' || event.type === 'error');
    const observed = failed?.error?.message || failed?.message;
    if (observed) return sanitizeDiagnostic(observed);
  } else {
    const envelope = readJsonString(stdout);
    const observed = envelope?.error?.message
      || envelope?.error
      || envelope?.message
      || (envelope?.is_error ? envelope.result : '');
    if (observed) return sanitizeDiagnostic(observed);
  }
  return sanitizeDiagnostic(stderr) || 'no diagnostic returned';
}

function defaultOutput(root) {
  const scratch = path.resolve(process.env.CLAUDE_SCRATCH_DIR || path.join(os.homedir(), '.claude-scratch'));
  return path.join(scratch, path.basename(root), 'brainstorm', 'evidence', `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`);
}

function run(options) {
  if (!options.brief) fail('run requires --brief FILE');
  const root = path.resolve(options.root || process.cwd());
  const brief = normalizeBrief(readJson(path.resolve(options.brief)));
  const runtime = options.runtime || process.env.BRAINSTORM_SCOUT_RUNTIME || 'codex';
  if (!['codex', 'claude'].includes(runtime)) fail('runtime must be codex or claude');
  const defaultModel = runtime === 'codex'
    ? process.env.BRAINSTORM_SCOUT_CODEX_MODEL || process.env.PAIR_CODEX_LOW_MODEL || 'gpt-5.4-mini'
    : process.env.BRAINSTORM_SCOUT_CLAUDE_MODEL || process.env.PAIR_CLAUDE_LOW_MODEL || 'haiku';
  const model = options.model || defaultModel;
  if (!model || model === 'default') fail('evidence scout requires an explicit lower-tier model');
  const effort = options.effort || 'low';
  if (effort !== 'low') fail('evidence scout effort must be low');
  const timeoutMs = parsePositiveInteger(options.timeoutMs, 'timeout-ms', Number(process.env.BRAINSTORM_SCOUT_TIMEOUT_MS || 180_000));
  const output = path.resolve(options.output || defaultOutput(root));
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  const nonce = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const schemaPath = path.join(path.dirname(output), `.evidence-schema-${nonce}.json`);
  const rawOutput = path.join(path.dirname(output), `.evidence-worker-${nonce}.json`);
  fs.writeFileSync(schemaPath, `${JSON.stringify(EVIDENCE_PACKET_SCHEMA)}\n`, { mode: 0o600 });

  try {
    const command = buildRuntimeCommand({
      runtime,
      root,
      prompt: buildScoutPrompt(brief),
      model,
      effort,
      schemaPath,
      outputPath: rawOutput,
      schema: EVIDENCE_PACKET_SCHEMA,
    });
    const result = childProcess.spawnSync(command.file, command.args, {
      cwd: command.cwd,
      encoding: 'utf8',
      env: { ...process.env, PAIR_STOP_GATE: 'off', CLAUDE_STOP_GATE: 'off' },
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
    });
    if (result.error) fail(`scout process failed: ${result.error.message}`);
    if (result.status !== 0) {
      const diagnostic = summarizeRuntimeFailure(runtime, result.stdout || '', result.stderr || '');
      fail(`scout process exited ${result.status}${result.signal ? ` (${result.signal})` : ''}: ${diagnostic}`);
    }
    const packet = normalizeEvidencePacket(parseWorkerPacket(runtime, result.stdout || '', rawOutput), { root });
    atomicJson(output, packet);
    const metadata = {
      type: 'evidence.scouted',
      runtime,
      model,
      effort,
      output_file: output,
      output_bytes: Buffer.byteLength(JSON.stringify(packet), 'utf8'),
      evidence_count: packet.evidence.length,
      unknown_count: packet.unknowns.length,
      usage: parseUsage(runtime, result.stdout || ''),
    };
    console.log(JSON.stringify(metadata));
    return metadata;
  } finally {
    fs.rmSync(schemaPath, { force: true });
    fs.rmSync(rawOutput, { force: true });
  }
}

function main() {
  const [command, ...values] = process.argv.slice(2);
  if (!command || ['help', '--help', '-h'].includes(command)) {
    console.log([
      'Usage: evidence-scout.cjs run --brief FILE [--root DIR] [--output FILE]',
      '       [--runtime codex|claude] [--model MODEL] [--effort low] [--timeout-ms MS]',
    ].join('\n'));
    return;
  }
  if (command !== 'run') fail(`unsupported evidence scout command ${command}`);
  run(parseOptions(values));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`evidence-scout: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  EVIDENCE_PACKET_SCHEMA,
  MAX_BRIEF_BYTES,
  MAX_PACKET_BYTES,
  buildRuntimeCommand,
  buildScoutPrompt,
  normalizeBrief,
  normalizeEvidencePacket,
  parseUsage,
  summarizeRuntimeFailure,
};
