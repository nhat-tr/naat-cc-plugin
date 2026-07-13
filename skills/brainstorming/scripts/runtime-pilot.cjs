#!/usr/bin/env node

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const WORK_ID = 'work-20260712-visual-companion-vnext';
const EVIDENCE_ID = 'EVD-002-runtime-delivery-pilot';
const DECISION_RECORD_ID = 'DR-001-visual-companion-vnext';

function safeChildEnvironment() {
  const allowed = [
    'PATH', 'HOME', 'CODEX_HOME', 'CLAUDE_HOME', 'TMPDIR', 'LANG', 'LC_ALL',
    'TERM', 'USER', 'LOGNAME', 'SHELL', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
  ];
  return Object.fromEntries(allowed
    .filter(key => typeof process.env[key] === 'string')
    .map(key => [key, process.env[key]]));
}

function run(binary, args, options = {}) {
  return childProcess.spawnSync(binary, args, {
    cwd: options.cwd || process.cwd(),
    encoding: 'utf8',
    env: safeChildEnvironment(),
    timeout: options.timeoutMs || 5_000,
    maxBuffer: 128 * 1024,
  });
}

function versionFrom(value) {
  return String(value || '').match(/\d+\.\d+\.\d+/u)?.[0] ?? null;
}

function notInstalled(result) {
  return result.error?.code === 'ENOENT' || result.status === null;
}

function probeCodex(binary) {
  const version = run(binary, ['--version']);
  if (notInstalled(version) || version.status !== 0) {
    return { installed: false, version: null, supported: false, reason: 'not_installed' };
  }
  const help = run(binary, ['app-server', '--help']);
  const supported = help.status === 0 && /app[ -]server/iu.test(`${help.stdout}\n${help.stderr}`);
  return {
    installed: true,
    version: versionFrom(version.stdout),
    supported,
    reason: supported ? 'not_probed' : 'missing_app_server',
  };
}

function probeClaude(binary) {
  const version = run(binary, ['--version']);
  if (notInstalled(version) || version.status !== 0) {
    return { installed: false, version: null, supported: false, reason: 'not_installed' };
  }
  const target = 'plugin:runtime-probe@runtime-probe';
  const channel = run(binary, ['--channels', target, '--version']);
  const development = run(binary, ['--dangerously-load-development-channels', target, '--version']);
  const supported = channel.status === 0 && development.status === 0;
  return {
    installed: true,
    version: versionFrom(version.stdout),
    supported,
    reason: supported ? 'not_probed' : 'missing_channel_flags',
  };
}

function probeRuntimes() {
  const codexBinary = process.env.VISUAL_COMPANION_CODEX_BIN || 'codex';
  const claudeBinary = process.env.VISUAL_COMPANION_CLAUDE_BIN || 'claude';
  return {
    codex: probeCodex(codexBinary),
    claude: probeClaude(claudeBinary),
  };
}

function checkOnlyResult(probes) {
  return {
    version: 1,
    mode: 'check-only',
    runtimes: Object.fromEntries(Object.entries(probes).map(([runtime, probe]) => [runtime, {
      installed: probe.installed,
      version: probe.version,
      capability_state: probe.supported ? 'supported' : 'unsupported',
      delivery_state: 'queued',
      reason_code: probe.reason,
    }])),
  };
}

function safePilotReason(value, fallback) {
  if (value === 'thread active') return 'target_busy';
  if (value === 'thread notLoaded') return 'target_not_loaded';
  if (value === 'thread systemError') return 'target_error';
  return fallback;
}

async function pilotCodex(probe, binary) {
  if (!probe.supported) {
    return { delivery: 'queued', acknowledgement: 'not_applicable', reason: probe.reason };
  }
  const threadId = process.env.VISUAL_COMPANION_PILOT_THREAD_ID;
  if (process.env.VISUAL_COMPANION_ALLOW_LIVE_DELIVERY !== '1'
    || typeof threadId !== 'string' || !threadId.trim()) {
    return { delivery: 'queued', acknowledgement: 'not_applicable', reason: 'no_open_target' };
  }
  const { CodexAppServerAdapter } = require('./codex-app-server-adapter.cjs');
  const adapter = new CodexAppServerAdapter({ command: binary, args: ['app-server'] });
  try {
    const result = await adapter.deliver({
      deliveryId: `delivery-${crypto.createHash('sha256').update('runtime-pilot').digest('hex').slice(0, 32)}`,
      conversationId: threadId,
      feedbackBatch: {
        id: 'runtime-pilot-feedback',
        seq: 1,
        type: 'user.turn',
        message: 'Visual Companion runtime delivery pilot.',
        annotations: [],
        choices: [],
      },
    });
    return result.state === 'delivered'
      ? { delivery: 'delivered', acknowledgement: 'not_applicable', reason: 'turn_started' }
      : {
        delivery: 'queued',
        acknowledgement: 'not_applicable',
        reason: safePilotReason(result.reason, 'target_unavailable'),
      };
  } catch {
    return { delivery: 'queued', acknowledgement: 'not_applicable', reason: 'target_unavailable' };
  } finally {
    await adapter.close();
  }
}

function pilotClaude(probe) {
  if (!probe.supported) {
    return { delivery: 'queued', acknowledgement: 'not_applicable', reason: probe.reason };
  }
  // A Channel is injected only by an already-open Claude host. This standalone
  // pilot can verify installed flag support but must not impersonate that host.
  return { delivery: 'queued', acknowledgement: 'not_applicable', reason: 'no_open_target' };
}

async function buildEvidence(probes, checkedAt) {
  const codexBinary = process.env.VISUAL_COMPANION_CODEX_BIN || 'codex';
  const outcomes = {
    codex: await pilotCodex(probes.codex, codexBinary),
    claude: pilotClaude(probes.claude),
  };
  const runtimes = {};
  for (const runtime of ['codex', 'claude']) {
    const probe = probes[runtime];
    const outcome = outcomes[runtime];
    runtimes[runtime] = {
      version: probe.version,
      capability_state: probe.supported ? 'supported' : 'unsupported',
      delivery_state: outcome.delivery,
      acknowledgement_state: outcome.acknowledgement,
      checked_at: checkedAt,
      reason_code: outcome.reason,
    };
  }
  return {
    schema: 1,
    id: EVIDENCE_ID,
    work_id: WORK_ID,
    kind: 'runtime-delivery-pilot',
    acceptance_criteria: ['AC-10', 'AC-12'],
    decision_record_ids: [DECISION_RECORD_ID],
    source: 'skills/brainstorming/scripts/runtime-pilot.cjs',
    recorded_at: checkedAt,
    result: { version: 1, runtimes },
  };
}

function writeEvidence(file, record) {
  const destination = path.resolve(file);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (fs.existsSync(destination)) throw new Error('evidence already exists');
  const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, destination);
    fs.chmodSync(destination, 0o600);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function parseArguments(argv) {
  let mode = null;
  let evidence = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--check-only' || argument === '--run-installed-supported') {
      if (mode) throw new Error('mode is duplicated');
      mode = argument.slice(2);
      continue;
    }
    if (argument === '--evidence' && index + 1 < argv.length && evidence === null) {
      evidence = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error('unsupported argument');
  }
  if (mode === null) throw new Error('mode is required');
  if (mode === 'run-installed-supported' && !evidence) throw new Error('evidence is required');
  if (mode === 'check-only' && evidence) throw new Error('check-only cannot write evidence');
  return { evidence, mode };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const probes = probeRuntimes();
  if (options.mode === 'check-only') {
    process.stdout.write(`${JSON.stringify(checkOnlyResult(probes), null, 2)}\n`);
    return;
  }
  const record = await buildEvidence(probes, new Date().toISOString());
  writeEvidence(options.evidence, record);
  process.stdout.write(`${JSON.stringify({
    version: 1,
    mode: 'run-installed-supported',
    evidence_id: EVIDENCE_ID,
  })}\n`);
}

if (require.main === module) {
  main().catch(() => {
    process.stderr.write('runtime-pilot: failed\n');
    process.exitCode = 1;
  });
}

module.exports = {
  buildEvidence,
  checkOnlyResult,
  parseArguments,
  probeClaude,
  probeCodex,
  writeEvidence,
};
