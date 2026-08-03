const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  git,
  gitCommonDirectory,
  readJson,
  safeSegment,
  workPaths,
  writeJson,
} = require('./pair-store');

function worktreeList(root) {
  const blocks = git(root, ['worktree', 'list', '--porcelain'], { trim: false }).stdout.trim().split(/\n\s*\n/u).filter(Boolean);
  return blocks.map(block => {
    const result = {};
    for (const line of block.split(/\r?\n/u)) {
      const [key, ...parts] = line.split(' ');
      result[key] = parts.join(' ') || true;
    }
    return result;
  });
}

function primaryWorktree(root) {
  const first = worktreeList(root)[0]?.worktree;
  if (!first) throw new Error('Git did not report a primary worktree');
  return path.resolve(first);
}

function ensureLocalExclude(root) {
  const exclude = path.join(gitCommonDirectory(root), 'info', 'exclude');
  fs.mkdirSync(path.dirname(exclude), { recursive: true });
  const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
  const lines = new Set(current.split(/\r?\n/u));
  const additions = ['.pair-worktrees/', 'node_modules/'].filter(line => !lines.has(line));
  if (additions.length === 0) return;
  fs.appendFileSync(exclude, `${current && !current.endsWith('\n') ? '\n' : ''}${additions.join('\n')}\n`);
}

function branchExists(root, branch) {
  return git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { allowFailure: true }).status === 0;
}

function createPairWorktree(root, { workId, base = 'HEAD', destination = null }) {
  const selectedWorkId = safeSegment(workId, 'Work ID');
  const branch = `pair/${selectedWorkId}`;
  const primary = primaryWorktree(root);
  const target = path.resolve(destination || path.join(primary, '.pair-worktrees', selectedWorkId));
  const existing = worktreeList(root).find(item => path.resolve(item.worktree) === target);
  if (existing) return { path: target, branch, created: false, head: git(target, ['rev-parse', 'HEAD']).stdout };
  if (fs.existsSync(target) && fs.readdirSync(target).length > 0) {
    throw new Error(`Pair worktree target already contains files: ${target}`);
  }
  ensureLocalExclude(root);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const args = ['worktree', 'add'];
  if (!branchExists(root, branch)) args.push('-b', branch, target, base);
  else args.push(target, branch);
  git(root, args);
  return { path: target, branch, created: true, head: git(target, ['rev-parse', 'HEAD']).stdout };
}

function worktreeStatus(worktree) {
  return git(worktree, ['status', '--porcelain=v1', '--untracked-files=all'], { trim: false }).stdout;
}

function removePairWorktree(root, { workId, destination = null }) {
  const selectedWorkId = safeSegment(workId, 'Work ID');
  const expected = path.resolve(destination || path.join(primaryWorktree(root), '.pair-worktrees', selectedWorkId));
  const registered = worktreeList(root).find(item => path.resolve(item.worktree) === expected);
  if (!registered) return { removed: false, path: expected };
  const status = worktreeStatus(expected);
  if (status.trim()) throw new Error(`Pair worktree ${expected} has uncommitted changes and will not be removed`);
  git(root, ['worktree', 'remove', expected]);
  return { removed: true, path: expected };
}

function packageManager(worktree) {
  const packageJson = readJson(path.join(worktree, 'package.json'), {});
  const declared = String(packageJson.packageManager || '').split('@')[0];
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(declared)) return declared;
  if (fs.existsSync(path.join(worktree, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(worktree, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(worktree, 'bun.lock')) || fs.existsSync(path.join(worktree, 'bun.lockb'))) return 'bun';
  if (fs.existsSync(path.join(worktree, 'package-lock.json')) || fs.existsSync(path.join(worktree, 'npm-shrinkwrap.json'))) return 'npm';
  return null;
}

function dependencyFingerprint(worktree, manager) {
  const candidates = [
    'package.json',
    'package-lock.json',
    'npm-shrinkwrap.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'yarn.lock',
    '.yarnrc.yml',
    'bun.lock',
    'bun.lockb',
  ];
  const hash = crypto.createHash('sha256');
  hash.update(`${manager}\0node-${process.versions.node.split('.')[0]}\0${process.platform}\0${process.arch}\0`);
  for (const candidate of candidates) {
    const file = path.join(worktree, candidate);
    if (!fs.existsSync(file)) continue;
    hash.update(`${candidate}\0`);
    hash.update(fs.readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function run(command, args, options = {}) {
  const runner = options.runner || childProcess.spawnSync;
  const result = runner(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: 'utf8',
    stdio: options.runner ? 'pipe' : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args[0] || ''} failed with status ${result.status}`);
  return result;
}

function cloneCopyOnWrite(source, destination, runner = childProcess.spawnSync) {
  if (!fs.existsSync(source) || fs.existsSync(destination)) return false;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const commands = process.platform === 'darwin'
    ? [['cp', ['-cR', source, destination]]]
    : [['cp', ['-a', '--reflink=always', source, destination]]];
  for (const [command, args] of commands) {
    const result = runner(command, args, { encoding: 'utf8', stdio: 'pipe' });
    if (!result.error && result.status === 0) return true;
  }
  return false;
}

function installationCommand(manager, cacheDirectory) {
  if (manager === 'pnpm') return ['pnpm', ['install', '--frozen-lockfile', '--store-dir', path.join(cacheDirectory, 'pnpm-store')]];
  if (manager === 'yarn') return ['yarn', ['install', '--immutable']];
  if (manager === 'bun') return ['bun', ['install', '--frozen-lockfile']];
  return ['npm', ['ci', '--cache', path.join(cacheDirectory, 'npm-cache'), '--prefer-offline']];
}

function declaredSubmodules(worktree) {
  const result = git(worktree, ['config', '-f', '.gitmodules', '--get-regexp', 'path'], { allowFailure: true });
  if (result.status !== 0) return new Set();
  return new Set(result.stdout.split(/\r?\n/u).filter(Boolean).map(line => line.split(/\s+/u).slice(1).join(' ')));
}

function initializeSubmodules(worktree, selected, runner = childProcess.spawnSync) {
  if (!selected || selected.length === 0) return [];
  const allowed = declaredSubmodules(worktree);
  const normalized = [...new Set(selected.map(value => String(value).replaceAll('\\', '/')))];
  for (const submodule of normalized) {
    if (!allowed.has(submodule)) throw new Error(`unknown or undeclared submodule ${submodule}`);
  }
  run('git', ['submodule', 'update', '--init', '--', ...normalized], { cwd: worktree, runner });
  return normalized;
}

function hydrateWorktree(root, { workId, worktree, submodules = [], runner = childProcess.spawnSync }) {
  const selectedWorkId = safeSegment(workId, 'Work ID');
  const selectedWorktree = path.resolve(worktree);
  const initializedSubmodules = initializeSubmodules(selectedWorktree, submodules, runner);
  const manager = packageManager(selectedWorktree);
  if (!manager) return { manager: null, hydrated: false, submodules: initializedSubmodules };
  const fingerprint = dependencyFingerprint(selectedWorktree, manager);
  const cacheDirectory = path.join(workPaths(root, selectedWorkId).pairDirectory, 'dependency-cache', fingerprint);
  const nodeModules = path.join(selectedWorktree, 'node_modules');
  const marker = path.join(nodeModules, '.pair-hydration.json');
  if (readJson(marker)?.fingerprint === fingerprint) {
    return { manager, fingerprint, hydrated: false, reused: 'existing', submodules: initializedSubmodules };
  }
  fs.mkdirSync(cacheDirectory, { recursive: true, mode: 0o700 });
  const seed = path.join(cacheDirectory, 'node_modules');
  let reused = null;
  if (!fs.existsSync(nodeModules) && cloneCopyOnWrite(seed, nodeModules, runner)) reused = 'copy-on-write';
  if (!reused) {
    const [command, args] = installationCommand(manager, cacheDirectory);
    const env = {
      ...process.env,
      YARN_CACHE_FOLDER: path.join(cacheDirectory, 'yarn-cache'),
      BUN_INSTALL_CACHE_DIR: path.join(cacheDirectory, 'bun-cache'),
    };
    run(command, args, { cwd: selectedWorktree, env, runner });
    reused = 'native-cache';
  }
  if (fs.existsSync(nodeModules)) {
    writeJson(marker, { schema: 1, fingerprint, manager, platform: process.platform, arch: process.arch }, 2048);
    if (!fs.existsSync(seed)) cloneCopyOnWrite(nodeModules, seed, runner);
  }
  return { manager, fingerprint, hydrated: true, reused, submodules: initializedSubmodules };
}

function defaultScratchDirectory(repositoryRoot, workId) {
  const base = process.env.CLAUDE_SCRATCH_DIR || path.join(os.homedir(), '.claude-scratch');
  return path.join(base, path.basename(repositoryRoot), 'pair', safeSegment(workId));
}

module.exports = {
  createPairWorktree,
  defaultScratchDirectory,
  dependencyFingerprint,
  hydrateWorktree,
  packageManager,
  primaryWorktree,
  removePairWorktree,
  worktreeList,
  worktreeStatus,
};
