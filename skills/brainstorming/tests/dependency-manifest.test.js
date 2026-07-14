const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const repositoryRoot = path.resolve(__dirname, '../../..');

const runtimeDependencies = {
  '@modelcontextprotocol/sdk': '1.29.0',
  '@xyflow/react': '12.11.2',
  ajv: '8.20.0',
  elkjs: '0.11.1',
  'lucide-react': '1.24.0',
  react: '19.2.7',
  'react-dom': '19.2.7',
};

const developmentDependencies = {
  '@axe-core/playwright': '4.12.1',
  '@playwright/test': '1.61.1',
  '@types/react': '19.2.17',
  '@types/react-dom': '19.2.3',
  esbuild: '0.28.1',
  typescript: '7.0.2',
};

const requiredScripts = {
  'build:brainstorming': 'node scripts/build-visual-shell.mjs',
  'test:brainstorming:a11y': 'playwright test --config skills/brainstorming/playwright.config.ts --project=a11y',
  'test:brainstorming:e2e': 'playwright test --config skills/brainstorming/playwright.config.ts --project=e2e',
  'test:brainstorming:performance': 'playwright test --config skills/brainstorming/playwright.config.ts --project=performance',
  'test:brainstorming:visual': 'playwright test --config skills/brainstorming/playwright.config.ts --project=visual',
  'typecheck:brainstorming': 'tsc --project skills/brainstorming/tsconfig.json',
};

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8'));
}

function git(args) {
  return childProcess.spawnSync('git', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
}

function pick(source, keys) {
  return Object.fromEntries(keys.map(key => [key, source[key]]));
}

function fileDigest(relativePath) {
  return crypto
    .createHash('sha256')
    .update(fs.readFileSync(path.join(repositoryRoot, relativePath)))
    .digest('hex');
}

test('dependency manifest pins the complete Visual Companion toolchain and verification scripts', () => {
  const manifest = readJson('package.json');

  assert.equal(manifest.packageManager, 'npm@11.17.0');
  assert.deepEqual(manifest.dependencies, runtimeDependencies);
  assert.deepEqual(manifest.devDependencies, developmentDependencies);
  assert.deepEqual(
    Object.fromEntries(Object.keys(requiredScripts).map(name => [name, manifest.scripts[name]])),
    requiredScripts,
  );
});

test('lockfile is Git-visible and resolves every direct dependency at its exact pin', () => {
  const visible = git([
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard',
    '--',
    'package-lock.json',
  ]);
  assert.equal(visible.status, 0, visible.stderr);
  assert.equal(visible.stdout.trim(), 'package-lock.json');

  const ignored = git(['check-ignore', '--quiet', '--', 'package-lock.json']);
  assert.equal(ignored.status, 1, 'package-lock.json must not be ignored');

  const lockfile = readJson('package-lock.json');
  assert.equal(lockfile.lockfileVersion, 3);
  assert.equal(lockfile.requires, true);
  assert.deepEqual(lockfile.packages[''].dependencies, runtimeDependencies);
  assert.deepEqual(lockfile.packages[''].devDependencies, developmentDependencies);

  for (const [name, version] of Object.entries({
    ...runtimeDependencies,
    ...developmentDependencies,
  })) {
    const resolved = lockfile.packages[`node_modules/${name}`];
    assert.ok(resolved, `lockfile must contain node_modules/${name}`);
    assert.equal(resolved.version, version, `${name} must resolve at its declared pin`);
    assert.match(resolved.resolved, /^https:\/\/registry\.npmjs\.org\//u, `${name} must record its registry source`);
    assert.match(resolved.integrity, /^sha512-/u, `${name} must record integrity metadata`);
  }
});

test('TypeScript configuration is strict across the Visual Shell and browser tests', () => {
  const config = readJson('skills/brainstorming/tsconfig.json');
  const requiredOptions = {
    target: 'ES2022',
    lib: ['ES2022', 'DOM', 'DOM.Iterable'],
    module: 'ESNext',
    moduleResolution: 'Bundler',
    jsx: 'react-jsx',
    strict: true,
    noUncheckedIndexedAccess: true,
    noEmit: true,
    isolatedModules: true,
    skipLibCheck: true,
  };
  assert.deepEqual(
    pick(config.compilerOptions, Object.keys(requiredOptions)),
    requiredOptions,
  );
  const requiredIncludes = [
    'ui/**/*.ts',
    'ui/**/*.tsx',
    'e2e/**/*.ts',
    'playwright.config.ts',
  ];
  for (const include of requiredIncludes) {
    assert.ok(config.include.includes(include), `TypeScript must include ${include}`);
  }
});

test('Playwright configuration isolates browser, visual, accessibility, and performance suites', () => {
  const configPath = path.join(repositoryRoot, 'skills/brainstorming/playwright.config.ts');
  const loadConfig = `
    import(${JSON.stringify(pathToFileURL(configPath).href)})
      .then(({ default: config }) => process.stdout.write(JSON.stringify({
        testDir: config.testDir,
        outputDir: config.outputDir,
        snapshotPathTemplate: config.snapshotPathTemplate ?? null,
        use: {
          browserName: config.use.browserName,
          headless: config.use.headless,
        },
        projects: config.projects.map(project => ({
          name: project.name,
          testMatch: project.testMatch ?? null,
          testIgnore: project.testIgnore ?? null,
          workers: project.workers ?? null,
        })),
      })))
      .catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const loaded = childProcess.spawnSync(process.execPath, [
    '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
    '--input-type=module',
    '--eval',
    loadConfig,
  ], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  assert.equal(loaded.status, 0, loaded.stderr);
  const config = JSON.parse(loaded.stdout);

  assert.equal(config.testDir, './e2e');
  assert.equal(config.use.browserName, 'chromium');
  assert.equal(config.use.headless, true);
  assert.equal(config.snapshotPathTemplate, null, 'checked-in screenshot baselines must keep Playwright defaults');
  assert.ok(path.isAbsolute(config.outputDir));
  const relativeOutput = path.relative(repositoryRoot, config.outputDir);
  assert.ok(
    relativeOutput === '..' || relativeOutput.startsWith(`..${path.sep}`),
    'runtime results must stay outside the repository while screenshot baselines remain tracked',
  );

  const projects = new Map(config.projects.map(project => [project.name, project]));
  assert.deepEqual([...projects.keys()].sort(), ['a11y', 'e2e', 'performance', 'visual']);
  assert.deepEqual(new Set(projects.get('e2e').testIgnore), new Set([
    '**/*.visual.spec.ts',
    '**/*.performance.spec.ts',
    '**/accessibility-compatibility.spec.ts',
  ]));
  assert.equal(projects.get('visual').testMatch, '**/*.visual.spec.ts');
  assert.equal(projects.get('a11y').testMatch, '**/accessibility-compatibility.spec.ts');
  assert.equal(projects.get('performance').testMatch, '**/*.performance.spec.ts');
  assert.equal(projects.get('performance').workers, 1, 'performance budgets must run without cross-workload contention');
});

test('fixed Visual Shell build guards its inputs before changing tracked runtime assets', () => {
  const buildScript = path.join(repositoryRoot, 'scripts/build-visual-shell.mjs');
  const source = fs.readFileSync(buildScript, 'utf8');
  const inputs = [
    path.join(repositoryRoot, 'skills', 'brainstorming', 'ui', 'main.tsx'),
    path.join(repositoryRoot, 'skills', 'brainstorming', 'ui', 'styles', 'shell.css'),
  ];
  const assets = [
    'skills/brainstorming/assets/visual-shell/app.js',
    'skills/brainstorming/assets/visual-shell/styles.css',
  ];

  for (const requiredName of ['main.tsx', 'shell.css', 'app.js', 'styles.css']) {
    assert.ok(source.includes(requiredName), `build contract must name ${requiredName}`);
  }
  assert.match(source, /write:\s*false/u, 'esbuild must finish in memory before tracked writes');

  if (inputs.some(input => !fs.existsSync(input))) {
    const before = assets.map(fileDigest);
    const result = childProcess.spawnSync(process.execPath, [buildScript], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0, 'the build must reject absent fixed inputs');
    assert.match(result.stderr, /main\.tsx/u);
    assert.match(result.stderr, /shell\.css/u);
    assert.deepEqual(assets.map(fileDigest), before, 'an input failure must not change tracked assets');
  }
});

test('persistent Visual Session state stays machine-local and outside portability scans', () => {
  const gitignore = fs.readFileSync(path.join(repositoryRoot, '.gitignore'), 'utf8');
  const validator = fs.readFileSync(
    path.join(repositoryRoot, 'scripts', 'ci', 'validate-runtime-assets.js'),
    'utf8',
  );

  assert.match(gitignore, /^\.brainstorm\/$/mu);
  assert.match(
    validator,
    /!filePath\.includes\(`\$\{path\.sep\}\.brainstorm\$\{path\.sep\}`\)/u,
    'the portability exception must match only the .brainstorm path segment',
  );
});
