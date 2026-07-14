const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createScratchDirectory } = require('./test-support');

const repositoryRoot = path.resolve(__dirname, '../../..');
const buildScript = path.join(repositoryRoot, 'scripts/build-visual-shell.mjs');
const sourceRoot = path.join(repositoryRoot, 'skills/brainstorming/ui');
const e2eRoot = path.join(repositoryRoot, 'skills/brainstorming/e2e');
const generatedRoot = path.join(repositoryRoot, 'skills/brainstorming/assets/visual-shell');

function copyFile(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function digest(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function stageBuild(t) {
  const root = createScratchDirectory(t, 'workspace-build');
  copyFile(buildScript, path.join(root, 'scripts/build-visual-shell.mjs'));
  copyFile(
    path.join(repositoryRoot, 'skills/brainstorming/tsconfig.json'),
    path.join(root, 'skills/brainstorming/tsconfig.json'),
  );
  copyFile(
    path.join(repositoryRoot, 'skills/brainstorming/playwright.config.ts'),
    path.join(root, 'skills/brainstorming/playwright.config.ts'),
  );
  for (const name of ['architecture-elk-graph.cjs', 'architecture-elk-graph.d.cts']) {
    copyFile(
      path.join(repositoryRoot, 'skills/brainstorming/scripts', name),
      path.join(root, 'skills/brainstorming/scripts', name),
    );
  }
  if (fs.existsSync(sourceRoot)) {
    fs.cpSync(sourceRoot, path.join(root, 'skills/brainstorming/ui'), { recursive: true });
  }
  if (fs.existsSync(e2eRoot)) {
    fs.cpSync(e2eRoot, path.join(root, 'skills/brainstorming/e2e'), { recursive: true });
  }
  fs.symlinkSync(path.join(repositoryRoot, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  return root;
}

function runNode(script, cwd) {
  return childProcess.spawnSync(process.execPath, [script], {
    cwd,
    encoding: 'utf8',
  });
}

test('the strict TypeScript React bootstrap builds deterministic fixed Visual Shell assets', t => {
  const stagedRoot = stageBuild(t);
  const stagedScript = path.join(stagedRoot, 'scripts/build-visual-shell.mjs');
  const firstBuild = runNode(stagedScript, stagedRoot);
  assert.equal(firstBuild.status, 0, firstBuild.stderr);

  const appAsset = path.join(stagedRoot, 'skills/brainstorming/assets/visual-shell/app.js');
  const styleAsset = path.join(stagedRoot, 'skills/brainstorming/assets/visual-shell/styles.css');
  assert.equal(fs.statSync(appAsset).isFile(), true);
  assert.equal(fs.statSync(styleAsset).isFile(), true);
  assert.ok(fs.statSync(appAsset).size > 1_000, 'the React bundle must not be an empty bootstrap');
  assert.ok(fs.statSync(styleAsset).size > 100, 'the shared shell stylesheet must not be empty');

  const mainSource = fs.readFileSync(
    path.join(stagedRoot, 'skills/brainstorming/ui/main.tsx'),
    'utf8',
  );
  assert.match(mainSource, /from\s+["']react-dom\/client["']/u);
  assert.match(mainSource, /createRoot\s*\(/u);
  assert.match(mainSource, /visual-shell-root/u);

  const appSource = fs.readFileSync(appAsset, 'utf8');
  assert.match(appSource, /visual-shell-root/u, 'the built bundle must retain the fixed host mount identity');
  assert.doesNotMatch(appSource, /\bfrom\s+["']react(?:-dom)?/u, 'React must be bundled for the fixed local shell');

  const firstDigests = [digest(appAsset), digest(styleAsset)];
  const secondBuild = runNode(stagedScript, stagedRoot);
  assert.equal(secondBuild.status, 0, secondBuild.stderr);
  assert.deepEqual(
    [digest(appAsset), digest(styleAsset)],
    firstDigests,
    'equal TypeScript inputs must produce byte-identical fixed assets',
  );
  assert.deepEqual(
    firstDigests,
    [digest(path.join(generatedRoot, 'app.js')), digest(path.join(generatedRoot, 'styles.css'))],
    'checked-in fixed assets must match the deterministic TypeScript build exercised by browser tests',
  );

  const typecheck = childProcess.spawnSync(
    path.join(repositoryRoot, 'node_modules/.bin/tsc'),
    ['--project', path.join(stagedRoot, 'skills/brainstorming/tsconfig.json')],
    { cwd: stagedRoot, encoding: 'utf8' },
  );
  assert.equal(typecheck.status, 0, typecheck.stderr || typecheck.stdout);
});
