const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createScratchDirectory } = require('./test-support');

const repositoryRoot = path.resolve(__dirname, '../../..');
const installer = path.join(repositoryRoot, 'scripts/install-runtime.js');
const runtimePilot = path.join(repositoryRoot, 'skills/brainstorming/scripts/runtime-pilot.cjs');
const CLAUDE_SERVER = 'visual-companion-channel';
const CODEX_SERVER = 'visual-companion-feedback';
const CODEX_ACTIVE_ENTRYPOINT = 'skills/brainstorming/scripts/visual-mcp-server.mjs';
const CODEX_IDLE_ADAPTER = 'skills/brainstorming/scripts/codex-app-server-adapter.cjs';
const CLAUDE_ENTRYPOINT = 'skills/brainstorming/scripts/claude-channel-server.mjs';
const PRIVATE_TOKEN = 'runtime-registration-private-token';
const PRIVATE_CONVERSATION = 'runtime-registration-private-conversation-content';

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8'));
}

function run(command, args, options = {}) {
  return childProcess.spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, ...options.env },
  });
}

function runNode(args, options = {}) {
  return run(process.execPath, args, options);
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function fileDigest(file) {
  return digest(fs.readFileSync(file));
}

function parseJsonOutput(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.ok(result.stdout.trim(), 'command must return JSON diagnostics on stdout');
  return JSON.parse(result.stdout);
}

function assertRegistrationSecretSafe(value) {
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, new RegExp(PRIVATE_TOKEN, 'u'));
  assert.doesNotMatch(serialized, new RegExp(PRIVATE_CONVERSATION, 'u'));
}

function createConfigSandbox(t, purpose) {
  const home = createScratchDirectory(t, purpose);
  const codexHome = path.join(home, '.codex');
  const claudeHome = path.join(home, '.claude');
  fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  fs.mkdirSync(claudeHome, { recursive: true, mode: 0o700 });
  const codexConfig = path.join(codexHome, 'config.toml');
  const claudeSettings = path.join(claudeHome, 'settings.json');
  const claudeState = path.join(home, '.claude.json');
  fs.writeFileSync(codexConfig, '# user sentinel\nmodel = "user-choice"\n', { mode: 0o600 });
  fs.writeFileSync(claudeSettings, '{"model":"user-choice"}\n', { mode: 0o600 });
  fs.writeFileSync(claudeState, '{"userState":"preserve"}\n', { mode: 0o600 });
  const files = [codexConfig, claudeSettings, claudeState];
  return {
    env: {
      HOME: home,
      CODEX_HOME: codexHome,
      CLAUDE_HOME: claudeHome,
      BRAINSTORM_CAPABILITY_TOKEN: PRIVATE_TOKEN,
      TEST_CONVERSATION_CONTENT: PRIVATE_CONVERSATION,
    },
    files,
    before: new Map(files.map(file => [file, fileDigest(file)])),
  };
}

function assertConfigSandboxUnchanged(sandbox) {
  for (const file of sandbox.files) {
    assert.equal(fileDigest(file), sandbox.before.get(file), `${file} must not change during dry-run/check-only`);
  }
}

function findRuntimeOperation(operations, runtime, pathField, runtimePath) {
  return operations.find(operation => operation.runtime === runtime
    && typeof operation[pathField] === 'string'
    && operation[pathField].replaceAll('\\', '/').endsWith(runtimePath));
}

function runtimeSurfaceProbe(command, capabilityPatterns) {
  const version = run(command, ['--version']);
  if (version.error?.code === 'ENOENT') {
    return { installed: false, version: null, surfaceSupported: false };
  }
  assert.equal(version.status, 0, version.stderr);
  const help = run(command, ['--help']);
  assert.equal(help.status, 0, help.stderr);
  const helpText = `${help.stdout}\n${help.stderr}`;
  return {
    installed: true,
    version: version.stdout.trim().match(/\d+\.\d+\.\d+/u)?.[0] ?? null,
    surfaceSupported: capabilityPatterns.every(pattern => pattern.test(helpText)),
  };
}

function claudeRuntimeSurfaceProbe() {
  const version = run('claude', ['--version']);
  if (version.error?.code === 'ENOENT') {
    return { installed: false, version: null, surfaceSupported: false };
  }
  assert.equal(version.status, 0, version.stderr);
  const target = 'plugin:runtime-probe@runtime-probe';
  const probes = [
    run('claude', ['--channels', target, '--version']),
    run('claude', ['--dangerously-load-development-channels', target, '--version']),
  ];
  return {
    installed: true,
    version: version.stdout.trim().match(/\d+\.\d+\.\d+/u)?.[0] ?? null,
    surfaceSupported: probes.every(probe => probe.status === 0),
  };
}

test('Claude plugin registers its stdio Channel and active MCP entrypoints and binds them through the manifest', () => {
  const mcpFile = path.join(repositoryRoot, '.mcp.json');
  assert.equal(fs.existsSync(mcpFile), true, 'Claude plugin root must contain .mcp.json');
  const mcp = JSON.parse(fs.readFileSync(mcpFile, 'utf8'));
  const server = mcp.mcpServers?.[CLAUDE_SERVER];
  assert.deepEqual(server, {
    command: 'node',
    args: [`${'${CLAUDE_PLUGIN_ROOT}'}/${CLAUDE_ENTRYPOINT}`],
  });
  // Claude also registers the blocking wait_for_feedback MCP server, so the primary wake boundary
  // works in-turn on Claude Code rather than collapsing to CLI wait.
  const feedbackServer = mcp.mcpServers?.[CODEX_SERVER];
  assert.deepEqual(feedbackServer, {
    command: 'node',
    args: [`${'${CLAUDE_PLUGIN_ROOT}'}/${CODEX_ACTIVE_ENTRYPOINT}`],
  });

  const plugin = readJson('.claude-plugin/plugin.json');
  assert.ok(Array.isArray(plugin.channels), 'plugin manifest must declare its Channel binding');
  assert.deepEqual(plugin.channels, [{ server: CLAUDE_SERVER }]);
  assertRegistrationSecretSafe({ mcp, channels: plugin.channels });
});

test('runtime asset manifest wires Codex active and idle delivery plus the Claude Channel', () => {
  const manifest = readJson('metadata/runtime-asset-map.json');
  const codexDelivery = manifest.runtimes.codex.delivery;
  assert.equal(typeof codexDelivery, 'object');
  assert.equal(typeof codexDelivery.active, 'object');
  assert.equal(typeof codexDelivery.idle, 'object');
  assert.equal(codexDelivery.active.registration, 'mcp');
  assert.equal(codexDelivery.active.server, CODEX_SERVER);
  assert.equal(codexDelivery.active.entrypoint, CODEX_ACTIVE_ENTRYPOINT);
  assert.equal(codexDelivery.active.capability, 'wait_for_feedback');
  assert.equal(codexDelivery.active.tool_timeout_sec, 900);
  assert.equal(codexDelivery.idle.registration, 'app_server');
  assert.equal(codexDelivery.idle.adapter, CODEX_IDLE_ADAPTER);
  assert.deepEqual(codexDelivery.idle.methods, ['thread/resume', 'turn/start']);

  const claudeDelivery = manifest.runtimes.claude.delivery;
  assert.equal(typeof claudeDelivery, 'object');
  assert.equal(typeof claudeDelivery.active, 'object');
  assert.equal(claudeDelivery.active.registration, 'mcp');
  assert.equal(claudeDelivery.active.server, CODEX_SERVER);
  assert.equal(claudeDelivery.active.entrypoint, CODEX_ACTIVE_ENTRYPOINT);
  assert.equal(claudeDelivery.active.capability, 'wait_for_feedback');
  assert.equal(claudeDelivery.active.tool_timeout_sec, 900);
  assert.equal(typeof claudeDelivery.channel, 'object');
  assert.equal(claudeDelivery.channel.registration, 'channel');
  assert.equal(claudeDelivery.channel.server, CLAUDE_SERVER);
  assert.equal(claudeDelivery.channel.entrypoint, CLAUDE_ENTRYPOINT);
  assert.equal(claudeDelivery.channel.capability, 'claude/channel');
  assert.equal(claudeDelivery.channel.notification, 'notifications/claude/channel');
  assert.equal(claudeDelivery.channel.acknowledgement_tool, 'ack_feedback');

  const assets = Object.values(manifest.assets);
  const codexActiveAsset = assets.find(asset => asset.canonical_file === CODEX_ACTIVE_ENTRYPOINT);
  const codexIdleAsset = assets.find(asset => asset.canonical_file === CODEX_IDLE_ADAPTER);
  const claudeAsset = assets.find(asset => asset.canonical_file === CLAUDE_ENTRYPOINT);
  assert.equal(codexActiveAsset?.type, 'runtime_entrypoint');
  assert.deepEqual(codexActiveAsset?.supported_runtimes, ['codex', 'claude']);
  assert.equal(codexIdleAsset?.type, 'runtime_adapter');
  assert.deepEqual(codexIdleAsset?.supported_runtimes, ['codex']);
  assert.equal(claudeAsset?.type, 'runtime_entrypoint');
  assert.deepEqual(claudeAsset?.supported_runtimes, ['claude']);
  assertRegistrationSecretSafe({ codex: codexDelivery, claude: claudeDelivery });
});

test('generated runtime support table lists the manifest asset types for every runtime', () => {
  const manifest = readJson('metadata/runtime-asset-map.json');
  const readme = fs.readFileSync(path.join(repositoryRoot, 'README.md'), 'utf8');
  const table = readme.match(
    /<!-- BEGIN GENERATED:runtime-support -->([\s\S]*?)<!-- END GENERATED:runtime-support -->/u,
  )?.[1];
  assert.ok(table, 'README must contain the generated runtime support table');

  for (const [runtime, definition] of Object.entries(manifest.runtimes)) {
    const row = table.split('\n').find(line => line.startsWith(`| ${definition.display_name} |`));
    assert.ok(row, `${runtime} must have a generated runtime support row`);
    const expectedTypes = [...new Set(Object.values(manifest.assets)
      .filter(asset => asset.supported_runtimes?.includes(runtime))
      .map(asset => asset.type))].sort();
    for (const type of expectedTypes) {
      assert.equal(row.includes(`\`${type}\``), true, `${runtime} must list ${type}`);
    }
  }
});

for (const registration of [
  {
    runtime: 'codex',
    label: 'active MCP',
    registration: 'mcp',
    pathField: 'entrypoint',
    runtimePath: CODEX_ACTIVE_ENTRYPOINT,
    capability: 'wait_for_feedback',
  },
  {
    runtime: 'codex',
    label: 'idle App Server',
    registration: 'app_server',
    pathField: 'adapter',
    runtimePath: CODEX_IDLE_ADAPTER,
    methods: ['thread/resume', 'turn/start'],
  },
  {
    runtime: 'claude',
    label: 'Channel',
    registration: 'channel',
    pathField: 'entrypoint',
    runtimePath: CLAUDE_ENTRYPOINT,
    capability: 'claude/channel',
  },
  {
    runtime: 'claude',
    label: 'active MCP',
    registration: 'mcp',
    pathField: 'entrypoint',
    runtimePath: CODEX_ACTIVE_ENTRYPOINT,
    capability: 'wait_for_feedback',
  },
]) {
  test(`${registration.runtime} ${registration.label} registration dry-run declares wiring without mutating user configs`, t => {
    const sandbox = createConfigSandbox(t, `runtime-registration-${registration.runtime}`);
    const result = runNode([
      installer,
      '--runtime', registration.runtime,
      '--scope', 'global',
      '--dry-run',
      '--json',
    ], { env: sandbox.env });
    const output = parseJsonOutput(result);
    const operation = findRuntimeOperation(
      output.operations,
      registration.runtime,
      registration.pathField,
      registration.runtimePath,
    );
    assert.ok(operation, `${registration.runtime} dry-run must declare its ${registration.label} delivery path`);
    assert.equal(operation.registration, registration.registration);
    if (registration.capability) assert.equal(operation.capability, registration.capability);
    if (registration.methods) assert.deepEqual(operation.methods, registration.methods);
    assert.equal(operation.dry_run, true);
    assertRegistrationSecretSafe(output);
    assertConfigSandboxUnchanged(sandbox);
  });
}

test('runtime check-only separates CLI surface support from unprobed delivery readiness', t => {
  const sandbox = createConfigSandbox(t, 'runtime-registration-check-only');
  const codex = runtimeSurfaceProbe('codex', [/app-server/u]);
  const claude = claudeRuntimeSurfaceProbe();
  const result = runNode([runtimePilot, '--check-only'], { env: sandbox.env });
  const output = parseJsonOutput(result);
  assert.equal(output.version, 1);
  assert.equal(output.mode, 'check-only');
  assert.equal(output.runtimes.codex.installed, codex.installed);
  assert.equal(output.runtimes.codex.version, codex.version);
  assert.equal(
    output.runtimes.codex.capability_state,
    codex.surfaceSupported ? 'supported' : 'unsupported',
  );
  assert.equal(output.runtimes.codex.delivery_state, 'queued');
  assert.equal(
    output.runtimes.codex.reason_code,
    codex.surfaceSupported ? 'not_probed' : (codex.installed ? 'missing_app_server' : 'not_installed'),
  );
  assert.equal(output.runtimes.claude.installed, claude.installed);
  assert.equal(output.runtimes.claude.version, claude.version);
  assert.equal(
    output.runtimes.claude.capability_state,
    claude.surfaceSupported ? 'supported' : 'unsupported',
  );
  assert.equal(output.runtimes.claude.delivery_state, 'queued');
  assert.equal(
    output.runtimes.claude.reason_code,
    claude.surfaceSupported ? 'not_probed' : (claude.installed ? 'missing_channel_flags' : 'not_installed'),
  );
  assertRegistrationSecretSafe(output);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(`${PRIVATE_TOKEN}|${PRIVATE_CONVERSATION}`, 'u'));
  assertConfigSandboxUnchanged(sandbox);
});

test('generated asset validation and runtime install listing include active, idle, and Channel delivery paths', () => {
  const generated = runNode(['scripts/generate-runtime-assets.js', '--check']);
  assert.equal(generated.status, 0, generated.stderr || generated.stdout);

  for (const [runtime, entrypoint] of [
    ['codex', CODEX_ACTIVE_ENTRYPOINT],
    ['codex', CODEX_IDLE_ADAPTER],
    ['claude', CLAUDE_ENTRYPOINT],
    ['claude', CODEX_ACTIVE_ENTRYPOINT],
  ]) {
    const listed = parseJsonOutput(runNode([
      installer,
      'list',
      '--runtime', runtime,
      '--scope', 'global',
      '--json',
    ]));
    assert.ok(
      listed.assets.some(asset => asset.canonical_file === entrypoint
        && asset.supported_runtimes.includes(runtime)),
      `${runtime} install listing must package ${entrypoint}`,
    );
  }
});
