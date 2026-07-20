const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { chooseRoute, isDelegable } = require('../scripts/pair-task');
const { validPairPlan } = require('./support/pair-plan-fixture');

const PAIR_TASK = path.join(__dirname, '..', 'scripts', 'pair-task');

function testRepo(t) {
  const scratchRoot = process.env.CLAUDE_SCRATCH_DIR || path.join(os.homedir(), '.claude-scratch');
  fs.mkdirSync(path.join(scratchRoot, 'my-claude-code', 'pair-v3-tests'), { recursive: true });
  const root = fs.mkdtempSync(path.join(scratchRoot, 'my-claude-code', 'pair-v3-tests', 'modes-'));
  childProcess.spawnSync('git', ['init', '-q'], { cwd: root });
  fs.writeFileSync(path.join(root, 'a.txt'), 'base\n');
  childProcess.spawnSync('git', ['add', 'a.txt'], { cwd: root });
  childProcess.spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'base'], { cwd: root });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function runPairTask(root, args, env = {}) {
  return childProcess.spawnSync(process.execPath, [PAIR_TASK, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      CODEX_THREAD_ID: '',
      CODEX_SANDBOX: '',
      CLAUDECODE: '',
      PAIR_ALLOW_CROSS_RUNTIME_FALLBACK: '',
      PAIR_REVIEW_TRANSPORT: 'direct',
      ...env,
    },
  });
}

function writeExecutable(file, contents) {
  fs.writeFileSync(file, contents, { mode: 0o755 });
}

function gitIn(root, args) {
  return childProcess.spawnSync('git', args, { cwd: root, encoding: 'utf8' });
}

test('Pair v4 never delegates implementation to a headless worker', () => {
  assert.equal(isDelegable({ risk: 'low', scope: 'local' }), false);
  assert.equal(isDelegable({ risk: 'high', scope: 'local' }), false);
  assert.equal(isDelegable({ risk: 'low', scope: 'contract' }), false);
});

test('chooseRoute escalates an inline attempt straight to the strongest route', () => {
  const task = { id: '9.1', type: 'feature', complexity: 'M', risk: 'high', scope: 'contract', uncertainty: 'low' };
  const ledger = [{
    event: 'attempt.completed',
    taskId: '9.1',
    repositoryId: 'repo-A',
    routeId: 'inline-coordinator',
    action: 'escalate',
    valid: true,
    status: 'completed',
  }];

  assert.equal(chooseRoute(task, 'claude', ledger, {}, 'repo-A').id, 'claude-opus-max');
});

test('Pair v4 returns one whole TDD slice to the visible coordinator and keeps legacy split workers explicit', t => {
  const root = testRepo(t);
  const dataDir = path.join(root, 'pair-data');
  const fakeBin = path.join(root, 'fake-bin');
  fs.mkdirSync(fakeBin);
  writeExecutable(path.join(fakeBin, 'codex'), '#!/bin/sh\nexit 0\n');
  fs.mkdirSync(path.join(root, '.pair'), { recursive: true });
  fs.writeFileSync(path.join(root, '.pair', 'plan.md'), [
    '## Streams',
    '### Stream 1: finite cycle - complexity: S',
    '**Depends on:** none',
    '- [ ] Task 1.1 - deliver one behavior [type:feature] [tdd:cycle] [red:assertion] [risk:low] [scope:local] [uncertainty:low] [ac:AC-1] - files: `feature.test.js`, `feature.js` - tests: `feature.test.js` - red: `node --test feature.test.js` - red-expect: `missing behavior` - verify: `node --test feature.test.js` - **S**',
    '  - **Consumes:** none.',
    '  - **Produces:** `feature.js#feature(): void`',
    '  - **Defect:** the behavior is missing.',
    '  - **Review boundary:** the behavior is independently verifiable.',
    '  - **Test boundary:** integration',
    '## Acceptance Criteria',
    '- [ ] AC-1: the behavior works.',
  ].join('\n'));
  const env = {
    PAIR_SKIP_PLAN_VALIDATION: '1',
    PAIR_DATA_DIR: dataDir,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
  };

  const lite = runPairTask(root, ['--runtime', 'codex', '--once', '--dry-run'], env);
  assert.equal(lite.status, 0, lite.stdout + lite.stderr);
  const liteDryRun = JSON.parse(lite.stdout.slice(lite.stdout.indexOf('{')));
  assert.equal(liteDryRun.workerCommand, undefined);
  assert.equal(liteDryRun.attempt.routeId, 'inline-coordinator');
  assert.equal(liteDryRun.redCommand, undefined);
  assert.equal(liteDryRun.greenCommand, undefined);

  const legacy = runPairTask(root, ['--runtime', 'codex', '--once', '--dry-run', '--legacy-v3'], env);
  assert.equal(legacy.status, 0, legacy.stdout + legacy.stderr);
  const legacyDryRun = JSON.parse(legacy.stdout.slice(legacy.stdout.indexOf('{')));
  assert.ok(legacyDryRun.redCommand);
  assert.ok(legacyDryRun.greenCommand);
});

test('Pair-lite hands an inline TDD cycle back once, not once for RED and again for GREEN', t => {
  const root = testRepo(t);
  const dataDir = path.join(root, 'pair-data');
  fs.mkdirSync(path.join(root, '.pair'), { recursive: true });
  fs.writeFileSync(path.join(root, '.pair', 'plan.md'), [
    '## Streams',
    '### Stream 1: inline cycle - complexity: M',
    '**Depends on:** none',
    '- [ ] Task 2.1 - deliver one risky behavior [type:feature] [tdd:cycle] [red:assertion] [risk:high] [scope:contract] [uncertainty:low] [ac:AC-1] - files: `feature.test.js`, `feature.js` - tests: `feature.test.js` - red: `node --test feature.test.js` - red-expect: `missing behavior` - verify: `node --test feature.test.js` - **M**',
    '  - **Consumes:** none.',
    '  - **Produces:** `feature.js#feature(): void`',
    '  - **Defect:** the behavior is missing.',
    '  - **Review boundary:** the behavior is independently verifiable.',
    '  - **Test boundary:** integration',
    '## Acceptance Criteria',
    '- [ ] AC-1: the behavior works.',
  ].join('\n'));
  const env = { PAIR_SKIP_PLAN_VALIDATION: '1', PAIR_DATA_DIR: dataDir };

  const handoff = runPairTask(root, ['--inline', '--once'], env);
  assert.equal(handoff.status, 0, handoff.stdout + handoff.stderr);
  assert.match(handoff.stdout, /write the failing test first/i);
  assert.doesNotMatch(handoff.stdout, /INLINE TASK BRIEF \(RED\)/);
  const active = JSON.parse(fs.readFileSync(path.join(root, '.pair', 'active-attempt.json'), 'utf8'));
  assert.equal(active.mode, 'inline');
});

test('a quiet verification command is observable and stopped by the no-output guard', t => {
  const root = testRepo(t);
  const dataDir = path.join(root, 'pair-data');
  fs.appendFileSync(path.join(root, '.git', 'info', 'exclude'), '\npair-data/\n');
  fs.mkdirSync(path.join(root, '.pair'), { recursive: true });
  fs.writeFileSync(path.join(root, '.pair', 'plan.md'), [
    '## Streams',
    '### Stream 1: observable gate - complexity: S',
    '**Depends on:** none',
    '- [ ] Task 3.1 - exercise a quiet gate [type:feature] [risk:high] [scope:contract] [uncertainty:low] [ac:AC-1] - files: `owned.js` - verify: `node -e "setTimeout(() => process.exit(0), 2000)"` - **S**',
  ].join('\n'));
  const env = {
    PAIR_SKIP_PLAN_VALIDATION: '1',
    PAIR_DATA_DIR: dataDir,
    PAIR_VERIFY_COMMAND_TIMEOUT_MS: '5000',
    PAIR_VERIFY_STALL_TIMEOUT_MS: '120',
    PAIR_VERIFY_HEARTBEAT_MS: '40',
  };
  const handoff = runPairTask(root, ['--inline', '--once'], env);
  assert.equal(handoff.status, 0, handoff.stdout + handoff.stderr);
  fs.writeFileSync(path.join(root, 'owned.js'), 'module.exports = 1;\n');

  const started = Date.now();
  const complete = runPairTask(root, ['--complete', '--dry-run'], env);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1200, `stall guard should stop the command promptly, took ${elapsed}ms`);
  assert.match(complete.stdout + complete.stderr, /started verification.*3\.1/i);
  assert.match(complete.stdout + complete.stderr, /no output.*terminating|stall/i);
  const active = JSON.parse(fs.readFileSync(path.join(root, '.pair', 'active-attempt.json'), 'utf8'));
  assert.equal(active.phase, 'verifying');
  assert.equal(fs.readFileSync(path.join(root, 'owned.js'), 'utf8'), 'module.exports = 1;\n');
  const events = fs.readFileSync(path.join(root, '.pair', 'events.jsonl'), 'utf8')
    .trim().split('\n').map(line => JSON.parse(line));
  assert.ok(events.some(event => event.event === 'infrastructure.failed' && event.phase === 'verifying'));
  assert.equal(events.some(event => event.event === 'attempt.completed'), false);
});

test('Pair opens an inline attempt with dirty tracked files when Git metadata is read-only', t => {
  const root = testRepo(t);
  const dataDir = path.join(root, 'pair-data');
  const gitDirectory = path.join(root, '.git');
  fs.appendFileSync(path.join(root, '.git', 'info', 'exclude'), '\npair-data/\n');
  fs.mkdirSync(path.join(root, '.pair'), { recursive: true });
  fs.writeFileSync(path.join(root, '.pair', 'plan-review.json'), '{"approval":"old"}\n');
  fs.writeFileSync(path.join(root, '.pair', 'plan.md'), [
    '## Streams',
    '### Stream 1: sandbox snapshot - complexity: M',
    '**Depends on:** none',
    '- [ ] Task 4.1 - open one sandboxed slice [type:feature] [risk:high] [scope:contract] [uncertainty:low] [ac:AC-1] - files: `owned.js` - verify: `node -e "process.exit(0)"` - **M**',
  ].join('\n'));
  gitIn(root, ['add', '.pair/plan-review.json', '.pair/plan.md']);
  gitIn(root, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'pair plan']);
  fs.writeFileSync(path.join(root, '.pair', 'plan-review.json'), '{"approval":"human-override"}\n');
  const indexBefore = fs.readFileSync(path.join(gitDirectory, 'index'));

  fs.chmodSync(gitDirectory, 0o555);
  try {
    const run = runPairTask(root, ['--runtime', 'codex', '--inline', '--once'], {
      PAIR_SKIP_PLAN_VALIDATION: '1',
      PAIR_DATA_DIR: dataDir,
    });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /INLINE TASK BRIEF \(SLICE\)/);
    const active = JSON.parse(fs.readFileSync(path.join(root, '.pair', 'active-attempt.json'), 'utf8'));
    assert.equal(active.snapshot.strategy, 'worktree-copy');
    assert.equal(active.snapshot.commit, null);
    assert.deepEqual(fs.readFileSync(path.join(gitDirectory, 'index')), indexBefore);
  } finally {
    fs.chmodSync(gitDirectory, 0o755);
  }
});

test('bare Pair v4 opens the visible coordinator and never invokes the implementation runtime', t => {
  const root = testRepo(t);
  const dataDir = path.join(root, 'pair-data');
  const fakeBin = path.join(root, 'fake-bin');
  const runtimeLog = path.join(root, 'runtime.log');
  fs.mkdirSync(fakeBin);
  fs.appendFileSync(path.join(root, '.git', 'info', 'exclude'), '\npair-data/\nruntime.log\nfake-bin/\n');
  writeExecutable(path.join(fakeBin, 'codex'), `#!/bin/sh\necho invoked >> ${JSON.stringify(runtimeLog)}\nexit 70\n`);
  fs.mkdirSync(path.join(root, '.pair'), { recursive: true });
  fs.writeFileSync(path.join(root, '.pair', 'plan.md'), [
    '## Streams',
    '### Stream 1: visible implementation - complexity: S',
    '**Depends on:** none',
    '- [ ] Task 1.1 - deliver A [type:feature] [risk:low] [scope:local] [uncertainty:low] [ac:AC-1] - files: `a.js` - verify: `node -e "process.exit(0)"` - **S**',
    '## Acceptance Criteria',
    '- [ ] AC-1: A is delivered.',
  ].join('\n'));
  const env = {
    PAIR_SKIP_PLAN_VALIDATION: '1',
    PAIR_DATA_DIR: dataDir,
    PAIR_TEST_RUNTIME_LOG: runtimeLog,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
    PAIR_HEARTBEAT_MS: '25',
  };

  const run = runPairTask(root, ['--runtime', 'codex', '--once'], env);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /INLINE TASK BRIEF \(SLICE\)/);
  assert.equal(fs.existsSync(runtimeLog), false, 'implementation runtime must not be spawned');
  assert.match(fs.readFileSync(path.join(root, '.pair', 'plan.md'), 'utf8'), /\[-\] Task 1\.1/);
  assert.ok(fs.existsSync(path.join(root, '.pair', 'events.jsonl')));
});

test('bare pair-loop advances actionable Work from implementation through acceptance into the next Review Slice', t => {
  const root = testRepo(t);
  fs.mkdirSync(path.join(root, '.pair'), { recursive: true });
  fs.writeFileSync(path.join(root, '.pair', 'plan.md'), [
    '## Streams',
    '### Stream 1: bare lifecycle - complexity: M',
    '**Depends on:** none',
    '- [ ] Task 1.1 - deliver first behavior [type:feature] [risk:high] [scope:contract] [uncertainty:low] [ac:AC-1] - files: `first.js` - verify: `node -e "require(\'./first.js\')"` - **S**',
    '- [ ] Task 1.2 - deliver second behavior [type:feature] [risk:high] [scope:contract] [uncertainty:low] [ac:AC-1] - files: `second.js` - verify: `node -e "require(\'./second.js\')"` - **S**',
    '## Acceptance Criteria',
    '- [ ] AC-1: both behaviors are delivered.',
  ].join('\n'));
  const env = { PAIR_SKIP_PLAN_VALIDATION: '1' };

  const opened = runPairTask(root, [], env);
  assert.equal(opened.status, 0, opened.stdout + opened.stderr);
  const firstAttempt = JSON.parse(fs.readFileSync(path.join(root, '.pair', 'active-attempt.json'), 'utf8'));
  assert.equal(firstAttempt.taskId, '1.1');
  fs.writeFileSync(path.join(root, 'first.js'), 'module.exports = 1;\n');

  const advanced = runPairTask(root, [], env);
  assert.equal(advanced.status, 0, advanced.stdout + advanced.stderr);
  assert.match(advanced.stdout, /task 1\.1 completed inline and accepted/i);
  assert.match(advanced.stdout, /Task 1\.2: deliver second behavior/);
  const secondAttempt = JSON.parse(fs.readFileSync(path.join(root, '.pair', 'active-attempt.json'), 'utf8'));
  assert.equal(secondAttempt.taskId, '1.2');
  assert.notEqual(secondAttempt.attemptId, firstAttempt.attemptId);
  const plan = fs.readFileSync(path.join(root, '.pair', 'plan.md'), 'utf8');
  assert.match(plan, /- \[x\] Task 1\.1/);
  assert.match(plan, /- \[-\] Task 1\.2/);
});

test('pair-doctor fails without a plan and passes on a valid one', t => {
  const root = testRepo(t);
  const dataDir = path.join(root, 'pair-data');

  const missing = runPairTask(root, ['--doctor'], { PAIR_DATA_DIR: dataDir });
  assert.equal(missing.status, 1, missing.stdout);
  assert.match(missing.stdout, /fail plan — no \.pair\/plan\.md/);

  fs.mkdirSync(path.join(root, '.pair'), { recursive: true });
  fs.writeFileSync(path.join(root, '.pair', 'plan.md'), validPairPlan());
  const healthy = runPairTask(root, ['--doctor'], { PAIR_DATA_DIR: dataDir });
  assert.equal(healthy.status, 0, healthy.stdout + healthy.stderr);
  assert.match(healthy.stdout, /ok {3}plan — \.pair\/plan\.md validates/);
  assert.match(healthy.stdout, /ok {3}event store — \.pair\/events\.jsonl/);
  assert.match(healthy.stdout, /0 fail/);

  const blockedLegacyRoot = path.join(root, 'blocked-legacy-root');
  fs.writeFileSync(blockedLegacyRoot, 'not a directory');
  const withoutLegacy = runPairTask(root, ['--doctor'], {
    PAIR_DATA_DIR: path.join(blockedLegacyRoot, 'pair-data'),
  });
  assert.equal(withoutLegacy.status, 0, withoutLegacy.stdout + withoutLegacy.stderr);
  assert.match(withoutLegacy.stdout, /warn legacy history.*unavailable/i);
  assert.match(withoutLegacy.stdout, /0 fail/);
});

test('pair-doctor accepts autonomous Codex-only execution inside the hosted sandbox', t => {
  const root = testRepo(t);
  const dataDir = path.join(root, 'pair-data');
  fs.mkdirSync(path.join(root, '.pair'), { recursive: true });
  fs.writeFileSync(path.join(root, '.pair', 'plan.md'), validPairPlan());
  const nested = {
    PAIR_DATA_DIR: dataDir,
    CODEX_THREAD_ID: 'thread',
    CODEX_SANDBOX: 'seatbelt',
  };

  const hosted = runPairTask(root, ['--doctor'], nested);
  assert.equal(hosted.status, 0, hosted.stdout + hosted.stderr);
  assert.match(hosted.stdout, /mutation-checked disposable repository snapshots/i);

  const allowed = runPairTask(
    root,
    ['--doctor', '--allow-cross-runtime-fallback'],
    nested,
  );
  assert.equal(allowed.status, 0, allowed.stdout + allowed.stderr);
  assert.match(allowed.stdout, /mutation-checked disposable repository snapshots/i);
});

test('an unresolved restoration failure blocks doctor and new attempts', t => {
  const root = testRepo(t);
  const dataDir = path.join(root, 'pair-data');
  fs.mkdirSync(path.join(root, '.pair'), { recursive: true });
  fs.writeFileSync(path.join(root, '.pair', 'plan.md'), validPairPlan());
  fs.writeFileSync(path.join(root, '.pair', 'restoration-failure.json'), JSON.stringify({
    task_id: '1.1',
    attempt_id: 'attempt-1',
    reason: 'tracked snapshot did not restore exactly',
    remaining_paths: ['PresentationResult.cs'],
  }));

  const doctor = runPairTask(root, ['--doctor'], { PAIR_DATA_DIR: dataDir });
  assert.equal(doctor.status, 1, doctor.stdout + doctor.stderr);
  assert.match(doctor.stdout, /fail restoration/i);
  assert.match(doctor.stdout, /PresentationResult\.cs/);

  const run = runPairTask(root, ['--inline', '--once'], {
    PAIR_DATA_DIR: dataDir,
    PAIR_SKIP_PLAN_VALIDATION: '1',
  });
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stderr, /restoration failure is unresolved/i);
  assert.equal(fs.existsSync(path.join(root, '.pair', 'active-attempt.json')), false);
});

test('a corrupt active snapshot is persisted as a restoration blocker', t => {
  const root = testRepo(t);
  const dataDir = path.join(root, 'pair-data');
  fs.appendFileSync(path.join(root, '.git', 'info', 'exclude'), '\npair-data/\n');
  const env = { PAIR_SKIP_PLAN_VALIDATION: '1', PAIR_DATA_DIR: dataDir };
  const plan = [
    '## Streams',
    '### Stream 1: corrupt snapshot - complexity: M',
    '**Depends on:** none',
    '- [ ] Task 6.1 - reject an unusable baseline [type:feature] [risk:high] [scope:contract] [uncertainty:low] [ac:AC-1] - files: `owned.js` - verify: `node -e "process.exit(0)"` - **M**',
    '',
  ].join('\n');
  fs.mkdirSync(path.join(root, '.pair'), { recursive: true });
  fs.writeFileSync(path.join(root, '.pair', 'plan.md'), plan);

  const handoff = runPairTask(root, ['--inline', '--once'], env);
  assert.equal(handoff.status, 0, handoff.stderr);
  const activePath = path.join(root, '.pair', 'active-attempt.json');
  const active = JSON.parse(fs.readFileSync(activePath, 'utf8'));
  active.snapshot.commit = '0000000000000000000000000000000000000000';
  active.snapshot.dirty = true;
  active.snapshot.trackedDirtyPaths = ['a.txt'];
  fs.writeFileSync(activePath, JSON.stringify(active));

  const complete = runPairTask(root, ['--complete', '--dry-run'], env);
  assert.equal(complete.status, 1, complete.stdout + complete.stderr);
  assert.match(complete.stderr, /snapshot.*blocked|restoration.*blocked/i);
  const marker = JSON.parse(fs.readFileSync(
    path.join(root, '.pair', 'restoration-failure.json'),
    'utf8',
  ));
  assert.equal(marker.task_id, '6.1');
  assert.match(marker.reason, /could not compare.*snapshot/i);
});

test('Pair v4 repeatedly resumes one attempt at its exact phase without manufacturing interruptions', t => {
  const root = testRepo(t);
  const dataDir = path.join(root, 'pair-data');
  fs.appendFileSync(path.join(root, '.git', 'info', 'exclude'), '\npair-data/\n');
  fs.mkdirSync(path.join(root, '.pair'), { recursive: true });
  fs.writeFileSync(path.join(root, '.pair', 'plan.md'), [
    '## Streams',
    '### Stream 1: bounded interruption - complexity: S',
    '**Depends on:** none',
    '- [ ] Task 4.1 - exercise bounded recovery [type:feature] [risk:high] [scope:contract] [uncertainty:low] [ac:AC-1] - files: `owned.js` - verify: `node -e "process.exit(0)"` - **S**',
  ].join('\n'));
  const env = { PAIR_SKIP_PLAN_VALIDATION: '1', PAIR_DATA_DIR: dataDir };

  const first = runPairTask(root, ['--inline', '--once'], env);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const firstActive = JSON.parse(fs.readFileSync(path.join(root, '.pair', 'active-attempt.json'), 'utf8'));
  const second = runPairTask(root, ['--inline', '--once'], env);
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.match(second.stdout, /resuming attempt .* at implementing/i);

  const third = runPairTask(root, ['--inline', '--once'], env);
  assert.equal(third.status, 0, third.stdout + third.stderr);
  assert.match(third.stdout, /resuming attempt .* at implementing/i);
  assert.match(third.stdout, /INLINE TASK BRIEF/);
  assert.doesNotMatch(third.stderr, /unstable|interrupted 2 times/i);
  const active = JSON.parse(fs.readFileSync(path.join(root, '.pair', 'active-attempt.json'), 'utf8'));
  assert.equal(active.attemptId, firstActive.attemptId);
  const events = fs.readFileSync(path.join(root, '.pair', 'events.jsonl'), 'utf8')
    .trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.filter(event => event.event === 'attempt.started').length, 1);
  assert.equal(events.filter(event => event.status === 'interrupted').length, 0);
});

test('inline handoff opens an attempt with a brief and --complete closes it through the pipeline', t => {
  const root = testRepo(t);
  const dataDir = path.join(root, 'pair-data');
  fs.appendFileSync(path.join(root, '.git', 'info', 'exclude'), '\npair-data/\n');
  const env = { PAIR_SKIP_PLAN_VALIDATION: '1', PAIR_DATA_DIR: dataDir };
  const plan = [
    '## Streams',
    '### Stream 1: risky - complexity: M',
    '**Depends on:** none',
    '- [ ] Task 9.1 - implement risky contract change [type:feature] [risk:high] [scope:contract] [uncertainty:low] [ac:AC-1] - files: `src/x.js` - verify: `node -e "process.exit(0)"` - **M**',
    '',
  ].join('\n');
  fs.mkdirSync(path.join(root, '.pair'), { recursive: true });
  fs.writeFileSync(path.join(root, '.pair', 'plan.md'), plan);

  const handoff = runPairTask(root, ['--inline', '--once'], env);
  assert.equal(handoff.status, 0, handoff.stderr);
  assert.match(handoff.stdout, /INLINE TASK BRIEF/);
  assert.match(handoff.stdout, /bare `pair-loop`/);
  assert.match(handoff.stdout, /--complete.*compatibility alias/);
  const active = JSON.parse(fs.readFileSync(path.join(root, '.pair', 'active-attempt.json'), 'utf8'));
  assert.equal(active.mode, 'inline');
  assert.equal(active.taskId, '9.1');
  const started = fs.readFileSync(path.join(root, '.pair', 'events.jsonl'), 'utf8');
  assert.match(started, /"attempt\.started"/);

  // The coordinator implements the task in-session…
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'x.js'), 'module.exports = 1;\n');

  // …then completes the attempt (dry-run stubs only the independent review).
  const complete = runPairTask(root, ['--complete', '--dry-run'], env);
  assert.equal(complete.status, 0, complete.stderr);
  assert.match(complete.stdout, /task 9\.1 completed inline and accepted/);
  assert.match(fs.readFileSync(path.join(root, '.pair', 'plan.md'), 'utf8'), /- \[x\] Task 9\.1/);
  assert.equal(fs.existsSync(path.join(root, '.pair', 'active-attempt.json')), false);
  const ledger = fs.readFileSync(path.join(root, '.pair', 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const completed = ledger.find(record => record.event === 'attempt.completed' && record.taskId === '9.1');
  assert.equal(completed.disposition, 'accepted');
  assert.equal(completed.routeId, 'inline-coordinator');
});

test('review infrastructure failure preserves green work and resumes only the reviewing phase', t => {
  const root = testRepo(t);
  const fakeBin = path.join(root, 'fake-bin');
  fs.mkdirSync(fakeBin);
  writeExecutable(path.join(fakeBin, 'codex'), '#!/bin/sh\nexit 70\n');
  fs.appendFileSync(path.join(root, '.git', 'info', 'exclude'), '\nfake-bin/\nverify-count\n');
  fs.mkdirSync(path.join(root, '.pair'), { recursive: true });
  fs.writeFileSync(path.join(root, '.pair', 'plan.md'), [
    '## Streams',
    '### Stream 1: resumable review - complexity: M',
    '**Depends on:** none',
    '- [ ] Task 7.1 - keep verified work across review outages [type:feature] [risk:high] [scope:contract] [uncertainty:low] [ac:AC-1] - files: `owned.js` - verify: `node -e "require(\'fs\').appendFileSync(\'verify-count\', \'x\')"` - **M**',
    '',
  ].join('\n'));
  const env = {
    PAIR_SKIP_PLAN_VALIDATION: '1',
    PAIR_TASK_REVIEW: 'all',
    PAIR_REVIEW_TIMEOUT_MS: '2000',
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
  };

  const handoff = runPairTask(root, ['--inline', '--once'], env);
  assert.equal(handoff.status, 0, handoff.stdout + handoff.stderr);
  fs.writeFileSync(path.join(root, 'owned.js'), 'module.exports = 7;\n');
  const attemptId = JSON.parse(fs.readFileSync(path.join(root, '.pair', 'active-attempt.json'), 'utf8')).attemptId;

  const failedReview = runPairTask(root, ['--complete'], env);
  assert.equal(failedReview.status, 0, failedReview.stdout + failedReview.stderr);
  const paused = JSON.parse(fs.readFileSync(path.join(root, '.pair', 'active-attempt.json'), 'utf8'));
  assert.equal(paused.attemptId, attemptId);
  assert.equal(paused.phase, 'reviewing');
  assert.equal(paused.verification.status, 'pass');
  assert.equal(fs.readFileSync(path.join(root, 'owned.js'), 'utf8'), 'module.exports = 7;\n');
  assert.equal(fs.readFileSync(path.join(root, 'verify-count'), 'utf8'), 'x');
  const interruptedEvents = fs.readFileSync(path.join(root, '.pair', 'events.jsonl'), 'utf8')
    .trim().split('\n').map(line => JSON.parse(line));
  assert.ok(interruptedEvents.some(event => event.event === 'infrastructure.failed' && event.phase === 'reviewing'));
  assert.equal(interruptedEvents.some(event => event.event === 'attempt.completed' && event.attemptId === attemptId), false);

  const resumed = runPairTask(root, ['--complete', '--dry-run'], env);
  assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
  assert.equal(fs.readFileSync(path.join(root, 'verify-count'), 'utf8'), 'x', 'review resume must not rerun green verification');
  assert.match(fs.readFileSync(path.join(root, '.pair', 'plan.md'), 'utf8'), /- \[x\] Task 7\.1/);
});

test('a material review rejection preserves visible coordinator changes and the same active attempt', t => {
  const root = testRepo(t);
  const fakeBin = path.join(root, 'fake-bin');
  fs.mkdirSync(fakeBin);
  writeExecutable(path.join(fakeBin, 'codex'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const output = args[args.indexOf('--output-last-message') + 1];
fs.writeFileSync(output, JSON.stringify({
  verdict: 'fix-needed',
  recommended_action: 'local-fix',
  summary: 'One reachable implementation defect remains.',
  findings: [{
    severity: 'MAJOR', origin: 'implementation', file: 'owned.js', line: 1,
    title: 'Wrong visible value', detail: 'The exported value is wrong.',
    failure_scenario: 'A caller receives 7 instead of 8.', suggestion: 'Return 8.',
  }],
}));
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'review-visible-1' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\\n');
`);
  fs.appendFileSync(path.join(root, '.git', 'info', 'exclude'), '\nfake-bin/\n');
  fs.mkdirSync(path.join(root, '.pair'), { recursive: true });
  fs.writeFileSync(path.join(root, '.pair', 'plan.md'), [
    '## Streams',
    '### Stream 1: preserved correction - complexity: M',
    '**Depends on:** none',
    '- [ ] Task 7.2 - preserve a reviewed correction [type:feature] [risk:high] [scope:contract] [uncertainty:low] [ac:AC-1] - files: `owned.js` - verify: `node -e "process.exit(0)"` - **M**',
    '',
  ].join('\n'));
  const env = {
    PAIR_SKIP_PLAN_VALIDATION: '1',
    PAIR_TASK_REVIEW: 'all',
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
  };
  const handoff = runPairTask(root, ['--inline', '--once'], env);
  assert.equal(handoff.status, 0, handoff.stdout + handoff.stderr);
  fs.writeFileSync(path.join(root, 'owned.js'), 'module.exports = 7;\n');
  const attemptId = JSON.parse(fs.readFileSync(path.join(root, '.pair', 'active-attempt.json'), 'utf8')).attemptId;

  const reviewed = runPairTask(root, ['--complete'], env);
  assert.equal(reviewed.status, 0, reviewed.stdout + reviewed.stderr);
  assert.match(reviewed.stdout + reviewed.stderr, /preserved.*same attempt|local correction/i);
  assert.equal(fs.readFileSync(path.join(root, 'owned.js'), 'utf8'), 'module.exports = 7;\n');
  const active = JSON.parse(fs.readFileSync(path.join(root, '.pair', 'active-attempt.json'), 'utf8'));
  assert.equal(active.attemptId, attemptId);
  assert.equal(active.phase, 'implementing');
  const events = fs.readFileSync(path.join(root, '.pair', 'events.jsonl'), 'utf8')
    .trim().split('\n').map(JSON.parse);
  assert.ok(events.some(event => event.event === 'attempt.outcome' && event.attemptId === attemptId && event.terminal === false));
  assert.equal(events.some(event => event.event === 'attempt.completed' && event.attemptId === attemptId), false);
});

test('cumulative findings stay actionable and approval records terminal Work completion', t => {
  const root = testRepo(t);
  const fakeBin = path.join(root, 'fake-bin');
  const verdictFile = path.join(root, 'review-verdict');
  fs.mkdirSync(fakeBin);
  writeExecutable(path.join(fakeBin, 'codex'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const output = args[args.indexOf('--output-last-message') + 1];
const needsFix = fs.readFileSync(${JSON.stringify(verdictFile)}, 'utf8').trim() === 'fix';
fs.writeFileSync(output, JSON.stringify(needsFix ? {
  verdict: 'fix-needed', recommended_action: 'local-fix', summary: 'One final defect remains.',
  findings: [{ severity: 'MAJOR', origin: 'implementation', file: 'a.txt', line: 1,
    title: 'Wrong final value', detail: 'The complete patch still has the wrong value.',
    failure_scenario: 'A caller observes wrong instead of right.', suggestion: 'Write right.' }],
} : { verdict: 'approve', recommended_action: 'approve', summary: 'Complete Work is correct.', findings: [] }));
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'review-final-visible' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\\n');
`);
  fs.appendFileSync(path.join(root, '.git', 'info', 'exclude'), '\nfake-bin/\nreview-verdict\n');
  fs.writeFileSync(verdictFile, 'fix\n');
  fs.writeFileSync(path.join(root, 'a.txt'), 'wrong\n');
  fs.mkdirSync(path.join(root, '.pair'), { recursive: true });
  fs.writeFileSync(path.join(root, '.pair', 'plan.md'), [
    '## Streams',
    '### Stream 1: cumulative correction - complexity: S',
    '**Depends on:** none',
    '- [x] Task 7.7 - finish the complete Work [type:feature] [risk:critical] [scope:contract] [uncertainty:low] [ac:AC-1] - files: `a.txt` - verify: `node -e "process.exit(0)"` - **S**',
    '',
    '## Acceptance Criteria',
    '- [x] AC-1: the complete Work is independently approved.',
  ].join('\n'));
  const env = {
    PAIR_SKIP_PLAN_VALIDATION: '1',
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
  };

  const rejected = runPairTask(root, ['--runtime', 'codex', '--once'], env);
  assert.equal(rejected.status, 1, rejected.stdout + rejected.stderr);
  let current = JSON.parse(fs.readFileSync(path.join(root, '.pair', 'current-run.json'), 'utf8'));
  let state = JSON.parse(fs.readFileSync(path.join(root, current.run, 'state.json'), 'utf8'));
  assert.equal(state.lifecycle, 'cumulative-correction');
  assert.equal(state.continuation.resume_target, 'cumulative-correction');
  assert.doesNotMatch(rejected.stderr, /blocked/i);
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'wrong\n');

  fs.writeFileSync(path.join(root, 'a.txt'), 'right\n');
  fs.writeFileSync(verdictFile, 'approve\n');
  const approved = runPairTask(root, ['--runtime', 'codex', '--once'], env);
  assert.equal(approved.status, 0, approved.stdout + approved.stderr);
  current = JSON.parse(fs.readFileSync(path.join(root, '.pair', 'current-run.json'), 'utf8'));
  state = JSON.parse(fs.readFileSync(path.join(root, current.run, 'state.json'), 'utf8'));
  assert.equal(state.lifecycle, 'complete');
  assert.equal(state.active, null);
  const events = fs.readFileSync(path.join(root, current.run, 'events.jsonl'), 'utf8')
    .trim().split('\n').map(JSON.parse);
  assert.ok(events.some(event => event.event === 'work.completed'));
});

test('Pair-authored logs, patches, reviews, reports, and status redact credential canaries', t => {
  const root = testRepo(t);
  const secret = 'sk-proj-PAIRV4CANARY123456789';
  const fakeBin = path.join(root, 'fake-bin');
  fs.mkdirSync(fakeBin);
  writeExecutable(path.join(fakeBin, 'codex'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const output = args[args.indexOf('--output-last-message') + 1];
const secret = ${JSON.stringify(secret)};
fs.writeFileSync(output, JSON.stringify({
  verdict: 'fix-needed', recommended_action: 'local-fix', summary: 'api_key=' + secret,
  findings: [{ severity: 'MAJOR', origin: 'implementation', file: 'owned.js', line: 1,
    title: 'authorization: Bearer ' + secret, detail: 'password=' + secret,
    failure_scenario: 'access_token=' + secret, suggestion: 'client_secret=' + secret }],
}));
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'review-redaction' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'diagnostic', authorization: 'Bearer ' + secret }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'diagnostic', private_reasoning: 'never persist this reasoning' }) + '\\n');
`);
  fs.appendFileSync(path.join(root, '.git', 'info', 'exclude'), '\nfake-bin/\n');
  fs.mkdirSync(path.join(root, '.pair'), { recursive: true });
  fs.writeFileSync(path.join(root, '.pair', 'plan.md'), [
    '## Streams',
    '### Stream 1: secret-safe evidence - complexity: S',
    '**Depends on:** none',
    '- [ ] Task 7.5 - keep Pair evidence secret-safe [type:feature] [risk:high] [scope:contract] [uncertainty:low] [ac:AC-1] - files: `owned.js` - verify: `node -e "process.exit(0)"` - **S**',
    '',
  ].join('\n'));
  const env = {
    PAIR_SKIP_PLAN_VALIDATION: '1',
    PAIR_TASK_REVIEW: 'all',
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
  };
  const handoff = runPairTask(root, ['--inline', '--once'], env);
  assert.equal(handoff.status, 0, handoff.stdout + handoff.stderr);
  fs.writeFileSync(path.join(root, 'owned.js'), `module.exports = { apiKey: "${secret}" };\n`);
  const reviewed = runPairTask(root, ['--complete'], env);
  assert.equal(reviewed.status, 0, reviewed.stdout + reviewed.stderr);

  const scratchBase = process.env.CLAUDE_SCRATCH_DIR || path.join(os.homedir(), '.claude-scratch');
  const roots = [
    path.join(root, '.pair'),
    path.join(scratchBase, path.basename(root), 'pair-v4'),
    path.join(scratchBase, path.basename(root), 'pair-v3'),
  ].filter(candidate => fs.existsSync(candidate));
  const persisted = [];
  for (const artifactRoot of roots) {
    const stack = [artifactRoot];
    while (stack.length > 0) {
      const current = stack.pop();
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const file = path.join(current, entry.name);
        if (entry.isDirectory()) stack.push(file);
        else if (entry.isFile()) persisted.push(fs.readFileSync(file));
      }
    }
  }
  const report = childProcess.spawnSync(
    process.execPath,
    [path.join(__dirname, '..', 'scripts', 'pair-report'), '--json'],
    { cwd: root, encoding: 'utf8' },
  );
  const observable = Buffer.concat([
    ...persisted,
    Buffer.from(reviewed.stdout + reviewed.stderr + report.stdout + report.stderr),
  ]).toString('utf8');
  assert.doesNotMatch(observable, new RegExp(secret));
  assert.doesNotMatch(observable, /never persist this reasoning/);
  assert.match(observable, /\[REDACTED\]/);
});

test('discard is an explicit preview-and-confirm operation that names and then restores only the active attempt paths', t => {
  const root = testRepo(t);
  fs.mkdirSync(path.join(root, '.pair'), { recursive: true });
  fs.writeFileSync(path.join(root, '.pair', 'plan.md'), [
    '## Streams',
    '### Stream 1: explicit discard - complexity: S',
    '**Depends on:** none',
    '- [ ] Task 7.3 - make discard explicit [type:feature] [risk:low] [scope:local] [uncertainty:low] [ac:AC-1] - files: `discarded.js` - verify: `node -e "process.exit(0)"` - **S**',
    '',
  ].join('\n'));
  const env = { PAIR_SKIP_PLAN_VALIDATION: '1' };
  const handoff = runPairTask(root, ['--inline', '--once'], env);
  assert.equal(handoff.status, 0, handoff.stdout + handoff.stderr);
  fs.writeFileSync(path.join(root, 'discarded.js'), 'module.exports = "discard me";\n');
  const attemptId = JSON.parse(fs.readFileSync(path.join(root, '.pair', 'active-attempt.json'), 'utf8')).attemptId;

  const preview = runPairTask(root, ['--discard-attempt'], env);
  assert.equal(preview.status, 0, preview.stdout + preview.stderr);
  assert.match(preview.stdout, new RegExp(attemptId));
  assert.match(preview.stdout, /discarded\.js/);
  assert.match(preview.stdout, /--confirm-discard/);
  assert.equal(fs.existsSync(path.join(root, 'discarded.js')), true, 'preview is read-only');

  const discard = runPairTask(root, ['--discard-attempt', attemptId, '--confirm-discard'], env);
  assert.equal(discard.status, 0, discard.stdout + discard.stderr);
  assert.match(discard.stdout, /explicitly discarded/i);
  assert.equal(fs.existsSync(path.join(root, 'discarded.js')), false);
  assert.equal(fs.existsSync(path.join(root, '.pair', 'active-attempt.json')), false);
  assert.match(fs.readFileSync(path.join(root, '.pair', 'plan.md'), 'utf8'), /\[ \] Task 7\.3/);
  const events = fs.readFileSync(path.join(root, '.pair', 'events.jsonl'), 'utf8')
    .trim().split('\n').map(JSON.parse);
  assert.ok(events.some(event => event.event === 'attempt.outcome' && event.attemptId === attemptId && event.disposition === 'discarded' && event.terminal === true));
});

test('--resume dispatches the exact saved attempt phase in the same invocation', t => {
  const root = testRepo(t);
  fs.mkdirSync(path.join(root, '.pair'), { recursive: true });
  fs.writeFileSync(path.join(root, '.pair', 'plan.md'), [
    '## Streams',
    '### Stream 1: one-command resume - complexity: S',
    '**Depends on:** none',
    '- [ ] Task 7.6 - resume without another push [type:feature] [risk:low] [scope:local] [uncertainty:low] [ac:AC-1] - files: `resume.js` - verify: `node -e "process.exit(0)"` - **S**',
    '',
  ].join('\n'));
  const env = { PAIR_SKIP_PLAN_VALIDATION: '1' };
  const handoff = runPairTask(root, ['--inline', '--once'], env);
  assert.equal(handoff.status, 0, handoff.stdout + handoff.stderr);
  const attemptId = JSON.parse(fs.readFileSync(path.join(root, '.pair', 'active-attempt.json'), 'utf8')).attemptId;
  const paused = runPairTask(root, ['--pause'], env);
  assert.equal(paused.status, 0, paused.stdout + paused.stderr);

  const resumed = runPairTask(root, ['--resume'], env);
  assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
  assert.match(resumed.stdout, new RegExp(`resumed ${attemptId}`));
  assert.match(resumed.stdout, /INLINE TASK BRIEF/);
  assert.match(resumed.stdout, /resume without another push/i);
});

test('accepting the last mapped Stream task closes its acceptance criterion without another attempt', t => {
  const root = testRepo(t);
  const dataDir = path.join(root, 'pair-data');
  fs.appendFileSync(path.join(root, '.git', 'info', 'exclude'), '\npair-data/\n');
  const env = { PAIR_SKIP_PLAN_VALIDATION: '1', PAIR_DATA_DIR: dataDir };
  const plan = [
    '## Streams',
    '### Stream 1: finite - complexity: S',
    '**Depends on:** none',
    '- [ ] Task 1.1 - deliver one finite slice [type:feature] [risk:high] [scope:contract] [uncertainty:low] [ac:AC-1] - files: `src/x.js` - verify: `node -e "process.exit(0)"` - **S**',
    '',
    '## Acceptance Criteria',
    '- [ ] AC-1: the finite slice is delivered.',
  ].join('\n');
  fs.mkdirSync(path.join(root, '.pair'), { recursive: true });
  fs.writeFileSync(path.join(root, '.pair', 'plan.md'), plan);

  const handoff = runPairTask(root, ['--inline', '--once'], env);
  assert.equal(handoff.status, 0, handoff.stdout + handoff.stderr);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'x.js'), 'module.exports = 1;\n');

  const complete = runPairTask(root, ['--complete', '--dry-run'], env);
  assert.equal(complete.status, 0, complete.stdout + complete.stderr);
  const completedPlan = fs.readFileSync(path.join(root, '.pair', 'plan.md'), 'utf8');
  assert.match(completedPlan, /- \[x\] Task 1\.1/);
  assert.match(completedPlan, /- \[x\] AC-1:/);

  const rerun = runPairTask(root, ['--inline', '--once', '--dry-run'], env);
  assert.equal(rerun.status, 0, rerun.stdout + rerun.stderr);
  assert.match(rerun.stdout, /all plan tasks complete/);
  assert.doesNotMatch(rerun.stdout, /"taskId":\s*"AC-1"/);
});

test('an inline incorrect-plan result stops for promotion without mutating the approved plan', t => {
  const root = testRepo(t);
  const dataDir = path.join(root, 'pair-data');
  fs.appendFileSync(path.join(root, '.git', 'info', 'exclude'), '\npair-data/\n');
  const env = { PAIR_SKIP_PLAN_VALIDATION: '1', PAIR_DATA_DIR: dataDir };
  const plan = [
    '## Streams',
    '### Stream 1: contract - complexity: M',
    '**Depends on:** none',
    '- [ ] Task 8.1 - prove a durable contract [type:test] [phase:red] [tdd:red-contract] [red:assertion] [risk:high] [scope:contract] [uncertainty:low] [ac:AC-1] - files: `contract.test.js` - tests: `contract.test.js` - red: `node -e "process.exit(0)"` - red-expect: `expected failure` - verify: `node -e "process.exit(0)"` - **M**',
    '',
  ].join('\n');
  fs.mkdirSync(path.join(root, '.pair'), { recursive: true });
  fs.writeFileSync(path.join(root, '.pair', 'plan.md'), plan);

  const handoff = runPairTask(root, ['--inline', '--once'], env);
  assert.equal(handoff.status, 0, handoff.stderr);
  assert.match(handoff.stdout, /INLINE TASK BRIEF \(RED\)/);

  const complete = runPairTask(root, ['--complete', '--dry-run'], env);
  assert.equal(complete.status, 0, complete.stdout + complete.stderr);
  assert.match(complete.stdout, /blocked on a material decision/i);
  const activePlan = fs.readFileSync(path.join(root, '.pair', 'plan.md'), 'utf8');
  const { planContractDigest } = require('../scripts/lib/pair-core');
  assert.equal(planContractDigest(activePlan), planContractDigest(plan));
  assert.match(activePlan, /\[-\] Task 8\.1/, 'only derived active progress may change');
  const active = JSON.parse(fs.readFileSync(path.join(root, '.pair', 'active-attempt.json'), 'utf8'));
  assert.equal(active.phase, 'blocked');
});

test('ordinary additional repository files stay in the implementation and complete with an attribution warning', t => {
  const root = testRepo(t);
  const dataDir = path.join(root, 'pair-data');
  fs.appendFileSync(path.join(root, '.git', 'info', 'exclude'), '\npair-data/\n');
  const env = { PAIR_SKIP_PLAN_VALIDATION: '1', PAIR_DATA_DIR: dataDir };
  const plan = [
    '## Streams',
    '### Stream 1: boundary - complexity: M',
    '**Depends on:** none',
    '- [ ] Task 7.1 - change only the declared file [type:feature] [risk:high] [scope:contract] [uncertainty:low] [ac:AC-1] - files: `owned.js` - verify: `node -e "process.exit(0)"` - **M**',
    '',
  ].join('\n');
  fs.mkdirSync(path.join(root, '.pair'), { recursive: true });
  fs.writeFileSync(path.join(root, '.pair', 'plan.md'), plan);

  const firstHandoff = runPairTask(root, ['--inline', '--once'], env);
  assert.equal(firstHandoff.status, 0, firstHandoff.stderr);
  fs.writeFileSync(path.join(root, 'a.txt'), 'outside attempt one\n');
  const complete = runPairTask(root, ['--complete', '--dry-run'], env);
  assert.equal(complete.status, 0, complete.stdout + complete.stderr);
  assert.match(complete.stdout + complete.stderr, /attribution warning.*a\.txt/i);
  assert.match(complete.stdout, /accepted \(complete-task\)/);
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'outside attempt one\n');
  assert.match(fs.readFileSync(path.join(root, '.pair', 'plan.md'), 'utf8'), /\[x\] Task 7\.1/);
});

test('a narrow hard boundary blocks with the exact path but never silently restores visible work', t => {
  const root = testRepo(t);
  fs.mkdirSync(path.join(root, '.pair'), { recursive: true });
  fs.writeFileSync(path.join(root, '.pair', 'plan.md'), [
    '## Streams',
    '### Stream 1: hard boundary - complexity: S',
    '**Depends on:** none',
    '- [ ] Task 7.4 - respect credential boundaries [type:feature] [risk:high] [scope:contract] [uncertainty:low] [ac:AC-1] - files: `owned.js` - verify: `node -e "process.exit(0)"` - **S**',
    '',
  ].join('\n'));
  const env = { PAIR_SKIP_PLAN_VALIDATION: '1' };
  const handoff = runPairTask(root, ['--inline', '--once'], env);
  assert.equal(handoff.status, 0, handoff.stdout + handoff.stderr);
  fs.writeFileSync(path.join(root, 'owned.js'), 'module.exports = true;\n');
  fs.writeFileSync(path.join(root, '.env'), 'PAIR_TEST_SECRET=do-not-delete\n');

  const complete = runPairTask(root, ['--complete', '--dry-run'], env);
  assert.equal(complete.status, 0, complete.stdout + complete.stderr);
  assert.match(complete.stdout + complete.stderr, /hard boundary.*\.env/i);
  assert.equal(fs.readFileSync(path.join(root, 'owned.js'), 'utf8'), 'module.exports = true;\n');
  assert.equal(fs.readFileSync(path.join(root, '.env'), 'utf8'), 'PAIR_TEST_SECRET=do-not-delete\n');
  const active = JSON.parse(fs.readFileSync(path.join(root, '.pair', 'active-attempt.json'), 'utf8'));
  assert.equal(active.phase, 'blocked');
});
