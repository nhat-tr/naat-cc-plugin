const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

// Most tests exercise reviewer contracts with fake runtimes. The dedicated tmux-host
// integration suite proves the canonical visible transport itself.
process.env.PAIR_REVIEW_TRANSPORT = 'direct';

const {
  buildReviewCommand,
  classifyChallengeAttempt,
  planReviewPrompt,
  recordPlanApproval,
  resolveRuntimeCandidates,
  reviewIsClean,
  reviewIsSchemaShaped,
} = require('../scripts/pair-plan-challenge');
const {
  createWorkRoot,
  validateWorkDirectory,
} = require('../../brainstorming/scripts/work-lineage.cjs');
const { planContractDigest } = require('../scripts/lib/pair-core');
const { pairStatePaths } = require('../scripts/lib/pair-state');
const { validPairPlan } = require('./support/pair-plan-fixture');

const PAIR_TASK = path.resolve(__dirname, '../scripts/pair-task');

function repository(t) {
  const scratchRoot = process.env.CLAUDE_SCRATCH_DIR || path.join(os.homedir(), '.claude-scratch');
  const parent = path.join(scratchRoot, 'my-claude-code', 'pair-plan-challenge');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'repo-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function environmentReview(detail = 'sandbox-exec: sandbox_apply: Operation not permitted') {
  return {
    verdict: 'fix-needed',
    summary: 'The repository could not be read.',
    findings: [{
      severity: 'BLOCKER',
      origin: 'environment',
      category: 'evidence',
      task_id: null,
      line: 1,
      title: 'Review evidence was unavailable',
      detail,
      failure_scenario: 'The reviewer would guess about an unread plan.',
      suggestion: 'Run a fresh reviewer in a working read-only environment.',
    }],
  };
}

function planReview() {
  return {
    verdict: 'fix-needed',
    summary: 'Task 1.1 consumes a contract that does not exist.',
    findings: [{
      severity: 'BLOCKER',
      origin: 'plan',
      category: 'interfaces',
      task_id: '1.1',
      line: 38,
      title: 'Consumed contract is absent',
      detail: 'The named repository symbol is not present.',
      failure_scenario: 'The worker cannot compile the first Review Slice.',
      suggestion: 'Produce the contract in an earlier Review Slice.',
    }],
  };
}

function writeExecutable(file, source) {
  fs.writeFileSync(file, source, { mode: 0o700 });
}

test('plan challenge creates persistent read-only Review Sessions on Codex and Claude', () => {
  const root = '/repo';
  const prompt = 'challenge this digest';
  const outputPath = '/scratch/review.json';
  const codex = buildReviewCommand({ runtime: 'codex', root, prompt, outputPath, model: 'gpt-test', effort: 'high' });
  assert.equal(codex.file, 'codex');
  assert.deepEqual(codex.args.slice(0, 4), ['exec', '--json', '--sandbox', 'read-only']);
  assert.equal(codex.args.includes('--ephemeral'), false);
  assert.ok(codex.args.includes('--output-schema'));
  assert.ok(codex.args.includes('--output-last-message'));
  assert.ok(codex.args.includes('gpt-test'));
  assert.equal(codex.args.at(-1), prompt);
  assert.equal(codex.args.includes('review'), false, 'custom prompt uses generic codex exec, not codex exec review');

  const claude = buildReviewCommand({ runtime: 'claude', root, prompt, outputPath, model: 'opus', effort: 'high' });
  assert.equal(claude.file, 'claude');
  assert.ok(claude.args.includes('--json-schema'));
  assert.equal(claude.args.includes('--no-session-persistence'), false);
  assert.ok(claude.args.includes('--session-id'));
  assert.ok(claude.args.includes('Edit,Write,NotebookEdit,Task'));
  assert.equal(claude.args.some(arg => arg.includes('MultiEdit')), false);
  assert.ok(claude.args.includes('opus'));
});

test('plan challenge resumes the saved Codex and Claude Review Session without a cache ping', () => {
  const codex = buildReviewCommand({
    runtime: 'codex', root: '/repo', prompt: 'review next digest', outputPath: '/scratch/review.json',
    reviewerSessionId: '01900000-0000-7000-8000-000000000001',
  });
  assert.deepEqual(codex.args.slice(0, 4), ['exec', 'resume', '--json', '--output-schema']);
  assert.ok(codex.args.includes('01900000-0000-7000-8000-000000000001'));
  assert.equal(codex.args.some(arg => /ping|warm|cache/i.test(arg)), false);

  const claude = buildReviewCommand({
    runtime: 'claude', root: '/repo', prompt: 'review next digest', outputPath: '/scratch/review.json',
    reviewerSessionId: '01900000-0000-7000-8000-000000000002',
  });
  assert.ok(claude.args.includes('--resume'));
  assert.ok(claude.args.includes('01900000-0000-7000-8000-000000000002'));
  assert.equal(claude.args.includes('--session-id'), false);
});

test('plan challenge defaults to medium effort and one bounded evidence sweep', () => {
  const prompt = planReviewPrompt({
    planPath: '.pair/plan.md',
    specPath: 'docs/work/example/spec.md',
    digest: 'current-digest',
  });
  const command = buildReviewCommand({
    runtime: 'codex',
    root: '/repo',
    prompt,
    outputPath: '/scratch/review.json',
  });

  assert.ok(command.args.includes('model_reasoning_effort="medium"'));
  assert.match(prompt, /at most 8 shell commands/i);
  assert.match(prompt, /at most 250 output lines per command/i);
  assert.match(prompt, /progress-stable contract digest/i);
  assert.match(prompt, /not the raw file SHA-256/i);
  assert.match(prompt, /parent process verifies.*before and after/i);
  assert.match(prompt, /report all material findings in this verdict/i);
});

test('a revised plan challenge carries prior findings into a bounded closure review', () => {
  const priorReview = {
    plan_digest: 'prior-digest',
    findings: [{
      severity: 'BLOCKER',
      origin: 'plan',
      task_id: '2.1',
      title: 'Retained affordances have no implementable contract',
      detail: 'The task does not produce the required contract.',
      failure_scenario: 'The worker cannot implement the mapped acceptance criterion.',
      suggestion: 'Declare the contract and ownership.',
    }],
  };
  const prompt = planReviewPrompt({
    planPath: '.pair/plan.md',
    specPath: 'docs/work/example/spec.md',
    digest: 'current-digest',
    priorReview,
  });

  assert.match(prompt, /prior-digest/);
  assert.match(prompt, /Retained affordances have no implementable contract/);
  assert.match(prompt, /closure review/i);
  assert.match(prompt, /changed or directly affected contracts/i);
});

test('an unchanged digest retries a reviewer-contract failure as a closure review', () => {
  const priorReview = {
    plan_digest: 'current-digest',
    findings: [{
      severity: 'BLOCKER',
      origin: 'plan',
      task_id: null,
      title: 'Raw file hash differs from the contract digest',
      detail: 'The reviewer compared incompatible digest contracts.',
      failure_scenario: 'A valid plan cannot pass the challenge gate.',
      suggestion: 'Use Pair contract evidence.',
    }],
  };
  const prompt = planReviewPrompt({
    planPath: '.pair/plan.md',
    specPath: 'docs/work/example/spec.md',
    digest: 'current-digest',
    priorReview,
  });

  assert.match(prompt, /closure review/i);
  assert.match(prompt, /unchanged plan digest/i);
  assert.match(prompt, /Raw file hash differs from the contract digest/);
});

test('the challenge process forwards the previous digest findings to the fresh reviewer', t => {
  const fixture = challengeFixture(t, 'finding-closure-challenge');
  const promptLog = path.join(fixture.scratchRoot, 'prompt.log');
  fs.writeFileSync(path.join(fixture.root, '.pair', 'plan-review.json'), JSON.stringify({
    schema: 1,
    plan_digest: 'prior-digest',
    reviewer: 'codex/default',
    verdict: 'fix-needed',
    summary: 'one blocker',
    findings: [{
      severity: 'BLOCKER',
      origin: 'plan',
      category: 'interfaces',
      task_id: '2.1',
      line: 42,
      title: 'Prior contract blocker',
      detail: 'The contract was not produced.',
      failure_scenario: 'The worker cannot compile.',
      suggestion: 'Produce the contract.',
    }],
  }));
  writeExecutable(path.join(fixture.fakeBin, 'codex'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const output = args[args.indexOf('--output-last-message') + 1];
fs.writeFileSync(process.env.PAIR_TEST_PROMPT_LOG, args.at(-1));
fs.writeFileSync(output, JSON.stringify({ verdict: 'approve', summary: 'closed', findings: [] }));
process.stdout.write('{"type":"turn.completed"}\\n');
`);

  const result = childProcess.spawnSync(
    process.execPath,
    [path.resolve(__dirname, '../scripts/pair-plan-challenge'), '--runtime', 'codex'],
    {
      cwd: fixture.root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fixture.fakeBin}${path.delimiter}${process.env.PATH || ''}`,
        CLAUDE_SCRATCH_DIR: fixture.scratchRoot,
        PAIR_DATA_DIR: path.join(fixture.scratchRoot, 'pair-data'),
        PAIR_TEST_PROMPT_LOG: promptLog,
        CODEX_THREAD_ID: 'coordinator-thread',
        CODEX_SANDBOX: 'seatbelt',
        CLAUDECODE: '',
      },
    },
  );

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(fs.readFileSync(promptLog, 'utf8'), /Prior contract blocker/);
  assert.match(fs.readFileSync(promptLog, 'utf8'), /closure review/i);
});

function spawnChallenge(root, fakeBin, scratchRoot, extraEnv = {}) {
  const child = childProcess.spawn(
    process.execPath,
    [path.resolve(__dirname, '../scripts/pair-plan-challenge'), '--runtime', 'claude'],
    {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
        CLAUDE_SCRATCH_DIR: scratchRoot,
        PAIR_DATA_DIR: path.join(scratchRoot, 'pair-data'),
        CODEX_THREAD_ID: 'coordinator-thread',
        CODEX_SANDBOX: '',
        CLAUDECODE: '',
        PAIR_DEFAULT_RUNTIME: '',
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const completed = new Promise(resolve => {
    child.on('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
  return { child, completed, stderr: () => stderr };
}

function challengeFixture(t, suffix) {
  const root = repository(t);
  const workId = `work-20260718-${suffix}`;
  const spec = [
    `# ${suffix}`,
    '',
    `- **Work ID:** \`${workId}\``,
    '',
    '## Engineering Quality Contract',
    '',
    'An independent digest-bound plan challenge is required before implementation.',
    '',
  ].join('\n');
  childProcess.spawnSync('git', ['init', '-q'], { cwd: root });
  createWorkRoot({ repositoryRoot: root, workId, canonicalSpec: spec });
  fs.writeFileSync(path.join(root, '.pair', 'plan.md'), validPairPlan());
  const fakeBin = path.join(root, 'fake-bin');
  const scratchParent = process.env.CLAUDE_SCRATCH_DIR || path.join(os.homedir(), '.claude-scratch');
  fs.mkdirSync(path.join(scratchParent, 'my-claude-code', 'pair-plan-challenge-tests'), { recursive: true });
  const scratchRoot = fs.mkdtempSync(path.join(scratchParent, 'my-claude-code', 'pair-plan-challenge-tests', 'scratch-'));
  t.after(() => fs.rmSync(scratchRoot, { recursive: true, force: true }));
  fs.mkdirSync(fakeBin);
  return { root, workId, fakeBin, scratchRoot };
}

test('plan challenge executes the real reviewer command in the visible reusable pane', t => {
  if (childProcess.spawnSync('tmux', ['-V']).status !== 0) return t.skip('tmux unavailable');
  const fixture = challengeFixture(t, 'visible-review-pane');
  writeExecutable(path.join(fixture.fakeBin, 'codex'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const output = args[args.indexOf('--output-last-message') + 1];
fs.writeFileSync(output, JSON.stringify({ verdict: 'approve', summary: 'visible approval', findings: [] }));
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'visible-plan-review-session' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'diagnostic', message: 'VISIBLE_PLAN_REVIEW' }) + '\\n');
`);
  const result = childProcess.spawnSync(
    process.execPath,
    [path.resolve(__dirname, '../scripts/pair-plan-challenge'), '--runtime', 'codex'],
    {
      cwd: fixture.root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PAIR_REVIEW_TRANSPORT: 'tmux',
        PATH: `${fixture.fakeBin}${path.delimiter}${process.env.PATH || ''}`,
        CLAUDE_SCRATCH_DIR: fixture.scratchRoot,
        PAIR_DATA_DIR: '',
        CODEX_THREAD_ID: '',
        CODEX_SANDBOX: '',
        CLAUDECODE: '',
      },
    },
  );
  const host = JSON.parse(fs.readFileSync(path.join(fixture.root, '.pair', 'tmux.json'), 'utf8'));
  t.after(() => childProcess.spawnSync('tmux', ['kill-session', '-t', `=${host.session}`]));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const captured = childProcess.spawnSync(
    'tmux', ['capture-pane', '-p', '-t', host.panes.reviewer, '-S', '-100'], { encoding: 'utf8' },
  );
  assert.equal(captured.status, 0, captured.stderr);
  assert.match(captured.stdout.replace(/\s+/gu, ''), /VISIBLE_PLAN_REVIEW/);
  const reviewSession = JSON.parse(fs.readFileSync(
    path.join(pairStatePaths(fixture.root, fixture.workId).directory, 'review-session.json'),
    'utf8',
  ));
  assert.equal(reviewSession.session_id, 'visible-plan-review-session');
});

test('plan challenge reports start and heartbeats while the reviewer is still running', async t => {
  const fixture = challengeFixture(t, 'observable-challenge');
  writeExecutable(path.join(fixture.fakeBin, 'claude'), `#!/usr/bin/env node
setTimeout(() => {
  process.stdout.write(JSON.stringify({ structured_output: { verdict: 'approve', summary: 'The exact digest is executable.', findings: [] } }));
}, 800);
`);

  const run = spawnChallenge(fixture.root, fixture.fakeBin, fixture.scratchRoot, {
    PAIR_PLAN_REVIEW_HEARTBEAT_MS: '60',
    PAIR_PLAN_REVIEW_STALL_TIMEOUT_MS: '2000',
    PAIR_PLAN_REVIEW_TIMEOUT_MS: '3000',
  });
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('challenge emitted no start signal')), 600);
    run.child.stderr.on('data', () => {
      if (run.stderr().includes('started claude/default')) {
        clearTimeout(deadline);
        resolve();
      }
    });
  });
  assert.equal(run.child.exitCode, null, 'start signal must arrive before reviewer completion');
  const runDirectory = run.stderr().match(/attempts: ([^)]+)/)?.[1];
  assert.ok(runDirectory, 'start signal names the preserved attempt directory');
  assert.equal(fs.existsSync(path.join(runDirectory, 'attempt-1-claude.stdout')), true);
  assert.equal(fs.existsSync(path.join(runDirectory, 'attempt-1-claude.stderr')), true);
  const result = await run.completed;
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /still waiting.*reviewer output 0 bytes/i);
});

test('plan challenge terminates a zero-output stall before the hard timeout and records why', async t => {
  const fixture = challengeFixture(t, 'stalled-challenge');
  writeExecutable(path.join(fixture.fakeBin, 'claude'), `#!/usr/bin/env node
setInterval(() => {}, 1000);
`);
  const startedAt = Date.now();
  const run = spawnChallenge(fixture.root, fixture.fakeBin, fixture.scratchRoot, {
    PAIR_PLAN_REVIEW_HEARTBEAT_MS: '30',
    PAIR_PLAN_REVIEW_STALL_TIMEOUT_MS: '120',
    PAIR_PLAN_REVIEW_TIMEOUT_MS: '1500',
  });
  const result = await run.completed;
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.ok(Date.now() - startedAt < 1000, 'stall deadline must win over the hard deadline');
  assert.match(result.stderr, /stalled after .* with no reviewer output/i);

  const digestRoot = path.join(fixture.scratchRoot, path.basename(fixture.root), 'pair-plan-challenge');
  const digestDirectory = path.join(digestRoot, fs.readdirSync(digestRoot)[0]);
  const runDirectory = path.join(digestDirectory, fs.readdirSync(digestDirectory)[0]);
  const metadataFile = fs.readdirSync(runDirectory).find(file => file.endsWith('.metadata.json'));
  const metadata = JSON.parse(fs.readFileSync(path.join(runDirectory, metadataFile), 'utf8'));
  assert.equal(metadata.termination, 'stall-timeout');
  assert.equal(metadata.stdout_bytes, 0);
  assert.equal(metadata.stderr_bytes, 0);
});

test('interrupting a challenge terminates the reviewer and never falls back', async t => {
  const fixture = challengeFixture(t, 'interrupted-challenge');
  const reviewerPidFile = path.join(fixture.root, 'reviewer.pid');
  writeExecutable(path.join(fixture.fakeBin, 'claude'), `#!/usr/bin/env node
require('node:fs').writeFileSync(process.env.PAIR_TEST_REVIEWER_PID, String(process.pid));
setInterval(() => {}, 1000);
`);
  const run = spawnChallenge(fixture.root, fixture.fakeBin, fixture.scratchRoot, {
    PAIR_TEST_REVIEWER_PID: reviewerPidFile,
    PAIR_PLAN_REVIEW_HEARTBEAT_MS: '50',
    PAIR_PLAN_REVIEW_STALL_TIMEOUT_MS: '2000',
    PAIR_PLAN_REVIEW_TIMEOUT_MS: '3000',
  });
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('reviewer never started')), 1000);
    const poll = setInterval(() => {
      if (fs.existsSync(reviewerPidFile) && run.stderr().includes('started claude/default')) {
        clearInterval(poll);
        clearTimeout(deadline);
        resolve();
      }
    }, 10);
  });
  const runDirectory = run.stderr().match(/attempts: ([^)]+)/)?.[1];
  run.child.kill('SIGINT');
  const result = await run.completed;
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /challenge interrupted/i);

  const metadata = JSON.parse(fs.readFileSync(
    path.join(runDirectory, 'attempt-1-claude.metadata.json'),
    'utf8',
  ));
  assert.equal(metadata.termination, 'interrupted');
  const reviewerPid = Number(fs.readFileSync(reviewerPidFile, 'utf8'));
  assert.throws(() => process.kill(reviewerPid, 0), /ESRCH/);
});

test('only an empty approved plan challenge is clean', () => {
  assert.equal(reviewIsClean({ verdict: 'approve', summary: 'clean', findings: [] }), true);
  assert.equal(reviewIsClean({ verdict: 'fix-needed', summary: 'bad', findings: [] }), false);
  assert.equal(reviewIsClean({ verdict: 'approve', summary: 'contradiction', findings: [{}] }), false);
});

test('challenge result provenance distinguishes plan findings from reviewer environment failures', () => {
  const approved = { verdict: 'approve', summary: 'clean', findings: [] };

  assert.equal(reviewIsSchemaShaped(approved), true);
  assert.equal(reviewIsSchemaShaped(environmentReview()), true);
  assert.equal(reviewIsSchemaShaped(planReview()), true);
  assert.equal(classifyChallengeAttempt({ run: { status: 0 }, review: approved }).kind, 'approved');
  assert.equal(classifyChallengeAttempt({ run: { status: 0 }, review: planReview() }).kind, 'plan-findings');
  assert.equal(classifyChallengeAttempt({ run: { status: 0 }, review: environmentReview() }).kind, 'environment-failure');
  assert.equal(classifyChallengeAttempt({ run: { status: 71 }, review: null }).kind, 'environment-failure');
  assert.equal(classifyChallengeAttempt({ run: { status: 0 }, review: { verdict: 'approve' } }).kind, 'environment-failure');
});

test('legacy sandbox diagnostics are environment failures even without the new origin field', () => {
  const legacy = environmentReview();
  delete legacy.findings[0].origin;

  assert.equal(reviewIsSchemaShaped(legacy), false);
  assert.equal(
    classifyChallengeAttempt({ run: { status: 0 }, review: legacy }).kind,
    'environment-failure',
  );
});

test('auto runtime selection stays coordinator-affine inside a hosted Codex sandbox', () => {
  const available = ['codex', 'claude'];
  const nestedCodex = { CODEX_THREAD_ID: 'thread', CODEX_SANDBOX: 'seatbelt' };

  assert.deepEqual(
    resolveRuntimeCandidates('auto', { available, env: nestedCodex }),
    ['codex'],
  );
  assert.deepEqual(
    resolveRuntimeCandidates('auto', {
      available,
      env: nestedCodex,
      allowCrossRuntimeFallback: true,
    }),
    ['codex', 'claude'],
  );
  assert.deepEqual(
    resolveRuntimeCandidates('codex', { available, env: nestedCodex }),
    ['codex'],
  );
  assert.deepEqual(
    resolveRuntimeCandidates('codex', { available, env: {} }),
    ['codex'],
  );
  assert.deepEqual(
    resolveRuntimeCandidates('auto', { available, env: { CODEX_THREAD_ID: 'thread' } }),
    ['codex'],
  );
  assert.deepEqual(
    resolveRuntimeCandidates('auto', {
      available,
      env: { CODEX_THREAD_ID: 'thread' },
      allowCrossRuntimeFallback: true,
    }),
    ['codex', 'claude'],
  );
});

test('nested Codex caches an exact approval without Claude or a host handoff', t => {
  const fixture = challengeFixture(t, 'codex-only-challenge');
  const planFile = path.join(fixture.root, '.pair', 'plan.md');
  fs.writeFileSync(
    planFile,
    fs.readFileSync(planFile, 'utf8').replace('- [ ] Task 1.1', '- [x] Task 1.1'),
  );
  const expectedDigest = planContractDigest(
    fs.readFileSync(planFile, 'utf8'),
  );
  const runtimeLog = path.join(fixture.scratchRoot, 'runtime.log');
  fs.writeFileSync(
    path.join(fixture.root, '.pair', 'plan-review.json'),
    JSON.stringify({
      schema: 1,
      plan_digest: '0'.repeat(64),
      verdict: 'approve',
      summary: 'stale approval evidence',
      findings: [],
    }),
  );
  fs.writeFileSync(
    path.join(fixture.root, '.pair', 'plan-review.md'),
    '# Stale approval evidence\n',
  );
  writeExecutable(path.join(fixture.fakeBin, 'codex'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const output = args[args.indexOf('--output-last-message') + 1];
const contract = JSON.parse(fs.readFileSync(path.join(process.cwd(), '.pair', 'plan-contract.json'), 'utf8'));
fs.mkdirSync(require('node:path').dirname(process.env.PAIR_TEST_RUNTIME_LOG), { recursive: true });
fs.appendFileSync(process.env.PAIR_TEST_RUNTIME_LOG, JSON.stringify({
  runtime: 'codex',
  args,
  cwd: process.cwd(),
  contract,
  staleReviewPresent: fs.existsSync(path.join(process.cwd(), '.pair', 'plan-review.json')),
}) + '\\n');
fs.writeFileSync(output, JSON.stringify({ verdict: 'approve', summary: 'The exact digest is executable.', findings: [] }));
process.stdout.write('{"type":"turn.completed"}\\n');
`);
  writeExecutable(path.join(fixture.fakeBin, 'claude'), `#!/usr/bin/env node
require('node:fs').appendFileSync(process.env.PAIR_TEST_RUNTIME_LOG, JSON.stringify({ runtime: 'claude' }) + '\\n');
`);

  for (const runtime of ['auto', 'codex']) {
    const result = childProcess.spawnSync(
      process.execPath,
      [path.resolve(__dirname, '../scripts/pair-plan-challenge'), '--runtime', runtime],
      {
        cwd: fixture.root,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${fixture.fakeBin}${path.delimiter}${process.env.PATH || ''}`,
          CLAUDE_SCRATCH_DIR: fixture.scratchRoot,
          PAIR_DATA_DIR: path.join(fixture.scratchRoot, 'pair-data'),
          PAIR_TEST_RUNTIME_LOG: runtimeLog,
          CODEX_THREAD_ID: 'coordinator-thread',
          CODEX_SANDBOX: 'seatbelt',
          CLAUDECODE: '',
          PAIR_DEFAULT_RUNTIME: '',
          PAIR_ALLOW_CROSS_RUNTIME_FALLBACK: '',
        },
      },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.doesNotMatch(result.stderr, /host terminal/i);
  }
  const invocations = fs.readFileSync(runtimeLog, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(invocations.map(entry => entry.runtime), ['codex']);
  for (const invocation of invocations) {
    assert.ok(invocation.args.includes('--dangerously-bypass-approvals-and-sandbox'));
    assert.ok(invocation.args.includes('--skip-git-repo-check'));
    assert.notEqual(invocation.cwd, fixture.root, 'reviewer must run against a disposable snapshot');
    assert.match(invocation.cwd, /review-snapshot-/);
    assert.equal(invocation.contract.plan_digest, expectedDigest);
    assert.match(invocation.contract.raw_plan_sha256, /^[a-f0-9]{64}$/);
    assert.notEqual(invocation.contract.raw_plan_sha256, expectedDigest);
    assert.equal(invocation.staleReviewPresent, false);
  }
});

test('one Pair invocation migrates a Work-bound legacy ledger while automatically challenging an unapproved plan', t => {
  const fixture = challengeFixture(t, 'automatic-plan-gate');
  const dataDir = path.join(fixture.root, 'pair-data');
  const blockedHome = path.join(fixture.root, 'blocked-home');
  const runtimeLog = path.join(fixture.scratchRoot, 'automatic-plan-gate.log');
  fs.writeFileSync(blockedHome, 'not a directory');
  fs.writeFileSync(
    path.join(fixture.root, '.pair', 'ledger-bindings.json'),
    JSON.stringify({
      schema: 1,
      bindings: {
        [`work:${fixture.workId}`]: {
          ledger: path.join(dataDir, 'attempts.jsonl'),
          bound_at: '2026-07-19T00:00:00.000Z',
        },
      },
    }),
  );
  writeExecutable(path.join(fixture.fakeBin, 'codex'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const output = args[args.indexOf('--output-last-message') + 1];
fs.appendFileSync(process.env.PAIR_TEST_RUNTIME_LOG, 'plan-review\\n');
fs.writeFileSync(output, JSON.stringify({ verdict: 'approve', summary: 'The exact digest is executable.', findings: [] }));
process.stdout.write('{"type":"turn.completed"}\\n');
`);

  const doctor = childProcess.spawnSync(
    process.execPath,
    [PAIR_TASK, '--doctor', '--runtime', 'codex'],
    {
      cwd: fixture.root,
      encoding: 'utf8',
      env: {
        ...process.env,
        CODEX_THREAD_ID: '',
        CODEX_SANDBOX: '',
        CLAUDECODE: '',
        HOME: blockedHome,
        PAIR_DATA_DIR: '',
        PATH: `${fixture.fakeBin}${path.delimiter}${process.env.PATH || ''}`,
      },
    },
  );
  assert.equal(doctor.status, 0, doctor.stdout + doctor.stderr);
  assert.match(doctor.stdout, /warn work linkage.*automatically challenged/i);
  assert.match(doctor.stdout, new RegExp(`ok {3}event store — \\.pair/runs/${fixture.workId}/events\\.jsonl`));
  assert.match(doctor.stdout, /warn legacy history.*repository-local state/i);

  const run = childProcess.spawnSync(
    process.execPath,
    [PAIR_TASK, '--runtime', 'codex', '--once', '--inline'],
    {
      cwd: fixture.root,
      encoding: 'utf8',
      env: {
        ...process.env,
        CODEX_THREAD_ID: '',
        CODEX_SANDBOX: '',
        CLAUDECODE: '',
        HOME: blockedHome,
        PAIR_DATA_DIR: '',
        PAIR_TEST_RUNTIME_LOG: runtimeLog,
        PATH: `${fixture.fakeBin}${path.delimiter}${process.env.PATH || ''}`,
      },
    },
  );

  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.equal(fs.readFileSync(runtimeLog, 'utf8'), 'plan-review\n');
  assert.match(run.stdout, /approved [a-f0-9]{64}.*codex\/default/i);
  assert.match(run.stdout, /INLINE TASK BRIEF/i);

  fs.rmSync(path.join(fixture.root, '.pair', 'active-attempt.json'), { force: true });
  const cached = childProcess.spawnSync(
    process.execPath,
    [PAIR_TASK, '--runtime', 'codex', '--once', '--inline'],
    {
      cwd: fixture.root,
      encoding: 'utf8',
      env: {
        ...process.env,
        CODEX_THREAD_ID: '',
        CODEX_SANDBOX: '',
        CLAUDECODE: '',
        HOME: blockedHome,
        PAIR_DATA_DIR: '',
        PAIR_TEST_RUNTIME_LOG: runtimeLog,
        PATH: `${fixture.fakeBin}${path.delimiter}${process.env.PATH || ''}`,
      },
    },
  );
  assert.equal(cached.status, 0, cached.stdout + cached.stderr);
  assert.equal(fs.readFileSync(runtimeLog, 'utf8'), 'plan-review\n', 'approval is cached and no reviewer restarts');
  assert.match(cached.stdout, /INLINE TASK BRIEF/i);
});

test('nested Codex cannot approve after mutating its disposable review snapshot', t => {
  const fixture = challengeFixture(t, 'mutating-codex-challenge');
  writeExecutable(path.join(fixture.fakeBin, 'codex'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const output = args[args.indexOf('--output-last-message') + 1];
fs.writeFileSync(path.join(process.cwd(), 'reviewer-mutation.txt'), 'changed');
fs.writeFileSync(output, JSON.stringify({ verdict: 'approve', summary: 'clean', findings: [] }));
process.stdout.write('{"type":"turn.completed"}\\n');
`);

  const result = childProcess.spawnSync(
    process.execPath,
    [path.resolve(__dirname, '../scripts/pair-plan-challenge'), '--runtime', 'codex'],
    {
      cwd: fixture.root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fixture.fakeBin}${path.delimiter}${process.env.PATH || ''}`,
        CLAUDE_SCRATCH_DIR: fixture.scratchRoot,
        PAIR_DATA_DIR: path.join(fixture.scratchRoot, 'pair-data'),
        CODEX_THREAD_ID: 'coordinator-thread',
        CODEX_SANDBOX: 'seatbelt',
        CLAUDECODE: '',
        PAIR_DEFAULT_RUNTIME: '',
      },
    },
  );

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /review snapshot mutated/i);
  const work = JSON.parse(fs.readFileSync(path.join(fixture.root, 'docs', 'work', fixture.workId, 'work.json'), 'utf8'));
  assert.notEqual(work.plan?.status, 'validated');
});

test('auto challenge preserves a failed attempt and retries the unchanged digest on the alternate runtime', t => {
  const root = repository(t);
  const workId = 'work-20260718-plan-challenge-fallback';
  const spec = [
    '# Plan challenge fallback specification',
    '',
    `- **Work ID:** \`${workId}\``,
    '',
    '## Engineering Quality Contract',
    '',
    'An independent digest-bound plan challenge is required before implementation.',
    '',
  ].join('\n');
  childProcess.spawnSync('git', ['init', '-q'], { cwd: root });
  createWorkRoot({ repositoryRoot: root, workId, canonicalSpec: spec });
  fs.writeFileSync(path.join(root, '.pair', 'plan.md'), validPairPlan());

  const fakeBin = path.join(root, 'fake-bin');
  const scratchRoot = path.join(root, 'scratch');
  const runtimeLog = path.join(root, 'runtime.log');
  fs.mkdirSync(fakeBin);
  writeExecutable(path.join(fakeBin, 'codex'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const output = args[args.indexOf('--output-last-message') + 1];
const review = ${JSON.stringify(environmentReview())};
fs.appendFileSync(process.env.PAIR_TEST_RUNTIME_LOG, 'codex\\n');
fs.writeFileSync(output, JSON.stringify(review));
process.stdout.write('{"type":"turn.completed"}\\n');
`);
  writeExecutable(path.join(fakeBin, 'claude'), `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(process.env.PAIR_TEST_RUNTIME_LOG, 'claude\\n');
process.stdout.write(JSON.stringify({ structured_output: { verdict: 'approve', summary: 'The exact digest is executable.', findings: [] } }));
`);

  const result = childProcess.spawnSync(
    process.execPath,
    [
      path.resolve(__dirname, '../scripts/pair-plan-challenge'),
      '--runtime', 'auto',
      '--allow-cross-runtime-fallback',
    ],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
        CLAUDE_SCRATCH_DIR: scratchRoot,
        PAIR_DATA_DIR: path.join(scratchRoot, 'pair-data'),
        PAIR_TEST_RUNTIME_LOG: runtimeLog,
        CODEX_THREAD_ID: 'coordinator-thread',
        CODEX_SANDBOX: '',
        CLAUDECODE: '',
        PAIR_DEFAULT_RUNTIME: '',
      },
    },
  );

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(fs.readFileSync(runtimeLog, 'utf8'), 'codex\nclaude\n');
  assert.match(result.stderr, /codex\/default environment failure/i);
  assert.match(result.stderr, /trying claude\/default/i);
  assert.match(result.stdout, /approved .* by claude\/default/);

  const evidence = JSON.parse(fs.readFileSync(path.join(root, '.pair', 'plan-review.json'), 'utf8'));
  assert.equal(evidence.reviewer, 'claude/default');
  assert.equal(evidence.verdict, 'approve');
  const work = JSON.parse(fs.readFileSync(path.join(root, 'docs', 'work', workId, 'work.json'), 'utf8'));
  assert.match(work.plan.independent_review, /^no-blockers:[a-f0-9]{64}:claude\/default$/);

  const digestDirectory = path.join(
    scratchRoot,
    path.basename(root),
    'pair-plan-challenge',
    work.plan.sha256,
  );
  const runs = fs.readdirSync(digestDirectory);
  assert.equal(runs.length, 1);
  const attemptFiles = fs.readdirSync(path.join(digestDirectory, runs[0])).sort();
  assert.ok(attemptFiles.includes('attempt-1-codex.review.json'));
  assert.ok(attemptFiles.includes('attempt-1-codex.stdout'));
  assert.ok(attemptFiles.includes('attempt-1-codex.stderr'));
  assert.ok(attemptFiles.includes('attempt-1-codex.metadata.json'));
  assert.ok(attemptFiles.includes('attempt-2-claude.review.json'));
  assert.ok(attemptFiles.includes('attempt-2-claude.metadata.json'));
});

test('clean challenge records the exact digest and reviewer in canonical Work', t => {
  const root = repository(t);
  const workId = 'work-20260718-plan-challenge';
  const spec = [
    '# Plan challenge specification',
    '',
    `- **Work ID:** \`${workId}\``,
    '',
    '## Engineering Quality Contract',
    '',
    'An independent digest-bound plan challenge is required before implementation.',
    '',
  ].join('\n');
  createWorkRoot({ repositoryRoot: root, workId, canonicalSpec: spec });
  const workDirectory = path.join(root, 'docs', 'work', workId);
  const workFile = path.join(workDirectory, 'work.json');
  const digest = crypto.createHash('sha256').update('plan contract').digest('hex');

  const recorded = recordPlanApproval(workFile, digest, 'codex/default');
  assert.deepEqual(recorded, {
    path: '.pair/plan.md',
    sha256: digest,
    status: 'validated',
    independent_review: `no-blockers:${digest}:codex/default`,
  });
  assert.deepEqual(validateWorkDirectory(workDirectory).plan, recorded);
  assert.throws(
    () => recordPlanApproval(workFile, digest, `codex/${'x'.repeat(100)}`),
    /reviewer identity is too long/,
  );
});

test('manual plan approval is exact-digest, reasoned, and recorded as a human override', t => {
  const fixture = challengeFixture(t, 'manual-plan-approval');
  const plan = fs.readFileSync(path.join(fixture.root, '.pair', 'plan.md'), 'utf8');
  const digest = planContractDigest(plan);
  const challenge = path.resolve(__dirname, '../scripts/pair-plan-challenge');

  const mismatch = childProcess.spawnSync(
    process.execPath,
    [challenge, '--approve-plan', '0'.repeat(64), '--reason', 'Reviewer runtime is unavailable.'],
    { cwd: fixture.root, encoding: 'utf8' },
  );
  assert.equal(mismatch.status, 1, mismatch.stdout + mismatch.stderr);
  assert.match(mismatch.stderr, /does not match current plan digest/i);

  const approved = childProcess.spawnSync(
    'bash',
    [path.resolve(__dirname, '../scripts/pair-loop'), '--approve-plan', digest, '--reason', 'I reviewed the plan and accept the residual risk.'],
    { cwd: fixture.root, encoding: 'utf8' },
  );
  assert.equal(approved.status, 0, approved.stdout + approved.stderr);
  assert.match(approved.stdout, /human override/i);

  const work = JSON.parse(fs.readFileSync(
    path.join(fixture.root, 'docs', 'work', fixture.workId, 'work.json'),
    'utf8',
  ));
  assert.match(work.plan.independent_review, new RegExp(`^human-override:${digest}:user:[a-f0-9]{12}$`));
  const evidence = JSON.parse(fs.readFileSync(path.join(fixture.root, '.pair', 'plan-review.json'), 'utf8'));
  assert.equal(evidence.approval_kind, 'human-override');
  assert.equal(evidence.plan_digest, digest);
  assert.equal(evidence.reason, 'I reviewed the plan and accept the residual risk.');
  const summary = fs.readFileSync(path.join(fixture.root, '.pair', 'plan-reviews', 'summary.md'), 'utf8');
  assert.match(summary, /human-override/);
  assert.match(summary, /I reviewed the plan and accept the residual risk/);
});

test('plan challenge records usage and stops after one closure verdict across plan digests', t => {
  const fixture = challengeFixture(t, 'finite-plan-review-budget');
  const dataDir = path.join(fixture.root, 'pair-data');
  const runtimeLog = path.join(fixture.root, 'runtime.log');
  writeExecutable(path.join(fixture.fakeBin, 'codex'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const output = args[args.indexOf('--output-last-message') + 1];
fs.appendFileSync(process.env.PAIR_TEST_RUNTIME_LOG, 'review\\n');
fs.writeFileSync(output, JSON.stringify({ verdict: 'approve', summary: 'bounded approval', findings: [] }));
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: '01900000-0000-7000-8000-000000000099' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: {
  input_tokens: 100, cached_input_tokens: 20, output_tokens: 30, reasoning_output_tokens: 10,
} }) + '\\n');
`);
  const challenge = path.resolve(__dirname, '../scripts/pair-plan-challenge');
  const run = () => childProcess.spawnSync(
    process.execPath,
    [challenge, '--runtime', 'codex'],
    {
      cwd: fixture.root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fixture.fakeBin}${path.delimiter}${process.env.PATH || ''}`,
        CLAUDE_SCRATCH_DIR: fixture.scratchRoot,
        PAIR_DATA_DIR: dataDir,
        PAIR_MAX_PLAN_REVIEWS: '2',
        PAIR_TEST_RUNTIME_LOG: runtimeLog,
        CODEX_THREAD_ID: '',
        CODEX_SANDBOX: '',
        CLAUDECODE: '',
      },
    },
  );

  const first = run();
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const planPath = path.join(fixture.root, '.pair', 'plan.md');
  fs.writeFileSync(planPath, fs.readFileSync(planPath, 'utf8').replace(
    'Add one observable greeting behavior',
    'Add one observable greeting behavior with bounded review',
  ));
  const closure = run();
  assert.equal(closure.status, 0, closure.stdout + closure.stderr);

  fs.writeFileSync(planPath, fs.readFileSync(planPath, 'utf8').replace(
    'without introducing a new framework layer.',
    'without introducing a new framework or review layer.',
  ));
  const blocked = run();
  assert.equal(blocked.status, 1, blocked.stdout + blocked.stderr);
  assert.match(blocked.stderr, /2-verdict plan-review budget|plan-review budget.*2/i);
  assert.equal(fs.readFileSync(runtimeLog, 'utf8'), 'review\nreview\n');

  const ledger = fs.readFileSync(
    path.join(fixture.root, '.pair', 'runs', fixture.workId, 'events.jsonl'),
    'utf8',
  )
    .trim().split('\n').map(line => JSON.parse(line));
  const reviews = ledger.filter(record => record.event === 'plan-review.completed');
  assert.equal(reviews.length, 2);
  assert.deepEqual(reviews[0].usage, {
    inputTokens: 100,
    cachedInputTokens: 20,
    outputTokens: 30,
    reasoningTokens: 10,
    costUsd: null,
  });
  assert.equal(reviews[0].reviewerSessionId, '01900000-0000-7000-8000-000000000099');
  assert.equal(reviews[1].reviewerSessionId, reviews[0].reviewerSessionId);
  const summary = fs.readFileSync(
    path.join(fixture.root, '.pair', 'plan-reviews', 'summary.md'),
    'utf8',
  );
  assert.match(summary, /Review 1: approved[\s\S]*Review 2: approved/);
  assert.match(summary, /Model \/ effort:\*\*[\s\S]*Tokens:\*\* input 100, cached 20, output 30, reasoning 10/);
  assert.match(summary, /Review Session:.*01900000-0000-7000-8000-000000000099/);
  assert.match(summary, /Final reason:\*\* bounded approval/);
});
