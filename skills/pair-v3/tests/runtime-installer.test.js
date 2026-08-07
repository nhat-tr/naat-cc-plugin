const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  installRuntimeHooks,
  uninstallRuntimeHooks,
} = require('../../../scripts/install-runtime');

function fixture(t) {
  const scratchRoot = process.env.CLAUDE_SCRATCH_DIR || path.join(os.homedir(), '.claude-scratch');
  const parent = path.join(scratchRoot, 'my-claude-code', 'runtime-installer-tests');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'repo-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function installedCommands(settings, event) {
  return (settings.hooks?.[event] || [])
    .flatMap(entry => entry.hooks || [])
    .map(hook => hook.command);
}

test('Claude hook install creates missing settings and atomically replaces stale toolkit hooks', t => {
  const root = fixture(t);
  const settingsFile = path.join(root, '.claude', 'settings.json');
  const pluginDir = path.resolve(__dirname, '../../..');
  const operations = [];

  installRuntimeHooks({
    target: settingsFile,
    pluginDir,
    runtime: 'claude',
    dryRun: false,
    operations,
  });

  let settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.match(installedCommands(settings, 'UserPromptSubmit').join('\n'), /PAIR_HOOK_RUNTIME=claude.*handover-gate\.sh/u);
  assert.match(installedCommands(settings, 'Stop').join('\n'), /PAIR_HOOK_RUNTIME=claude.*stop-gate\.sh/u);
  assert.match(installedCommands(settings, 'PostToolUse').join('\n'), /PAIR_HOOK_RUNTIME=claude.*brainstorm-register\.sh/u);
  assert.doesNotMatch(installedCommands(settings, 'PostToolUse').join('\n'), /pair-owner\.sh/u);
  assert.doesNotMatch(JSON.stringify(settings.hooks), /delegation-nudge/u);
  assert.equal(operations.some(operation => operation.action === 'merge_hooks'), true);

  settings.model = 'user-choice';
  settings.hooks.Stop.push({
    matcher: '',
    hooks: [{ type: 'command', command: 'bash ~/.local/share/my-claude-code/hooks/stop-gate.sh' }],
  });
  settings.hooks.Stop.push({
    matcher: '*',
    hooks: [{ type: 'command', command: 'bash /opt/external/stop-observer.sh' }],
  });
  fs.writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);

  installRuntimeHooks({
    target: settingsFile,
    pluginDir,
    runtime: 'claude',
    dryRun: false,
    operations: [],
  });

  settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.equal(settings.model, 'user-choice');
  assert.equal(installedCommands(settings, 'Stop').filter(command => command.includes('stop-gate.sh')).length, 1);
  // The plugin directory the install ran from, not the name the checkout happens to sit under: the survivor
  // has to be the hook this install wrote, and spelling that as a repository name makes the assertion fail
  // in every worktree — including the Pair worktrees this suite is verified from.
  assert.equal(installedCommands(settings, 'Stop').filter(command => command.includes(path.join(pluginDir, 'hooks', 'stop-gate.sh'))).length, 1);
  assert.equal(installedCommands(settings, 'Stop').filter(command => command.includes('/opt/external/stop-observer.sh')).length, 1);
});

test('Claude hook uninstall preserves settings when no hooks are installed', t => {
  const root = fixture(t);
  const settingsFile = path.join(root, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, `${JSON.stringify({ model: 'user-choice' }, null, 2)}\n`);

  uninstallRuntimeHooks({
    target: settingsFile,
    pluginDir: path.resolve(__dirname, '../../..'),
    dryRun: false,
    operations: [],
  });

  assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')), { model: 'user-choice' });
});
