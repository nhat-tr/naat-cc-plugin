#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const { ROOT_DIR, getAssetEntries, loadManifest } = require('./lib/runtime-assets');

const MANAGED_COMMENT = 'GENERATED: do not edit directly';

function parseArgs(argv) {
  const args = {
    command: 'install',
    runtime: 'all',
    scope: 'global',
    json: false,
    dryRun: false,
    uninstall: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === 'list' || arg === 'doctor') {
      args.command = arg;
      continue;
    }
    if (arg === '--runtime') {
      args.runtime = argv[++i];
      continue;
    }
    if (arg === '--scope') {
      args.scope = argv[++i];
      continue;
    }
    if (arg === '--json') {
      args.json = true;
      continue;
    }
    if (arg === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    if (arg === '--uninstall') {
      args.uninstall = true;
      continue;
    }
  }

  return args;
}

function getSelectedRuntimes(runtime) {
  if (runtime === 'all') {
    return ['claude', 'codex', 'copilot'];
  }

  return [runtime];
}

function getSelectedScopes(scope) {
  if (scope === 'all') {
    return ['repo', 'global'];
  }

  return [scope];
}

function ensureDir(targetDir, dryRun, operations) {
  operations.push({ action: 'ensure_dir', target: targetDir });
  if (!dryRun) {
    fs.mkdirSync(targetDir, { recursive: true });
  }
}

function installRenderedFile(source, target, pluginDir, dryRun, operations) {
  operations.push({ action: 'render_file', source, target });
  if (dryRun) {
    return;
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });

  if (fs.existsSync(target) && !fs.readFileSync(target, 'utf-8').includes(MANAGED_COMMENT)) {
    fs.copyFileSync(target, `${target}.bak`);
  }

  const content = fs.readFileSync(source, 'utf-8').replace(/__PLUGIN_DIR__/g, pluginDir);
  fs.writeFileSync(target, content);
}

function installSymlink(source, target, dryRun, operations) {
  operations.push({ action: 'symlink', source, target });
  if (dryRun) {
    return;
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });

  if (fs.existsSync(target) || fs.lstatSync(path.dirname(target)).isDirectory()) {
    try {
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) {
        const existing = fs.readlinkSync(target);
        if (existing === source) {
          return;
        }
        fs.unlinkSync(target);
      } else {
        fs.renameSync(target, `${target}.bak`);
      }
    } catch {
      // ignore missing target
    }
  }

  fs.symlinkSync(source, target);
}

function removeManagedPath(target, dryRun, operations) {
  operations.push({ action: 'remove', target });
  if (dryRun || !fs.existsSync(target)) {
    return;
  }

  const stat = fs.lstatSync(target);
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    fs.rmSync(target, { recursive: true, force: true });
  } else {
    fs.rmSync(target, { recursive: true, force: true });
  }
}

function restoreBackup(target, dryRun, operations) {
  const backup = `${target}.bak`;
  if (!fs.existsSync(backup)) {
    return;
  }

  operations.push({ action: 'restore_backup', source: backup, target });
  if (!dryRun) {
    fs.renameSync(backup, target);
  }
}

function runGenerator(mode, dryRun, operations, quiet = false) {
  operations.push({ action: 'generate_repo_assets', mode });
  if (dryRun) {
    return;
  }

  childProcess.execFileSync('node', ['scripts/generate-runtime-assets.js', mode], {
    cwd: ROOT_DIR,
    stdio: quiet ? ['ignore', 'ignore', 'inherit'] : 'inherit',
  });
}

function installClaudeGlobal(manifest, pluginDir, dryRun, operations) {
  const home = os.homedir();
  const claudeDir = process.env.CLAUDE_HOME || path.join(home, '.claude');
  const agentsDir = path.join(claudeDir, 'agents');
  const commandsDir = path.join(claudeDir, 'commands');
  const contextsDir = path.join(claudeDir, 'contexts');
  const globalInstruction = path.join(ROOT_DIR, manifest.generated_outputs.claude_global.output);

  ensureDir(agentsDir, dryRun, operations);
  ensureDir(commandsDir, dryRun, operations);
  ensureDir(contextsDir, dryRun, operations);

  installRenderedFile(globalInstruction, path.join(claudeDir, 'CLAUDE.md'), pluginDir, dryRun, operations);

  const assets = getAssetEntries(manifest);
  for (const asset of assets) {
    const source = path.join(ROOT_DIR, asset.canonical_file);
    if (!asset.supported_runtimes.includes('claude')) {
      continue;
    }

    if (asset.type === 'agent') {
      installSymlink(source, path.join(agentsDir, path.basename(asset.canonical_file)), dryRun, operations);
      continue;
    }

    if (asset.type === 'command') {
      installSymlink(source, path.join(commandsDir, path.basename(asset.canonical_file)), dryRun, operations);
      continue;
    }

    if (asset.type === 'context') {
      operations.push({ action: 'copy', source, target: path.join(contextsDir, path.basename(asset.canonical_file)) });
      if (!dryRun) {
        fs.copyFileSync(source, path.join(contextsDir, path.basename(asset.canonical_file)));
      }
      continue;
    }

    if ((asset.type === 'skill' || asset.type === 'workflow_skill') && fs.existsSync(path.join(ROOT_DIR, `commands/${path.basename(path.dirname(asset.canonical_file))}.md`))) {
      continue;
    }

    if (asset.type === 'skill' || asset.type === 'workflow_skill') {
      const skillName = path.basename(path.dirname(asset.canonical_file));
      installSymlink(source, path.join(commandsDir, `${skillName}.md`), dryRun, operations);
    }
  }

  installCliTools(manifest, 'claude', dryRun, operations);
  pruneDanglingSymlinks(
    [agentsDir, commandsDir, path.join(home, '.local', 'bin')],
    dryRun,
    operations
  );
  declareRuntimeDelivery(manifest, 'claude', dryRun, operations);
}

function uninstallClaudeGlobal(manifest, dryRun, operations) {
  const home = os.homedir();
  const claudeDir = process.env.CLAUDE_HOME || path.join(home, '.claude');
  const agentsDir = path.join(claudeDir, 'agents');
  const commandsDir = path.join(claudeDir, 'commands');
  const contextsDir = path.join(claudeDir, 'contexts');

  removeManagedPath(path.join(claudeDir, 'CLAUDE.md'), dryRun, operations);
  restoreBackup(path.join(claudeDir, 'CLAUDE.md'), dryRun, operations);

  for (const asset of getAssetEntries(manifest)) {
    if (!asset.supported_runtimes.includes('claude')) {
      continue;
    }

    if (asset.type === 'agent') {
      removeManagedPath(path.join(agentsDir, path.basename(asset.canonical_file)), dryRun, operations);
      continue;
    }

    if (asset.type === 'command') {
      removeManagedPath(path.join(commandsDir, path.basename(asset.canonical_file)), dryRun, operations);
      continue;
    }

    if (asset.type === 'context') {
      removeManagedPath(path.join(contextsDir, path.basename(asset.canonical_file)), dryRun, operations);
      continue;
    }

    if (asset.type === 'skill' || asset.type === 'workflow_skill') {
      const skillName = path.basename(path.dirname(asset.canonical_file));
      removeManagedPath(path.join(commandsDir, `${skillName}.md`), dryRun, operations);
    }
  }

  uninstallCliTools(manifest, 'claude', dryRun, operations);
}

// Remove symlinks that point into this repo but no longer resolve — assets get
// renamed/archived and neither installer previously garbage-collected the old
// links (21 dangling entries had accumulated in the live install).
function pruneDanglingSymlinks(dirs, dryRun, operations) {
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      continue;
    }

    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      let stat;
      try {
        stat = fs.lstatSync(full);
      } catch {
        continue;
      }
      if (!stat.isSymbolicLink()) {
        continue;
      }

      let target;
      try {
        target = fs.readlinkSync(full);
      } catch {
        continue;
      }
      const resolved = path.isAbsolute(target) ? target : path.resolve(dir, target);
      if (!resolved.startsWith(ROOT_DIR + path.sep)) {
        continue; // only manage links into this repo
      }
      if (fs.existsSync(full)) {
        continue; // target still resolves
      }

      operations.push({ action: 'prune', target: full });
      if (!dryRun) {
        fs.unlinkSync(full);
      }
    }
  }
}

function installCliTools(manifest, runtime, dryRun, operations) {
  const home = os.homedir();
  const localBinDir = path.join(home, '.local', 'bin');
  ensureDir(localBinDir, dryRun, operations);

  for (const asset of getAssetEntries(manifest)) {
    if (asset.type !== 'cli' || !asset.supported_runtimes.includes(runtime)) {
      continue;
    }

    const source = path.join(ROOT_DIR, asset.canonical_file);
    installSymlink(source, path.join(localBinDir, path.basename(asset.canonical_file)), dryRun, operations);
  }
}

function uninstallCliTools(manifest, runtime, dryRun, operations) {
  const home = os.homedir();
  const localBinDir = path.join(home, '.local', 'bin');

  for (const asset of getAssetEntries(manifest)) {
    if (asset.type !== 'cli' || !asset.supported_runtimes.includes(runtime)) {
      continue;
    }

    removeManagedPath(path.join(localBinDir, path.basename(asset.canonical_file)), dryRun, operations);
  }
}

function runtimeDeliveryEntries(manifest, runtime) {
  const delivery = manifest.runtimes?.[runtime]?.delivery;
  if (!delivery) return [];
  const values = runtime === 'codex'
    ? [delivery.active, delivery.idle]
    : runtime === 'claude'
      ? [delivery.active, delivery.channel]
      : [delivery];
  return values.filter(Boolean).map(value => ({
    ...value,
    ...(value.entrypoint ? { entrypoint: path.join(ROOT_DIR, value.entrypoint) } : {}),
    ...(value.adapter ? { adapter: path.join(ROOT_DIR, value.adapter) } : {}),
  }));
}

function codexMcpConfiguration(server) {
  const result = childProcess.spawnSync('codex', ['mcp', 'get', server, '--json'], {
    encoding: 'utf8',
    env: process.env,
  });
  if (result.error?.code === 'ENOENT') return { installed: false, configuration: null };
  if (result.status !== 0) return { installed: true, configuration: null };
  try {
    return { installed: true, configuration: JSON.parse(result.stdout) };
  } catch {
    throw new Error('Codex MCP registration returned invalid diagnostics');
  }
}

function registerCodexActiveDelivery(entry) {
  const current = codexMcpConfiguration(entry.server);
  if (!current.installed) return;
  const expectedArgs = [entry.entrypoint];
  if (current.configuration) {
    const transport = current.configuration.transport;
    if (transport?.type === 'stdio'
      && transport.command === process.execPath
      && JSON.stringify(transport.args || []) === JSON.stringify(expectedArgs)) {
      return;
    }
    throw new Error(`Codex MCP server ${entry.server} already has unmanaged configuration`);
  }
  const added = childProcess.spawnSync('codex', [
    'mcp', 'add', entry.server, '--', process.execPath, entry.entrypoint,
  ], {
    encoding: 'utf8',
    env: process.env,
  });
  if (added.status !== 0) throw new Error(`Codex MCP server ${entry.server} could not be registered`);
}

function declareRuntimeDelivery(manifest, runtime, dryRun, operations) {
  for (const entry of runtimeDeliveryEntries(manifest, runtime)) {
    operations.push({
      action: 'register_runtime_delivery',
      runtime,
      ...entry,
      dry_run: dryRun,
    });
    if (!dryRun && runtime === 'codex' && entry.registration === 'mcp') {
      registerCodexActiveDelivery(entry);
    }
  }
}

function managedPairHook(entry) {
  return (entry.hooks || []).some(hook => typeof hook.command === 'string' && hook.command.includes('my-claude-code/hooks/stop-gate.sh'));
}

function installCodexHooks(codexDir, pluginDir, dryRun, operations) {
  const source = path.join(ROOT_DIR, 'hooks', 'hooks.json');
  const target = path.join(codexDir, 'hooks.json');
  operations.push({ action: 'merge_hooks', source, target });
  if (dryRun) return;

  let current = { hooks: {} };
  if (fs.existsSync(target)) {
    current = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (!current.hooks) current = { hooks: current };
  }
  const incoming = JSON.parse(fs.readFileSync(source, 'utf8'));
  for (const [event, entries] of Object.entries(incoming.hooks || incoming)) {
    const existing = (current.hooks[event] || []).filter(entry => !managedPairHook(entry));
    const rendered = entries.map(entry => ({
      ...entry,
      hooks: (entry.hooks || []).map(hook => ({
        ...hook,
        command: typeof hook.command === 'string' && hook.command.includes('my-claude-code/hooks/stop-gate.sh')
          ? `bash ${JSON.stringify(path.join(pluginDir, 'hooks', 'stop-gate.sh'))}`
          : hook.command,
      })),
    }));
    current.hooks[event] = [...existing, ...rendered];
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(current, null, 2)}\n`);
}

function uninstallCodexHooks(codexDir, dryRun, operations) {
  const target = path.join(codexDir, 'hooks.json');
  operations.push({ action: 'remove_hooks', target });
  if (dryRun || !fs.existsSync(target)) return;
  const current = JSON.parse(fs.readFileSync(target, 'utf8'));
  const hooks = current.hooks || current;
  for (const event of Object.keys(hooks)) {
    hooks[event] = hooks[event].filter(entry => !managedPairHook(entry));
    if (hooks[event].length === 0) delete hooks[event];
  }
  fs.writeFileSync(target, `${JSON.stringify(current, null, 2)}\n`);
}

function installCodexGlobal(manifest, pluginDir, dryRun, operations) {
  const home = os.homedir();
  const codexDir = process.env.CODEX_HOME || path.join(home, '.codex');
  const agentsDir = path.join(home, '.agents');
  const skillDirs = [path.join(codexDir, 'skills'), path.join(agentsDir, 'skills')];
  const globalInstruction = path.join(ROOT_DIR, manifest.generated_outputs.codex_global.output);

  for (const skillDir of skillDirs) {
    ensureDir(skillDir, dryRun, operations);
  }

  installRenderedFile(globalInstruction, path.join(codexDir, 'AGENTS.md'), pluginDir, dryRun, operations);
  installRenderedFile(globalInstruction, path.join(agentsDir, 'AGENTS.md'), pluginDir, dryRun, operations);
  installCodexHooks(codexDir, pluginDir, dryRun, operations);

  for (const asset of getAssetEntries(manifest)) {
    if (!asset.supported_runtimes.includes('codex')) {
      continue;
    }
    if (asset.type !== 'skill' && asset.type !== 'workflow_skill') {
      continue;
    }

    const sourceDir = path.join(ROOT_DIR, path.dirname(asset.canonical_file));
    const skillName = path.basename(path.dirname(asset.canonical_file));
    for (const skillDir of skillDirs) {
      installSymlink(sourceDir, path.join(skillDir, skillName), dryRun, operations);
    }
  }

  installCliTools(manifest, 'codex', dryRun, operations);
  pruneDanglingSymlinks(skillDirs, dryRun, operations);
  declareRuntimeDelivery(manifest, 'codex', dryRun, operations);
}

function uninstallCodexGlobal(manifest, dryRun, operations) {
  const home = os.homedir();
  const codexDir = process.env.CODEX_HOME || path.join(home, '.codex');
  const agentsDir = path.join(home, '.agents');
  const skillDirs = [path.join(codexDir, 'skills'), path.join(agentsDir, 'skills')];

  removeManagedPath(path.join(codexDir, 'AGENTS.md'), dryRun, operations);
  restoreBackup(path.join(codexDir, 'AGENTS.md'), dryRun, operations);
  removeManagedPath(path.join(agentsDir, 'AGENTS.md'), dryRun, operations);
  restoreBackup(path.join(agentsDir, 'AGENTS.md'), dryRun, operations);
  uninstallCodexHooks(codexDir, dryRun, operations);

  for (const asset of getAssetEntries(manifest)) {
    if (!asset.supported_runtimes.includes('codex')) {
      continue;
    }
    if (asset.type !== 'skill' && asset.type !== 'workflow_skill') {
      continue;
    }

    const skillName = path.basename(path.dirname(asset.canonical_file));
    for (const skillDir of skillDirs) {
      removeManagedPath(path.join(skillDir, skillName), dryRun, operations);
    }
  }

  uninstallCliTools(manifest, 'codex', dryRun, operations);
}

function installCopilotGlobal(manifest, dryRun, operations) {
  const home = os.homedir();
  const copilotDir = path.join(home, '.copilot', 'skills');
  ensureDir(copilotDir, dryRun, operations);

  for (const asset of getAssetEntries(manifest)) {
    if (!asset.supported_runtimes.includes('copilot')) {
      continue;
    }
    if (asset.publish?.copilot?.kind !== 'repo_skill_copy') {
      continue;
    }

    const sourceDir = path.join(ROOT_DIR, path.dirname(asset.canonical_file));
    const skillName = path.basename(path.dirname(asset.canonical_file));
    installSymlink(sourceDir, path.join(copilotDir, skillName), dryRun, operations);
  }
}

function uninstallCopilotGlobal(manifest, dryRun, operations) {
  const home = os.homedir();
  const copilotDir = path.join(home, '.copilot', 'skills');

  for (const asset of getAssetEntries(manifest)) {
    if (!asset.supported_runtimes.includes('copilot')) {
      continue;
    }
    if (asset.publish?.copilot?.kind !== 'repo_skill_copy') {
      continue;
    }

    const skillName = path.basename(path.dirname(asset.canonical_file));
    removeManagedPath(path.join(copilotDir, skillName), dryRun, operations);
  }
}

function listPlan(manifest, runtime, scope) {
  const runtimes = getSelectedRuntimes(runtime);
  const scopes = getSelectedScopes(scope);
  const assets = getAssetEntries(manifest).filter((asset) =>
    asset.supported_runtimes.some((value) => runtimes.includes(value))
  );

  return {
    runtimes,
    scopes,
    assets: assets.map((asset) => ({
      id: asset.id,
      type: asset.type,
      canonical_file: asset.canonical_file,
      supported_runtimes: asset.supported_runtimes,
    })),
  };
}

function doctor(manifest) {
  const generatedOutputs = Object.values(manifest.generated_outputs || {}).map((output) => ({
    file: output.output,
    exists: fs.existsSync(path.join(ROOT_DIR, output.output)),
  }));

  return {
    manifest: 'metadata/runtime-asset-map.json',
    manifest_exists: fs.existsSync(path.join(ROOT_DIR, 'metadata/runtime-asset-map.json')),
    generated_outputs: generatedOutputs,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = loadManifest();

  if (args.command === 'list') {
    const result = listPlan(manifest, args.runtime, args.scope);
    console.log(args.json ? JSON.stringify(result, null, 2) : result);
    return;
  }

  if (args.command === 'doctor') {
    const result = doctor(manifest);
    console.log(args.json ? JSON.stringify(result, null, 2) : result);
    return;
  }

  const operations = [];
  const pluginDir = ROOT_DIR;
  const runtimes = getSelectedRuntimes(args.runtime);
  const scopes = getSelectedScopes(args.scope);

  if (scopes.includes('repo')) {
    if (args.uninstall) {
      console.error('Repo-scope uninstall is not supported for generated files.');
      process.exit(1);
    }
    runGenerator('--write', args.dryRun, operations, args.json);
  } else if (scopes.includes('global') && !args.uninstall) {
    // Global installs render CLAUDE.md / AGENTS.md / codex-global.md from the
    // generated outputs — regenerate them first so template or manifest edits
    // can never ship stale instruction files (install.*.sh all land here).
    runGenerator('--write', args.dryRun, operations, args.json);
  }

  if (scopes.includes('global')) {
    for (const runtime of runtimes) {
      if (runtime === 'claude') {
        if (args.uninstall) {
          uninstallClaudeGlobal(manifest, args.dryRun, operations);
        } else {
          installClaudeGlobal(manifest, pluginDir, args.dryRun, operations);
        }
      }

      if (runtime === 'codex') {
        if (args.uninstall) {
          uninstallCodexGlobal(manifest, args.dryRun, operations);
        } else {
          installCodexGlobal(manifest, pluginDir, args.dryRun, operations);
        }
      }

      if (runtime === 'copilot') {
        if (args.uninstall) {
          uninstallCopilotGlobal(manifest, args.dryRun, operations);
        } else {
          installCopilotGlobal(manifest, args.dryRun, operations);
        }
      }
    }
  }

  if (args.json) {
    console.log(JSON.stringify({ operations }, null, 2));
    return;
  }

  console.log(`Prepared ${operations.length} operation(s) for runtime=${args.runtime} scope=${args.scope}${args.dryRun ? ' (dry-run)' : ''}`);
}

main();
