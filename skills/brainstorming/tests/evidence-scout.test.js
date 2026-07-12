const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  MAX_BRIEF_BYTES,
  MAX_PACKET_BYTES,
  buildRuntimeCommand,
  normalizeBrief,
  normalizeEvidencePacket,
  summarizeRuntimeFailure,
} = require('../scripts/evidence-scout.cjs');
const { createScratchDirectory } = require('./test-support');

const scoutCli = path.resolve(__dirname, '../scripts/evidence-scout.cjs');

test('Codex evidence scout is ephemeral, read-only, structured, and explicitly cheap', () => {
  const command = buildRuntimeCommand({
    runtime: 'codex',
    root: '/repo',
    prompt: 'inspect evidence',
    model: 'gpt-5.4-mini',
    effort: 'low',
    schemaPath: '/scratch/schema.json',
    outputPath: '/scratch/evidence.json',
  });

  assert.equal(command.file, 'codex');
  assert.deepEqual(command.args.slice(0, 6), [
    'exec', '--json', '--ephemeral', '--sandbox', 'read-only', '-C',
  ]);
  assert.ok(command.args.includes('gpt-5.4-mini'));
  assert.ok(command.args.includes('model_reasoning_effort="low"'));
  assert.ok(command.args.includes('--output-schema'));
  assert.ok(command.args.includes('--output-last-message'));
  assert.ok(!command.args.includes('workspace-write'));
});

test('Claude evidence scout is non-persistent and exposes only read-only repository tools', () => {
  const command = buildRuntimeCommand({
    runtime: 'claude',
    root: '/repo',
    prompt: 'inspect evidence',
    model: 'haiku',
    effort: 'low',
    schema: { type: 'object' },
  });

  assert.equal(command.file, 'claude');
  assert.ok(command.args.includes('--no-session-persistence'));
  assert.ok(command.args.includes('dontAsk'));
  assert.ok(command.args.includes('--disable-slash-commands'));
  assert.ok(command.args.includes('--tools'));
  assert.ok(command.args.includes('Read,Glob,Grep'));
  assert.ok(command.args.includes('haiku'));
  assert.ok(!command.args.includes('acceptEdits'));
  assert.ok(!command.args.includes('--disallowedTools'));
  assert.ok(!command.args.includes('Bash'));
});

test('scout brief and evidence packet enforce compact, observed, bounded input', t => {
  const root = createScratchDirectory(t, 'scout-validation');
  const source = path.join(root, 'src', 'Agent.cs');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, 'public sealed class Agent\n{\n}\n');

  const brief = normalizeBrief({
    version: 1,
    purpose: 'Find the existing agent creation capability.',
    targets: ['src/Agent.cs', 'Agent'],
    questions: ['Where is Agent constructed?'],
    constraints: ['Do not propose architecture.'],
  });
  assert.ok(Buffer.byteLength(JSON.stringify(brief)) <= MAX_BRIEF_BYTES);

  const packet = normalizeEvidencePacket({
    version: 1,
    summary: 'One relevant symbol was observed.',
    evidence: [{
      kind: 'symbol',
      path: 'src/Agent.cs',
      startLine: 1,
      endLine: 3,
      observation: 'Agent is a sealed class.',
    }],
    unknowns: ['No construction caller was observed.'],
  }, { root });
  assert.ok(Buffer.byteLength(JSON.stringify(packet)) <= MAX_PACKET_BYTES);

  assert.throws(() => normalizeEvidencePacket({
    ...packet,
    evidence: [{ ...packet.evidence[0], endLine: 4 }],
  }, { root }), /outside.*line range/i);

  assert.throws(() => normalizeBrief({
    ...brief,
    purpose: 'x'.repeat(MAX_BRIEF_BYTES + 1),
  }), /at most|exceeds/i);
});

test('evidence scout runs a bounded worker process and emits only compact metadata', t => {
  const scratch = createScratchDirectory(t, 'scout-integration');
  const root = path.join(scratch, 'repo');
  const source = path.join(root, 'src', 'Agent.cs');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, 'public sealed class Agent\n{\n}\n');

  const briefFile = path.join(scratch, 'brief.json');
  const outputFile = path.join(scratch, 'evidence.json');
  fs.writeFileSync(briefFile, JSON.stringify({
    version: 1,
    purpose: 'Locate the existing Agent capability.',
    targets: ['src/Agent.cs'],
    questions: ['What already exists?'],
    constraints: [],
  }));

  const fakeCodex = path.join(scratch, 'fake-codex.cjs');
  fs.writeFileSync(fakeCodex, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (!args.includes('--ephemeral') || !args.includes('read-only') || !args.includes('gpt-5.4-mini')) process.exit(41);
const output = args[args.indexOf('--output-last-message') + 1];
fs.writeFileSync(output, JSON.stringify({
  version: 1,
  summary: 'Observed one existing type.',
  evidence: [{ kind: 'symbol', path: 'src/Agent.cs', startLine: 1, endLine: 3, observation: 'Agent is sealed.' }],
  unknowns: []
}));
process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 120, cached_input_tokens: 80, output_tokens: 30, reasoning_output_tokens: 5 } }) + '\\n');
`, { mode: 0o700 });

  const result = childProcess.spawnSync(process.execPath, [
    scoutCli,
    'run',
    '--brief', briefFile,
    '--root', root,
    '--output', outputFile,
    '--runtime', 'codex',
    '--model', 'gpt-5.4-mini',
    '--effort', 'low',
    '--timeout-ms', '5000',
  ], {
    encoding: 'utf8',
    env: { ...process.env, BRAINSTORM_SCOUT_CODEX_BIN: fakeCodex },
  });

  assert.equal(result.status, 0, result.stderr);
  const metadata = JSON.parse(result.stdout);
  assert.equal(metadata.type, 'evidence.scouted');
  assert.equal(metadata.model, 'gpt-5.4-mini');
  assert.equal(metadata.usage.input_tokens, 120);
  assert.ok(metadata.output_bytes <= MAX_PACKET_BYTES);
  assert.doesNotMatch(result.stdout, /Agent is sealed/);
  assert.equal(JSON.parse(fs.readFileSync(outputFile, 'utf8')).evidence[0].path, 'src/Agent.cs');
});

test('evidence scout accepts Claude structured output through the read-only tool allowlist', t => {
  const scratch = createScratchDirectory(t, 'scout-claude-integration');
  const root = path.join(scratch, 'repo');
  const source = path.join(root, 'src', 'Agent.cs');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, 'public sealed class Agent\n{\n}\n');

  const briefFile = path.join(scratch, 'brief.json');
  const outputFile = path.join(scratch, 'evidence.json');
  fs.writeFileSync(briefFile, JSON.stringify({
    version: 1,
    purpose: 'Locate the existing Agent capability.',
    targets: ['src/Agent.cs'],
    questions: ['What already exists?'],
    constraints: [],
  }));

  const fakeClaude = path.join(scratch, 'fake-claude.cjs');
  fs.writeFileSync(fakeClaude, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (!args.includes('--tools') || !args.includes('Read,Glob,Grep') || args.includes('--disallowedTools')) process.exit(42);
process.stdout.write(JSON.stringify({
  structured_output: {
    version: 1,
    summary: 'Observed one existing type.',
    evidence: [{ kind: 'symbol', path: 'src/Agent.cs', startLine: 1, endLine: 3, observation: 'Agent is sealed.' }],
    unknowns: []
  },
  usage: { input_tokens: 90, cache_read_input_tokens: 50, output_tokens: 20 }
}));
`, { mode: 0o700 });

  const result = childProcess.spawnSync(process.execPath, [
    scoutCli,
    'run',
    '--brief', briefFile,
    '--root', root,
    '--output', outputFile,
    '--runtime', 'claude',
    '--model', 'haiku',
    '--effort', 'low',
    '--timeout-ms', '5000',
  ], {
    encoding: 'utf8',
    env: { ...process.env, BRAINSTORM_SCOUT_CLAUDE_BIN: fakeClaude },
  });

  assert.equal(result.status, 0, result.stderr);
  const metadata = JSON.parse(result.stdout);
  assert.equal(metadata.runtime, 'claude');
  assert.equal(metadata.model, 'haiku');
  assert.equal(metadata.usage.input_tokens, 90);
  assert.equal(metadata.usage.cached_input_tokens, 50);
  assert.equal(JSON.parse(fs.readFileSync(outputFile, 'utf8')).evidence[0].path, 'src/Agent.cs');
});

test('Codex worker failures surface the observed cause without dumping raw events', () => {
  const stdout = [
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
    JSON.stringify({ type: 'error', message: 'You have hit your usage limit. token=secret-value' }),
    JSON.stringify({ type: 'turn.failed', error: { message: 'You have hit your usage limit. token=secret-value' } }),
  ].join('\n');

  const message = summarizeRuntimeFailure('codex', stdout, 'unrelated stderr');
  assert.match(message, /usage limit/i);
  assert.match(message, /token=\[redacted\]/);
  assert.doesNotMatch(message, /thread-1|secret-value/);
});

test('Claude worker failures surface the structured API error', () => {
  const stdout = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: true,
    result: 'You have hit your session limit.',
    session_id: 'do-not-print',
  });

  const message = summarizeRuntimeFailure('claude', stdout, '');
  assert.match(message, /session limit/i);
  assert.doesNotMatch(message, /do-not-print/);
});
