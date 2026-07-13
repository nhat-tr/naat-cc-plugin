const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  buildRuntimeCommand,
  classifyOutcome,
  createAttempt,
  planContractDigest,
  parsePlan,
  parseRuntimeUsage,
  nextOpenTask,
  selectRoute,
  validatePlan,
} = require('../scripts/lib/pair-core');
const { validPairPlan } = require('./support/pair-plan-fixture');

test('planContractDigest ignores only executable progress and Pair-v3 recovery context', () => {
  const plan = validPairPlan();
  const progressed = plan
    .replace('- [ ] Task 1.1', '- [x] Task 1.1')
    .replace('- [ ] AC-1:', '- [X] AC-1:')
    .replace(
      /^(- \[ \] Task 1\.2 .+)$/m,
      '$1\n  - Pair-v3 recovery context for 1.1: retry with repository evidence',
    );

  assert.equal(planContractDigest(progressed), planContractDigest(plan));
  assert.notEqual(
    planContractDigest(plan.replace('files: `tests/greeting.test.js`', 'files: `src/forged.js`')),
    planContractDigest(plan),
  );
  assert.equal(planContractDigest(plan), crypto.createHash('sha256').update(plan).digest('hex'));
  assert.notEqual(
    planContractDigest(plan.replace('the command prints', 'the command safely prints')),
    planContractDigest(plan),
  );
});

test('nextOpenTask returns the first unchecked task with its profile', () => {
  const plan = [
    '### Stream 1: API - complexity: M',
    '- [x] Task 1.1 - write tests - files: `tests/api.test.ts` - **S**',
    '- [ ] Task 1.2 - implement public API contract - files: `src/api.ts` - **M**',
  ].join('\n');

  const task = nextOpenTask(plan);
  assert.deepEqual({
    id: task.id,
    text: task.text,
    complexity: task.complexity,
    type: task.type,
    risk: task.risk,
    scope: task.scope,
    uncertainty: task.uncertainty,
    files: task.files,
    line: task.line,
  }, {
    id: '1.2',
    text: 'implement public API contract',
    complexity: 'M',
    type: 'feature',
    risk: 'high',
    scope: 'contract',
    uncertainty: 'medium',
    files: ['src/api.ts'],
    line: 3,
  });
});

test('nextOpenTask honors explicit task profile tags', () => {
  const task = nextOpenTask('- [ ] Task 2.1 - rename a public symbol [type:refactor] [risk:medium] [scope:contract] [uncertainty:low] - files: `src/name.ts` - **S**');
  assert.equal(task.type, 'refactor');
  assert.equal(task.risk, 'medium');
  assert.equal(task.scope, 'contract');
  assert.equal(task.uncertainty, 'low');
});

test('parsePlan keeps verification commands out of owned files and preserves contract metadata', () => {
  const parsed = parsePlan(validPairPlan());
  const task = parsed.tasks[0];

  assert.deepEqual(task.files, ['tests/greeting.test.js']);
  assert.equal(task.verify, 'node --test tests/greeting.test.js');
  assert.deepEqual(task.acceptanceCriteria, ['AC-1']);
  assert.equal(task.phase, 'red');
  assert.equal(parsed.streams[0].dependsOn.length, 0);
});

test('validatePlan accepts a grounded capability-first pair plan', () => {
  const result = validatePlan(validPairPlan());

  assert.equal(result.valid, true, result.errors.join('\n'));
  assert.equal(result.tasksTotal, 3);
  assert.equal(result.tasksOpen, 3);
});

test('validatePlan accepts structured repository capability evidence without a package version', () => {
  const plan = validPairPlan().replace(
    '- **Dependency:** `node@current` | evidence: `package.json` | decision: reuse | gap: none',
    '- **Repository capability:** `existing command dispatch` | evidence: `src/commands/help.js#registerHelp` | decision: reuse | gap: none',
  );
  const result = validatePlan(plan);

  assert.equal(result.valid, true, result.errors.join('\n'));
});

test('validatePlan rejects the weak plan previously accepted by substring checks', () => {
  const result = validatePlan([
    '## Implementation Context',
    'anything',
    '## Streams',
    '### Stream 1: API',
    '- [ ] implement production first; mention test and integration-test',
  ].join('\n'));

  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /Context|Intent Contract|stable task ID|Capability Evidence/);
});

test('validatePlan rejects duplicate IDs, invalid profiles, and missing owned files', () => {
  const invalid = validPairPlan()
    .replace('Task 1.2 - write failing integration test', 'Task 1.1 - write failing integration test')
    .replace('[risk:medium]', '[risk:banana]')
    .replace(' - files: `src/greeting.js`', '');
  const result = validatePlan(invalid);
  const errors = result.errors.join('\n');

  assert.equal(result.valid, false);
  assert.match(errors, /duplicate task ID 1\.1/);
  assert.match(errors, /invalid risk "banana"/);
  assert.match(errors, /Task 1\.3.*owned file/);
});

test('validatePlan rejects forward stream dependencies and high-uncertainty implementation', () => {
  const invalid = validPairPlan()
    .replace('**Depends on:** none', '**Depends on:** Stream 2')
    .replace('[uncertainty:low] [ac:AC-1] - files: `src/greeting.js`', '[uncertainty:high] [ac:AC-1] - files: `src/greeting.js`')
    .replace('## Acceptance Criteria', [
      '### Stream 2: Later work - complexity: S',
      '**Depends on:** none',
      '- [ ] Task 2.1 - write failing tests for later work [type:test] [phase:red] [risk:low] [scope:local] [uncertainty:low] [ac:AC-1] - files: `tests/later.test.js` - verify: `node --test tests/later.test.js` - **S**',
      '',
      '## Acceptance Criteria',
    ].join('\n'));
  const result = validatePlan(invalid);
  const errors = result.errors.join('\n');

  assert.equal(result.valid, false);
  assert.match(errors, /depends on Stream 2.*later/);
  assert.match(errors, /Task 1\.3.*high uncertainty/);
});

test('validatePlan rejects unresolved blocking questions and custom capability work without a gap', () => {
  const invalid = validPairPlan()
    .replace('decision: reuse', 'decision: build')
    .replace('## Open Questions\n- None.', '## Open Questions\n- [blocking] Which dependency should own persistence? - impact: Task 1.3');
  const result = validatePlan(invalid);
  const errors = result.errors.join('\n');

  assert.equal(result.valid, false);
  assert.match(errors, /build decision.*confirmed gap/);
  assert.match(errors, /blocking open question/);
});

test('validatePlan requires the semantic intent, implementation, and simplicity fields', () => {
  const invalid = validPairPlan()
    .replace('**Purpose:**', '**Goal:**')
    .replace('**Language / Framework:**', '**Runtime:**')
    .replace('**Native baseline:**', '**Initial design:**');
  const result = validatePlan(invalid);
  const errors = result.errors.join('\n');

  assert.equal(result.valid, false);
  assert.match(errors, /Intent Contract.*Purpose/);
  assert.match(errors, /Implementation Context.*Language \/ Framework/);
  assert.match(errors, /Simplicity Contract.*Native baseline/);
});

test('validatePlan rejects empty contract values and vague unpinned capability evidence', () => {
  const invalid = validPairPlan()
    .replace('**Purpose:** Let a user request and receive a greeting.', '**Purpose:**')
    .replace('`node@current` | evidence: `package.json`', '`node` | evidence: model memory');
  const result = validatePlan(invalid);
  const errors = result.errors.join('\n');

  assert.equal(result.valid, false);
  assert.match(errors, /Purpose.*concrete value/);
  assert.match(errors, /node.*pinned version/);
  assert.match(errors, /model memory.*not capability evidence/);
});

test('validatePlan rejects duplicate acceptance IDs and test tasks without a red phase', () => {
  const invalid = validPairPlan()
    .replace('[type:test] [phase:red] [risk:medium]', '[type:test] [risk:medium]')
    .replace('- [ ] AC-1: the command prints the requested greeting.', [
      '- [ ] AC-1: the command prints the requested greeting.',
      '- [ ] AC-1: duplicate criterion.',
    ].join('\n'));
  const result = validatePlan(invalid);
  const errors = result.errors.join('\n');

  assert.equal(result.valid, false);
  assert.match(errors, /duplicate acceptance criterion ID AC-1/);
  assert.match(errors, /Task 1\.2.*test task.*phase:red/);
});

test('validatePlan finds blocking questions even when they are not list items', () => {
  const invalid = validPairPlan()
    .replace('## Open Questions\n- None.', '## Open Questions\n[blocking] Is the SDK API real?');
  const result = validatePlan(invalid);

  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /blocking open question/);
});

test('validatePlan rejects executable checkboxes outside Streams and Acceptance Criteria', () => {
  const invalid = `${validPairPlan()}\n\n## Review Fixes\n- [ ] BLOCKER: redesign the plan`;
  const result = validatePlan(invalid);

  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /executable checkbox outside ## Streams/);
});

test('nextOpenTask supports loop-plan tasks without explicit IDs', () => {
  const plan = [
    '# Goal: docs',
    '## Acceptance Criteria',
    '- [ ] docs render',
    '## Tasks',
    '- [ ] write failing tests - files: `tests/docs.test`',
  ].join('\n');
  const task = nextOpenTask(plan);
  assert.equal(task.id, 'loop.1');
  assert.equal(task.type, 'test');
  assert.equal(task.line, 5);
});

test('nextOpenTask verifies acceptance criteria after implementation tasks', () => {
  const plan = [
    '## Tasks',
    '- [x] implement docs',
    '## Acceptance Criteria',
    '- [ ] docs render',
  ].join('\n');
  const task = nextOpenTask(plan);
  assert.equal(task.id, 'AC1');
  assert.match(task.text, /verify acceptance criterion/);
  assert.equal(task.line, 4);
});

test('nextOpenTask preserves an explicit acceptance-criterion ID', () => {
  const plan = [
    '## Tasks',
    '- [x] implement docs',
    '## Acceptance Criteria',
    '- [ ] AC-7: docs render',
  ].join('\n');

  assert.equal(nextOpenTask(plan).id, 'AC-7');
});

test('nextOpenTask does not run named acceptance criteria before plan tasks', () => {
  const plan = [
    '## Acceptance Criteria',
    '- [ ] AC1: docs render',
    '## Streams',
    '- [ ] Task 1.1 - implement docs - files: `README.md` - **S**',
  ].join('\n');
  assert.equal(nextOpenTask(plan).id, '1.1');
});

test('selectRoute uses the cheapest qualified route for low-risk work', () => {
  const profile = { type: 'docs', complexity: 'S', risk: 'low', scope: 'local' };
  const routes = [
    { id: 'cheap', expectedCost: 0.1 },
    { id: 'strong', expectedCost: 1.0 },
  ];
  const history = Array.from({ length: 20 }, () => ({
    routeId: 'cheap',
    profile,
    valid: true,
    success: true,
    totalCost: 0.1,
  }));

  assert.equal(selectRoute(profile, routes, history).id, 'cheap');
});

test('selectRoute never explores on critical work', () => {
  const profile = { type: 'migration', complexity: 'L', risk: 'critical', scope: 'contract' };
  const routes = [
    { id: 'cheap', expectedCost: 0.1, strength: 1 },
    { id: 'strong', expectedCost: 1.0, strength: 4 },
  ];

  assert.equal(selectRoute(profile, routes, []).id, 'strong');
});

test('selectRoute sends high-uncertainty work to the strongest route', () => {
  const profile = { type: 'feature', complexity: 'S', risk: 'low', scope: 'local', uncertainty: 'high' };
  const routes = [
    { id: 'cheap', expectedCost: 0.1, strength: 1 },
    { id: 'strong', expectedCost: 1.0, strength: 4 },
  ];

  assert.equal(selectRoute(profile, routes, []).id, 'strong');
});

test('classifyOutcome accepts clean verified code', () => {
  assert.deepEqual(classifyOutcome({
    workerStatus: 'completed',
    verification: 'pass',
    findings: [],
    priorAttempts: 0,
  }), {
    disposition: 'accepted',
    action: 'complete-task',
    cause: null,
  });
});

test('classifyOutcome escalates repeated blocker findings', () => {
  assert.deepEqual(classifyOutcome({
    workerStatus: 'completed',
    verification: 'pass',
    findings: [{ severity: 'BLOCKER' }],
    priorAttempts: 1,
  }), {
    disposition: 'substantial-rewrite',
    action: 'escalate',
    cause: 'model-capability',
  });
});

test('classifyOutcome allows one local fix for an initial major finding', () => {
  assert.equal(classifyOutcome({
    workerStatus: 'completed',
    verification: 'pass',
    findings: [{ severity: 'MAJOR' }],
    priorAttempts: 0,
  }).action, 'local-fix');
});

test('classifyOutcome does not treat invalid retries as prior model failures', () => {
  assert.equal(classifyOutcome({
    workerStatus: 'completed',
    verification: 'pass',
    findings: [{ severity: 'MAJOR' }],
    priorAttempts: 1,
    priorModelAttempts: 0,
  }).action, 'local-fix');
});

test('classifyOutcome never accepts an invalid reviewer run', () => {
  assert.deepEqual(classifyOutcome({
    workerStatus: 'completed',
    verification: 'pass',
    findings: [],
    reviewStatus: 1,
  }), {
    disposition: 'regenerated',
    action: 'retry-infrastructure',
    cause: 'reviewer-error',
  });
});

test('classifyOutcome retries a transient worker runtime failure', () => {
  assert.deepEqual(classifyOutcome({
    workerStatus: 'blocked',
    verification: 'fail',
    runtimeStatus: 1,
  }), {
    disposition: 'regenerated',
    action: 'retry-infrastructure',
    cause: 'environment-failure',
  });
});

test('classifyOutcome retries initial task ambiguity with stronger context', () => {
  assert.deepEqual(classifyOutcome({
    workerStatus: 'blocked',
    verification: 'fail',
    priorAttempts: 0,
  }), {
    disposition: 'regenerated',
    action: 'retry-context',
    cause: 'task-ambiguity',
  });
});

test('classifyOutcome sends incorrect plans back for redesign', () => {
  assert.deepEqual(classifyOutcome({
    workerStatus: 'completed',
    verification: 'pass',
    findings: [{ severity: 'BLOCKER' }],
    recommendedAction: 'redesign',
  }), {
    disposition: 'redesign',
    action: 'redesign',
    cause: 'incorrect-plan',
  });
});

test('classifyOutcome treats a worker-proven missing API as an incorrect plan', () => {
  assert.deepEqual(classifyOutcome({
    workerStatus: 'blocked',
    workerBlocker: 'incorrect-plan: Pinned package does not expose the planned API',
    verification: 'fail',
    priorAttempts: 0,
  }), {
    disposition: 'redesign',
    action: 'redesign',
    cause: 'incorrect-plan',
  });
});

test('classifyOutcome escalates a repeated ambiguous worker result to a human', () => {
  assert.deepEqual(classifyOutcome({
    workerStatus: 'blocked',
    verification: 'fail',
    priorAttempts: 1,
  }), {
    disposition: 'human-takeover',
    action: 'stop',
    cause: 'task-ambiguity',
  });
});

test('buildRuntimeCommand creates a writable ephemeral Codex execution', () => {
  const command = buildRuntimeCommand({
    runtime: 'codex',
    root: '/repo',
    prompt: 'do task',
    model: 'default',
    effort: 'low',
    schemaPath: '/schema.json',
    outputPath: '/result.json',
  });

  assert.equal(command.file, 'codex');
  assert.deepEqual(command.args.slice(0, 6), [
    'exec', '--json', '--ephemeral', '--sandbox', 'workspace-write', '-C',
  ]);
  assert.ok(command.args.includes('--output-schema'));
  assert.ok(!command.args.includes('--model'));
});

test('buildRuntimeCommand creates structured Claude execution', () => {
  const command = buildRuntimeCommand({
    runtime: 'claude',
    root: '/repo',
    prompt: 'do task',
    model: 'haiku',
    effort: 'low',
    schema: { type: 'object' },
  });

  assert.equal(command.file, 'claude');
  assert.ok(command.args.includes('--output-format'));
  assert.ok(command.args.includes('--json-schema'));
  assert.ok(command.args.includes('haiku'));
});

test('parseRuntimeUsage reads Codex turn usage', () => {
  const raw = [
    JSON.stringify({ type: 'thread.started', thread_id: 'abc' }),
    JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20, reasoning_output_tokens: 5 },
    }),
  ].join('\n');

  assert.deepEqual(parseRuntimeUsage('codex', raw), {
    inputTokens: 100,
    cachedInputTokens: 40,
    outputTokens: 20,
    reasoningTokens: 5,
    costUsd: null,
  });
});

test('createAttempt records a versioned task and route envelope', () => {
  const attempt = createAttempt({
    task: { id: '1.2', type: 'feature', complexity: 'M', risk: 'medium', scope: 'local' },
    route: { id: 'codex-default-medium', runtime: 'codex', model: 'default', effort: 'medium' },
    policyVersion: '3.0.0',
    baseline: 'abc123',
    now: '2026-07-11T10:00:00.000Z',
  });

  assert.equal(attempt.taskId, '1.2');
  assert.equal(attempt.routeId, 'codex-default-medium');
  assert.equal(attempt.status, 'running');
  assert.equal(attempt.policyVersion, '3.0.0');
});
