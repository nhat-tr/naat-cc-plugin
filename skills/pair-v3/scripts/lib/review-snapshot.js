const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const REVIEWABLE_PAIR_FILES = new Set([
  '.pair/plan.md',
  '.pair/spec.md',
  '.pair/verify.sh',
]);

function repositoryFiles(root, excludedRoot = null) {
  const listed = childProcess.spawnSync(
    'git',
    ['ls-files', '-co', '--exclude-standard', '-z'],
    { cwd: root, encoding: 'buffer' },
  );
  if (listed.status !== 0) {
    throw new Error('could not enumerate the repository for an isolated review snapshot');
  }
  const paths = listed.stdout.toString('utf8').split('\0').filter(Boolean);
  for (const pairPath of ['.pair/plan.md', '.pair/spec.md']) {
    if (fs.existsSync(path.join(root, pairPath))) paths.push(pairPath);
  }
  const repositoryRoot = path.resolve(root);
  const excluded = excludedRoot ? path.resolve(excludedRoot) : null;
  return [...new Set(paths)].filter((relativePath) => {
    const absolute = path.resolve(root, relativePath);
    if (!absolute.startsWith(`${repositoryRoot}${path.sep}`)) {
      throw new Error(`repository path escapes the root: ${relativePath}`);
    }
    if (relativePath.startsWith('.pair/') && !REVIEWABLE_PAIR_FILES.has(relativePath)) {
      return false;
    }
    return !excluded || (absolute !== excluded && !absolute.startsWith(`${excluded}${path.sep}`));
  }).sort();
}

function copyRepositoryEntry(root, destinationRoot, relativePath) {
  const source = path.join(root, relativePath);
  let stat;
  try {
    stat = fs.lstatSync(source);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  const destination = path.join(destinationRoot, relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (stat.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(source), destination);
  } else if (stat.isDirectory()) {
    fs.cpSync(source, destination, {
      recursive: true,
      filter: entry => path.basename(entry) !== '.git',
    });
  } else if (stat.isFile()) {
    fs.copyFileSync(source, destination);
    fs.chmodSync(destination, stat.mode);
  }
}

function treeDigest(root) {
  const hash = crypto.createHash('sha256');
  function visit(directory, prefix = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = path.join(directory, entry.name);
      hash.update(`${entry.isDirectory() ? 'd' : entry.isSymbolicLink() ? 'l' : 'f'}:${relativePath}\0`);
      if (entry.isDirectory()) visit(absolutePath, relativePath);
      else if (entry.isSymbolicLink()) hash.update(fs.readlinkSync(absolutePath));
      else hash.update(fs.readFileSync(absolutePath));
      hash.update('\0');
    }
  }
  visit(root);
  return hash.digest('hex');
}

function repositoryDigest(root, excludedRoot = null) {
  const hash = crypto.createHash('sha256');
  for (const relativePath of repositoryFiles(root, excludedRoot)) {
    const absolutePath = path.join(root, relativePath);
    let stat;
    try {
      stat = fs.lstatSync(absolutePath);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    hash.update(`${relativePath}\0`);
    if (stat.isSymbolicLink()) hash.update(fs.readlinkSync(absolutePath));
    else if (stat.isDirectory()) hash.update(treeDigest(absolutePath));
    else hash.update(fs.readFileSync(absolutePath));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function createReviewSnapshot(root, parentDirectory) {
  const directory = fs.mkdtempSync(path.join(parentDirectory, 'review-snapshot-'));
  const sourceDigest = repositoryDigest(root, parentDirectory);
  for (const relativePath of repositoryFiles(root, parentDirectory)) {
    copyRepositoryEntry(root, directory, relativePath);
  }
  return { directory, digest: treeDigest(directory), sourceDigest };
}

module.exports = {
  createReviewSnapshot,
  repositoryDigest,
  treeDigest,
};
