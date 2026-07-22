const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { freshnessProjection } = require('./handover-state');

const ROLES = ['editor', 'coordinator', 'reviewer'];
const SHELLS = new Set(['bash', 'dash', 'fish', 'ksh', 'sh', 'tcsh', 'zsh']);

function sleepSync(ms) {
  // Synchronous pause without spawning a process — the tmux host runs entirely on
  // spawnSync, so this keeps the polling loop in the same execution model.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
}

function paneIsReady(pane) {
  // A pane is ready to receive a request when its foreground process is the shell
  // itself (or tmux reports no command yet). Any other command means a real program
  // is running in it.
  return Boolean(pane) && !pane.dead
    && (!pane.command || SHELLS.has(path.basename(pane.command)));
}

function waitForPaneReady(session, paneId, role, execute, options = {}) {
  // A freshly created pane transiently reports its shell's own startup command
  // (observed in the wild as "mkdir") as pane_current_command, which would otherwise
  // trip the busy check the instant ensureHost creates the panes. Poll for the shell
  // to settle before deciding. A pane still running a real command past the window is
  // genuinely busy and is refused rather than clobbered.
  const timeoutMs = Number(options.timeoutMs ?? process.env.PAIR_PANE_SETTLE_TIMEOUT_MS ?? 3000);
  const intervalMs = Number(options.intervalMs ?? 100);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pane = listPanes(session, execute)?.find(candidate => candidate.id === paneId);
    if (!pane || pane.dead) {
      throw new Error(`Pair v4 ${role} pane ${paneId} is unavailable`);
    }
    if (paneIsReady(pane)) return pane;
    if (Date.now() >= deadline) {
      throw new Error(
        `Pair v4 ${role} pane ${paneId} is busy with ${pane.command}; cancel or wait before dispatching another request`,
      );
    }
    sleepSync(intervalMs);
  }
}

function sessionNameForRoot(root) {
  const base = path.basename(path.resolve(root))
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 28) || 'repository';
  const digest = crypto.createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 10);
  return `pair-v4-${base}-${digest}`;
}

function defaultExecute(args, options = {}) {
  return childProcess.spawnSync('tmux', args, {
    encoding: 'utf8',
    ...options,
  });
}

function run(execute, args, options = {}, allowMissing = false) {
  const result = execute(args, options);
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowMissing) {
    throw new Error(`tmux ${args[0]} failed: ${(result.stderr || result.stdout || `exit ${result.status}`).trim()}`);
  }
  return result;
}

function privateAtomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(path.dirname(file), 0o700); } catch {}
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

function listPanes(session, execute = defaultExecute) {
  const result = run(
    execute,
    ['list-panes', '-t', `=${session}`, '-F', '#{pane_id}\t#{pane_title}\t#{pane_dead}\t#{pane_current_command}'],
    {},
    true,
  );
  if (result.status !== 0) return null;
  return result.stdout.trim().split(/\r?\n/u).filter(Boolean).map(line => {
    const [id, title, dead, command] = line.split('\t');
    return { id, title, dead: dead === '1', command: command || null };
  });
}

function stateFile(root) {
  return path.join(root, '.pair', 'tmux.json');
}

function readState(root) {
  try {
    return JSON.parse(fs.readFileSync(stateFile(root), 'utf8'));
  } catch {
    return null;
  }
}

function hostStatus(root, options = {}) {
  const execute = options.execute || defaultExecute;
  const session = sessionNameForRoot(root);
  const panes = listPanes(session, execute);
  return {
    session,
    exists: panes !== null,
    panes: panes || [],
    configured: readState(root),
    freshness: options.freshness || freshnessProjection(root, options.now),
  };
}

function ensureHost(root, options = {}) {
  const execute = options.execute || defaultExecute;
  const resolvedRoot = path.resolve(root);
  const session = sessionNameForRoot(resolvedRoot);
  let panes = listPanes(session, execute);
  if (panes === null) {
    const created = run(execute, [
      'new-session', '-d', '-s', session, '-n', 'pair', '-c', resolvedRoot,
      '-P', '-F', '#{pane_id}',
    ]).stdout.trim();
    panes = [{ id: created, title: '', dead: false, command: null }];
    while (panes.length < ROLES.length) {
      const paneId = run(execute, [
        'split-window', '-d', '-t', `${session}:`, '-c', resolvedRoot,
        '-P', '-F', '#{pane_id}',
      ]).stdout.trim();
      panes.push({ id: paneId, title: '', dead: false, command: null });
    }
    run(execute, ['select-layout', '-t', `${session}:`, 'even-horizontal']);
  }
  if (panes.length !== ROLES.length) {
    throw new Error(
      `Pair v4 host expected exactly three panes in ${session}; found ${panes.length}. No panes were changed or removed.`,
    );
  }

  const prior = readState(resolvedRoot);
  const known = prior?.session === session ? prior.panes || {} : {};
  const ids = new Set(panes.map(pane => pane.id));
  const assigned = {};
  const used = new Set();
  for (const role of ROLES) {
    if (known[role] && ids.has(known[role])) {
      assigned[role] = known[role];
      used.add(known[role]);
    }
  }
  for (const role of ROLES) {
    if (assigned[role]) continue;
    const titled = panes.find(pane => pane.title === role && !used.has(pane.id));
    const available = titled || panes.find(pane => !used.has(pane.id));
    assigned[role] = available.id;
    used.add(available.id);
  }

  run(execute, ['set-window-option', '-t', `${session}:`, 'allow-rename', 'off']);
  run(execute, ['set-window-option', '-t', `${session}:`, 'remain-on-exit', 'on']);
  const freshnessCommand = `#(cd ${shellQuote(resolvedRoot)} && ${shellQuote(process.execPath)} ${shellQuote(path.join(__dirname, '..', 'pair-task'))} --freshness-status 2>/dev/null)`;
  run(execute, ['set-option', '-t', session, 'status', 'on']);
  run(execute, ['set-option', '-t', session, 'status-interval', '5']);
  run(execute, ['set-option', '-t', session, 'status-right-length', '240']);
  run(execute, ['set-option', '-t', session, 'status-right', freshnessCommand]);
  for (const role of ROLES) {
    run(execute, ['select-pane', '-t', assigned[role], '-T', role]);
  }
  const state = {
    schema: 1,
    product: 'pair-v4',
    session,
    root: resolvedRoot,
    panes: assigned,
    updated_at: new Date().toISOString(),
  };
  privateAtomicWrite(stateFile(resolvedRoot), state);
  return state;
}

function sendKeys(root, role, command, options = {}) {
  if (!ROLES.includes(role)) throw new Error(`unknown Pair pane role ${role}`);
  const state = ensureHost(root, options);
  const execute = options.execute || defaultExecute;
  run(execute, ['send-keys', '-t', state.panes[role], '-l', command]);
  run(execute, ['send-keys', '-t', state.panes[role], 'Enter']);
  return state.panes[role];
}

function shellQuote(value) {
  return `'${String(value).replace(/'/gu, `'"'"'`)}'`;
}

function runInPaneSync(root, role, argv, timeoutMs, options = {}) {
  if (!ROLES.includes(role)) throw new Error(`unknown Pair pane role ${role}`);
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new TypeError('visible pane command requires a non-empty argv array');
  }
  const execute = options.execute || defaultExecute;
  const state = ensureHost(root, options);
  const paneId = state.panes[role];
  waitForPaneReady(state.session, paneId, role, execute, {
    timeoutMs: options.paneSettleTimeoutMs,
    intervalMs: options.paneSettleIntervalMs,
  });

  const channel = `pair-v4-${crypto.randomUUID()}`;
  const command = [
    ...argv.map(shellQuote),
    ';',
    'pair_visible_status=$?',
    ';',
    'tmux', 'wait-for', '-S', shellQuote(channel),
  ].join(' ');
  run(execute, ['send-keys', '-t', paneId, '-l', command]);
  run(execute, ['send-keys', '-t', paneId, 'Enter']);
  const waited = execute(
    ['wait-for', channel],
    { timeout: timeoutMs, encoding: 'utf8' },
  );
  if (waited.error?.code === 'ETIMEDOUT') {
    run(execute, ['send-keys', '-t', paneId, 'C-c'], {}, true);
    throw new Error(`Pair v4 ${role} pane request exceeded ${timeoutMs}ms`);
  }
  if (waited.error) throw waited.error;
  if (waited.status !== 0) {
    throw new Error(`tmux wait-for failed: ${(waited.stderr || waited.stdout || `exit ${waited.status}`).trim()}`);
  }
  return { paneId, session: state.session, channel };
}

module.exports = {
  ROLES,
  ensureHost,
  hostStatus,
  listPanes,
  paneIsReady,
  runInPaneSync,
  sendKeys,
  sessionNameForRoot,
  waitForPaneReady,
};
