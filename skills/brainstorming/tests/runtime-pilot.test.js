const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createScratchDirectory } = require('./test-support');

const repositoryRoot = path.resolve(__dirname, '../../..');
const runtimePilot = path.join(repositoryRoot, 'skills/brainstorming/scripts/runtime-pilot.cjs');
const visualMcpServer = path.join(repositoryRoot, 'skills/brainstorming/scripts/visual-mcp-server.mjs');
const claudeChannelServer = path.join(repositoryRoot, 'skills/brainstorming/scripts/claude-channel-server.mjs');
const PRIVATE_TOKEN = 'runtime-pilot-private-capability-token';
const PRIVATE_CONTENT = 'runtime-pilot-private-conversation-content';

function writeExecutable(file, source) {
  fs.writeFileSync(file, source, { mode: 0o700 });
  fs.chmodSync(file, 0o700);
}

function createRuntimeBins(t) {
  const directory = createScratchDirectory(t, 'runtime-pilot-bins');
  const codex = path.join(directory, 'codex');
  const claude = path.join(directory, 'claude');
  writeExecutable(codex, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') console.log('codex-cli 9.8.7');
else if (args[0] === 'app-server' && args.includes('--help')) console.log('Run Codex App Server');
else process.exitCode = 2;
`);
  writeExecutable(claude, `#!/usr/bin/env node
if (process.argv.includes('--version')) console.log('7.6.5 (Claude Code)');
else process.exitCode = 2;
`);
  return { claude, codex };
}

function pilotEnv(bins, extra = {}) {
  return {
    ...process.env,
    VISUAL_COMPANION_CODEX_BIN: bins.codex,
    VISUAL_COMPANION_CLAUDE_BIN: bins.claude,
    BRAINSTORM_CAPABILITY_TOKEN: PRIVATE_TOKEN,
    TEST_CONVERSATION_CONTENT: PRIVATE_CONTENT,
    CODEX_THREAD_ID: '',
    CLAUDE_SESSION_ID: '',
    ...extra,
  };
}

function runPilot(args, env) {
  return require('node:child_process').spawnSync(process.execPath, [runtimePilot, ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env,
  });
}

function parseSuccessfulJson(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.ok(result.stdout.trim());
  return JSON.parse(result.stdout);
}

function assertSecretSafe(value) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  assert.doesNotMatch(serialized, new RegExp(`${PRIVATE_TOKEN}|${PRIVATE_CONTENT}`, 'u'));
}

test('check-only reports deterministic installed capability surfaces without probing delivery or writing evidence', t => {
  const bins = createRuntimeBins(t);
  const evidence = path.join(createScratchDirectory(t, 'runtime-pilot-check'), 'must-not-exist.json');
  const output = parseSuccessfulJson(runPilot(['--check-only'], pilotEnv(bins, {
    VISUAL_COMPANION_EVIDENCE_FILE: evidence,
  })));

  assert.equal(output.version, 1);
  assert.equal(output.mode, 'check-only');
  assert.deepEqual(output.runtimes.codex, {
    installed: true,
    version: '9.8.7',
    capability_state: 'supported',
    delivery_state: 'queued',
    reason_code: 'not_probed',
  });
  assert.deepEqual(output.runtimes.claude, {
    installed: true,
    version: '7.6.5',
    capability_state: 'supported',
    delivery_state: 'queued',
    reason_code: 'not_probed',
  });
  assert.equal(fs.existsSync(evidence), false);
  assertSecretSafe(`${output}\n${JSON.stringify(output)}`);
});

test('installed-supported pilot persists only capability, delivery, acknowledgement, version, and timestamp evidence', t => {
  const bins = createRuntimeBins(t);
  const evidence = path.join(createScratchDirectory(t, 'runtime-pilot-evidence'), 'runtime-delivery-pilot.json');
  const result = runPilot([
    '--run-installed-supported',
    '--evidence', evidence,
  ], pilotEnv(bins));
  const output = parseSuccessfulJson(result);
  const record = JSON.parse(fs.readFileSync(evidence, 'utf8'));

  assert.equal(output.mode, 'run-installed-supported');
  assert.equal(output.evidence_id, 'EVD-002-runtime-delivery-pilot');
  assert.deepEqual(Object.keys(output).sort(), ['evidence_id', 'mode', 'version']);
  assert.deepEqual(Object.keys(record).sort(), [
    'acceptance_criteria',
    'decision_record_ids',
    'id',
    'kind',
    'recorded_at',
    'result',
    'schema',
    'source',
    'work_id',
  ]);
  assert.equal(record.schema, 1);
  assert.equal(record.id, 'EVD-002-runtime-delivery-pilot');
  assert.equal(record.work_id, 'work-20260712-visual-companion-vnext');
  assert.equal(record.kind, 'runtime-delivery-pilot');
  assert.deepEqual(record.acceptance_criteria, ['AC-10', 'AC-12']);
  assert.deepEqual(record.decision_record_ids, ['DR-001-visual-companion-vnext']);
  assert.deepEqual(Object.keys(record.result).sort(), ['runtimes', 'version']);

  for (const runtime of ['codex', 'claude']) {
    const runtimeResult = record.result.runtimes[runtime];
    assert.deepEqual(Object.keys(runtimeResult).sort(), [
      'acknowledgement_state',
      'capability_state',
      'checked_at',
      'delivery_state',
      'reason_code',
      'version',
    ]);
    assert.equal(runtimeResult.capability_state, 'supported');
    assert.equal(runtimeResult.delivery_state, 'queued');
    assert.equal(runtimeResult.acknowledgement_state, 'not_applicable');
    assert.match(runtimeResult.checked_at, /^\d{4}-\d{2}-\d{2}T/u);
  }
  assertSecretSafe(`${result.stdout}\n${result.stderr}\n${JSON.stringify(record)}`);
  assert.doesNotMatch(JSON.stringify(record), /(?:token|content|conversation|session|thread|prompt|command|path)/iu);
});

async function connectStaticEntrypoint(t, entrypoint) {
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/stdio.js'),
  ]);
  const scratch = createScratchDirectory(t, 'runtime-static-entrypoint');
  const project = path.join(scratch, 'project');
  fs.mkdirSync(project, { recursive: true });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entrypoint],
    cwd: project,
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: project,
      CLAUDE_SCRATCH_DIR: scratch,
      BRAINSTORM_CAPABILITY_TOKEN: PRIVATE_TOKEN,
    },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += chunk.toString('utf8'); });
  const client = new Client(
    { name: 'runtime-static-entrypoint-test', version: '1.0.0' },
    { capabilities: {} },
  );
  t.after(async () => {
    await client.close().catch(() => {});
    assertSecretSafe(stderr);
    assert.doesNotMatch(stderr, new RegExp(scratch.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  });
  await client.connect(transport, { timeout: 2_000 });
  return client;
}

test('registered active MCP entrypoint starts before a Visual Session exists', async t => {
  const client = await connectStaticEntrypoint(t, visualMcpServer);
  const listed = await client.listTools({}, { timeout: 2_000 });
  assert.ok(listed.tools.some(tool => tool.name === 'wait_for_feedback'));
  const result = await client.callTool(
    { name: 'wait_for_feedback', arguments: { timeoutMs: 0 } },
    undefined,
    { timeout: 2_000 },
  );
  assert.equal(result.structuredContent.state, 'closed');
  assert.equal(result.structuredContent.reason, 'no active Visual Session');
});

test('registered Claude Channel entrypoint starts before a Visual Session exists', async t => {
  const client = await connectStaticEntrypoint(t, claudeChannelServer);
  assert.deepEqual(client.getServerCapabilities().experimental, { 'claude/channel': {} });
  const listed = await client.listTools({}, { timeout: 2_000 });
  assert.ok(listed.tools.some(tool => tool.name === 'ack_feedback'));
});

test('Visual Session owns Codex idle delivery and retries a queued active thread until delivery', async t => {
  const { SessionStore } = require('../scripts/session-store.cjs');
  const { startCodexIdleDelivery } = require('../scripts/visual-session.cjs');
  assert.equal(typeof startCodexIdleDelivery, 'function');
  const stateDir = createScratchDirectory(t, 'runtime-codex-idle-worker');
  const store = new SessionStore(stateDir);
  let attempts = 0;
  const adapter = {
    capability: () => ({ supported: true, reason: null }),
    deliver: async () => {
      attempts += 1;
      return attempts === 1
        ? { state: 'queued', reason: 'thread active' }
        : { state: 'delivered', reason: null };
    },
    close: async () => {},
  };
  const worker = await startCodexIdleDelivery({
    adapter,
    conversationId: 'codex-thread-runtime-pilot',
    sessionId: 'visual-session-runtime-pilot',
    sessionStore: store,
    stateDir,
  });
  t.after(() => worker.close());

  store.appendBrowserTurn({
    clientTurnId: 'runtime-idle-feedback',
    message: PRIVATE_CONTENT,
    screen: { id: 'runtime-screen', file: 'screen.json' },
  });
  const deadline = Date.now() + 2_000;
  let record;
  while (Date.now() < deadline) {
    const ledgerFile = path.join(stateDir, 'agent-delivery-ledger.json');
    if (fs.existsSync(ledgerFile)) {
      const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
      record = ledger.deliveries[0];
    }
    if (record?.state === 'delivered') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(record?.state, 'delivered');
  assert.equal(attempts, 2);
  assert.doesNotMatch(
    fs.readFileSync(path.join(stateDir, 'agent-delivery-ledger.json'), 'utf8'),
    new RegExp(PRIVATE_CONTENT, 'u'),
  );
});
