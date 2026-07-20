const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  attemptCapStatus,
  buildRuntimeCommand,
  classifyOutcome,
  createAttempt,
  normalizeReview,
  planContractDigest,
  parsePlan,
  parseRuntimeUsage,
  nextOpenTask,
  reviewIsWellFormed,
  selectRoute,
  validatePlan,
} = require('../scripts/lib/pair-core');
const { validPairLitePlan, validPairPlan } = require('./support/pair-plan-fixture');

test('planContractDigest ignores queued, active, and accepted progress plus Pair recovery context', () => {
  const plan = validPairPlan();
  const progressed = plan
    .replace('- [ ] Task 1.1', '- [-] Task 1.1')
    .replace('- [ ] Task 1.2', '- [x] Task 1.2')
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

  assert.deepEqual(task.files, [
    'tests/greeting.test.js',
    'tests/greeting.integration.test.js',
    'src/greeting.js',
  ]);
  assert.deepEqual(task.testFiles, ['tests/greeting.test.js', 'tests/greeting.integration.test.js']);
  assert.equal(task.tddMode, 'cycle');
  assert.equal(task.redMode, 'assertion');
  assert.match(task.redExpected, /greeting command/);
  assert.deepEqual(task.consumes, [{ source: 'repository', contract: 'src/commands/help.js#registerHelp' }]);
  assert.deepEqual(task.produces, ['src/greeting.js#greet(name): string']);
  assert.equal(task.verify, 'node --test tests/greeting.test.js tests/greeting.integration.test.js');
  assert.deepEqual(task.acceptanceCriteria, ['AC-1']);
  assert.equal(task.phase, null);
  assert.equal(parsed.streams[0].dependsOn.length, 0);
});

test('validatePlan accepts readable multi-line task metadata without changing the task contract', () => {
  const plan = [
    '# Task: Add greeting command',
    '',
    '**Pair mode:** lite',
    '',
    '## Intent Contract',
    '- **Spec:** `.pair/spec.md`',
    '- **Purpose:** Let a user request and receive a greeting.',
    '- **Repository evidence:** `src/commands/help.js#registerHelp` and `package.json`.',
    '- **Constraints:** Preserve the current command API; no new command framework.',
    '- **Verification:** `node --test tests/greeting.integration.test.js`',
    '',
    '## Streams',
    '### Stream 1: Greeting behavior',
    '- [ ] Task 1.1 — deliver the requested greeting through the real command boundary',
    '  - **Profile:** [risk:medium] [ac:AC-1] [test:integration] · **M**',
    '  - **Files:** `tests/greeting.integration.test.js`, `src/greeting.js`, `src/commands/greeting.js`',
    '  - **Tests:** `tests/greeting.integration.test.js`',
    '  - **Verify:** `node --test tests/greeting.integration.test.js`',
    '',
    '## Acceptance Criteria',
    '- [ ] AC-1: the command prints the requested greeting.',
    '',
    '## Open Questions',
    '- None.',
  ].join('\n');

  const result = validatePlan(plan);

  assert.equal(result.valid, true, result.errors.join('\n'));
  assert.equal(result.parsed.tasks[0].text, 'deliver the requested greeting through the real command boundary');
  assert.deepEqual(result.parsed.tasks[0].files, [
    'tests/greeting.integration.test.js',
    'src/greeting.js',
    'src/commands/greeting.js',
  ]);
  assert.equal(result.parsed.tasks[0].verify, 'node --test tests/greeting.integration.test.js');
});

test('validatePlan keeps full Pair contracts readable as indented task rows', () => {
  const plan = validPairPlan().replace(
    '- [ ] Task 1.1 - deliver the requested greeting through the real command boundary [type:feature] [tdd:cycle] [red:assertion] [risk:medium] [scope:cross-module] [uncertainty:low] [ac:AC-1] - files: `tests/greeting.test.js`, `tests/greeting.integration.test.js`, `src/greeting.js` - tests: `tests/greeting.test.js`, `tests/greeting.integration.test.js` - red: `node --test tests/greeting.test.js tests/greeting.integration.test.js` - red-expect: `greeting command prints requested greeting` - verify: `node --test tests/greeting.test.js tests/greeting.integration.test.js` - **M**',
    [
      '- [ ] Task 1.1 — deliver the requested greeting through the real command boundary',
      '  - **Profile:** [type:feature] [tdd:cycle] [red:assertion] [risk:medium] [scope:cross-module] [uncertainty:low] [ac:AC-1] · **M**',
      '  - **Files:** `tests/greeting.test.js`, `tests/greeting.integration.test.js`, `src/greeting.js`',
      '  - **Tests:** `tests/greeting.test.js`, `tests/greeting.integration.test.js`',
      '  - **Red:** `node --test tests/greeting.test.js tests/greeting.integration.test.js`',
      '  - **Red expect:** `greeting command prints requested greeting`',
      '  - **Verify:** `node --test tests/greeting.test.js tests/greeting.integration.test.js`',
    ].join('\n'),
  );

  const result = validatePlan(plan);

  assert.equal(result.valid, true, result.errors.join('\n'));
  assert.equal(result.parsed.tasks[0].tddMode, 'cycle');
  assert.equal(result.parsed.tasks[0].redMode, 'assertion');
  assert.deepEqual(result.parsed.tasks[0].testBoundaries, ['unit', 'integration']);
});

test('validatePlan accepts a grounded capability-first pair plan', () => {
  const result = validatePlan(validPairPlan());

  assert.equal(result.valid, true, result.errors.join('\n'));
  assert.equal(result.tasksTotal, 2);
  assert.equal(result.tasksOpen, 2);
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
    .replace('Task 1.2 - register', 'Task 1.1 - register')
    .replace('[risk:medium]', '[risk:banana]')
    .replace(' - files: `src/commands/greeting.js`', '');
  const result = validatePlan(invalid);
  const errors = result.errors.join('\n');

  assert.equal(result.valid, false);
  assert.match(errors, /duplicate task ID 1\.1/);
  assert.match(errors, /invalid risk "banana"/);
  assert.match(errors, /Task 1\.1.*owned file/);
});

test('validatePlan rejects forward stream dependencies and high-uncertainty implementation', () => {
  const invalid = validPairPlan()
    .replace('**Depends on:** none', '**Depends on:** Stream 2')
    .replace('[uncertainty:low]', '[uncertainty:high]')
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
  assert.match(errors, /Task 1\.1.*high uncertainty/);
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

test('validatePlan rejects duplicate acceptance IDs and malformed TDD modes', () => {
  const invalid = validPairPlan()
    .replace('[tdd:cycle]', '[tdd:whenever]')
    .replace('- [ ] AC-1: the command prints the requested greeting.', [
      '- [ ] AC-1: the command prints the requested greeting.',
      '- [ ] AC-1: duplicate criterion.',
    ].join('\n'));
  const result = validatePlan(invalid);
  const errors = result.errors.join('\n');

  assert.equal(result.valid, false);
  assert.match(errors, /duplicate acceptance criterion ID AC-1/);
  assert.match(errors, /Task 1\.1.*malformed tdd tag/);
});

test('validatePlan finds blocking questions even when they are not list items', () => {
  const invalid = validPairPlan()
    .replace('## Open Questions\n- None.', '## Open Questions\n[blocking] Is the SDK API real?');
  const result = validatePlan(invalid);

  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /blocking open question/);
});

test('validatePlan accepts the compact Pair-lite contract without legacy ceremony', () => {
  const plan = validPairLitePlan();
  const result = validatePlan(plan);

  assert.deepEqual(result.errors, []);
  assert.ok(Buffer.byteLength(plan) < 2000, 'the executable plan stays compact');
  assert.equal(result.parsed.tasks[0].testBoundaries[0], 'integration');
});

test('compact Pair-lite plans still require test ownership and an integration boundary', () => {
  const withoutTests = validatePlan(validPairLitePlan()
    .replace(' - tests: `tests/greeting.integration.test.js`', ''));
  assert.match(withoutTests.errors.join('\n'), /must identify its test-owned files/i);

  const unitOnly = validatePlan(validPairLitePlan().replace('[test:integration]', '[test:unit]'));
  assert.match(unitOnly.errors.join('\n'), /integration or e2e/i);

  const unboundFullGate = validatePlan(validPairLitePlan().replace(
    '`node --test tests/greeting.integration.test.js`',
    'node --test tests/greeting.integration.test.js',
  ));
  assert.match(unboundFullGate.errors.join('\n'), /Verification.*backticked command/i);
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

test('nextOpenTask never turns acceptance criteria into model work for a canonical Stream plan', () => {
  const plan = [
    '## Streams',
    '### Stream 1: docs - complexity: S',
    '**Depends on:** none',
    '- [x] Task 1.1 - implement docs [type:docs] [risk:low] [scope:local] [uncertainty:low] [ac:AC-1] - files: `README.md` - verify: `node -e "process.exit(0)"` - **S**',
    '## Acceptance Criteria',
    '- [ ] AC-1: docs render',
  ].join('\n');

  assert.equal(nextOpenTask(plan), null);
});

test('validatePlan allows a structural stream whose tasks are covered by a red test elsewhere', () => {
  const plan = validPairPlan();

  const result = validatePlan(plan);
  assert.deepEqual(result.errors, [], 'a fully covered structural stream needs no stream-local red test');

  const unknownReference = validatePlan(plan.replace('[tdd:covered-by 1.1]', '[tdd:covered-by 9.9]'));
  assert.ok(unknownReference.errors.some(error => /unknown task 9\.9/.test(error)));

  const nonCycleReference = validatePlan(plan.replace('[tdd:covered-by 1.1]', '[tdd:covered-by 1.2]'));
  assert.ok(nonCycleReference.errors.some(error => /prior \[tdd:cycle\].*Review Slice/.test(error)));

  const malformed = validatePlan(plan.replace('[tdd:covered-by 1.1]', '[tdd:whenever]'));
  assert.ok(malformed.errors.some(error => /malformed tdd tag/.test(error)));
});

test('validatePlan rejects legacy test-only tasks and oversized Review Slices before execution', () => {
  const legacy = validPairPlan()
    .replace('[type:feature] [tdd:cycle] [red:assertion]', '[type:test] [phase:red]')
    .replace(' - tests: `tests/greeting.test.js`, `tests/greeting.integration.test.js`', '');
  const legacyErrors = validatePlan(legacy).errors.join('\n');
  assert.match(legacyErrors, /standalone test contract.*tdd:red-contract/i);

  const oversized = validPairPlan().replace(
    '`src/greeting.js` - tests:',
    '`src/greeting.js`, `src/a.js`, `src/b.js`, `src/c.js`, `src/d.js` - tests:',
  );
  assert.match(validatePlan(oversized).errors.join('\n'), /owns 7 files.*at most 6/i);
});

test('validatePlan rejects cross-repository ownership, understated risk, and forward interfaces', () => {
  const crossRepository = validPairPlan().replaceAll('src/greeting.js', '../Other/src/greeting.js');
  assert.match(validatePlan(crossRepository).errors.join('\n'), /outside the repository.*separate Work plan/i);

  const understated = validPairPlan().replace('[risk:medium]', '[risk:low]');
  assert.match(validatePlan(understated).errors.join('\n'), /risk low understates.*minimum risk is medium/i);

  const forward = validPairPlan().replace(
    'repository:`src/commands/help.js#registerHelp`',
    '1.2:`src/commands/greeting.js#registerGreeting(registry): void`',
  );
  assert.match(validatePlan(forward).errors.join('\n'), /Task 1\.2, which is not earlier in plan order/i);
});

test('selectRoute routes docs-type low-risk work to the cheapest tier', () => {
  const profile = { type: 'docs', complexity: 'S', risk: 'low', scope: 'local' };
  const routes = [
    { id: 'cheap', expectedCost: 0.1 },
    { id: 'strong', expectedCost: 1.0 },
  ];

  assert.equal(selectRoute(profile, routes).id, 'cheap');
});

test('selectRoute floors code-writing work at the second tier', () => {
  // Ledger evidence: the cheapest tier cannot reliably emit structured worker
  // results, so only docs tasks may route to it.
  const profile = { type: 'feature', complexity: 'S', risk: 'low', scope: 'local', uncertainty: 'low' };
  const routes = [
    { id: 'cheap', strength: 1 },
    { id: 'mid', strength: 2 },
    { id: 'strong', strength: 4 },
  ];

  assert.equal(selectRoute(profile, routes).id, 'mid');
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

test('selectRoute raises contract and broad Review Slices without trusting a low-risk label', () => {
  const routes = [
    { id: 'cheap', strength: 1 },
    { id: 'mid', strength: 2 },
    { id: 'high', strength: 3 },
    { id: 'max', strength: 4 },
  ];
  assert.equal(selectRoute({
    type: 'feature', complexity: 'M', risk: 'low', scope: 'contract',
    uncertainty: 'low', files: ['a', 'b'], acceptanceCriteria: ['AC-1'],
  }, routes).id, 'high');
});

test('classifyOutcome accepts clean verified code', () => {
  assert.deepEqual(classifyOutcome({
    workerStatus: 'completed',
    verification: 'pass',
    findings: [],
  }), {
    disposition: 'accepted',
    action: 'complete-task',
    cause: null,
  });
});

test('classifyOutcome stops repeated blocker findings instead of escalating to max', () => {
  assert.deepEqual(classifyOutcome({
    workerStatus: 'completed',
    verification: 'pass',
    findings: [{ severity: 'BLOCKER' }],
    priorRetryCounts: { 'retry-review': 1 },
  }), {
    disposition: 'human-takeover',
    action: 'stop',
    cause: 'model-capability',
  });
});

test('classifyOutcome retries one reviewed rejection on the same route', () => {
  assert.equal(classifyOutcome({
    workerStatus: 'completed',
    verification: 'pass',
    findings: [{ severity: 'MAJOR' }],
    priorRetryCounts: {},
  }).action, 'retry-review');
});

test('classifyOutcome does not exhaust one retry class with a different prior failure', () => {
  assert.equal(classifyOutcome({
    workerStatus: 'completed',
    verification: 'pass',
    findings: [{ severity: 'MAJOR' }],
    priorRetryCounts: { 'retry-infrastructure': 1 },
  }).action, 'retry-review');

  assert.equal(classifyOutcome({
    workerStatus: 'completed',
    verification: 'fail',
    priorRetryCounts: { 'retry-review': 1 },
  }).action, 'retry-verification');
});

test('classifyOutcome gives ownership one bounded retry before returning to promotion', () => {
  const ownership = { status: 'fail', outside: ['src/Node.cs'] };
  assert.deepEqual(classifyOutcome({
    workerStatus: 'completed',
    verification: 'fail',
    ownership,
    priorRetryCounts: {},
  }), {
    disposition: 'regenerated',
    action: 'retry-ownership',
    cause: 'integration-conflict',
  });
  assert.deepEqual(classifyOutcome({
    workerStatus: 'completed',
    verification: 'fail',
    ownership,
    priorRetryCounts: { 'retry-ownership': 1 },
  }), {
    disposition: 'redesign',
    action: 'return-to-promotion',
    cause: 'incorrect-plan',
  });
});

test('classifyOutcome returns reviewer-identified plan defects to promotion immediately', () => {
  assert.deepEqual(classifyOutcome({
    workerStatus: 'completed',
    verification: 'pass',
    findings: [{ severity: 'BLOCKER', origin: 'plan' }],
    recommendedAction: 'rewrite',
  }), {
    disposition: 'redesign',
    action: 'return-to-promotion',
    cause: 'incorrect-plan',
  });
});

test('classifyOutcome treats reviewer environment findings as infrastructure, not implementation defects', () => {
  const finding = {
    severity: 'BLOCKER',
    origin: 'environment',
    failure_scenario: 'The reviewer could not read the immutable patch.',
  };
  assert.deepEqual(
    classifyOutcome({
      workerStatus: 'completed',
      verification: 'pass',
      findings: [finding],
      recommendedAction: 'redesign',
      priorRetryCounts: {},
    }),
    { disposition: 'regenerated', action: 'retry-infrastructure', cause: 'environment-failure' },
  );
  assert.deepEqual(
    classifyOutcome({
      workerStatus: 'completed',
      verification: 'pass',
      findings: [finding],
      recommendedAction: 'redesign',
      priorRetryCounts: { 'retry-infrastructure': 1 },
    }),
    { disposition: 'human-takeover', action: 'stop', cause: 'environment-failure' },
  );
});

test('classifyOutcome retries a verification defect on the same route and then stops', () => {
  assert.equal(classifyOutcome({
    workerStatus: 'completed',
    verification: 'fail',
    priorRetryCounts: {},
  }).action, 'retry-verification');
  assert.deepEqual(classifyOutcome({
    workerStatus: 'completed',
    verification: 'fail',
    priorRetryCounts: { 'retry-verification': 1 },
  }), {
    disposition: 'human-takeover',
    action: 'stop',
    cause: 'verification-defect',
  });
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

test('attemptCapStatus counts substantive attempts and ignores interruptions for the cap', () => {
  const history = [
    { status: 'interrupted', valid: false },
    { status: 'completed', valid: true },
    { status: 'interrupted', valid: false },
    { status: 'completed', valid: true },
  ];
  const status = attemptCapStatus(history, 3);
  assert.equal(status.substantive, 2, 'only the two completed attempts count toward the cap');
  assert.equal(status.overCap, false, '2 substantive attempts is under a cap of 3');
  assert.equal(status.trailingInterrupts, 0, 'the most recent record is not an interruption');
  assert.deepEqual(status.retryCounts, {}, 'ordinary completed attempts do not invent retry state');
});

test('attemptCapStatus keeps retry budgets by action and ignores non-executions', () => {
  const status = attemptCapStatus([
    { status: 'completed', action: 'retry-infrastructure' },
    { status: 'interrupted', action: 'retry-infrastructure' },
    { status: 'completed-out-of-band', action: 'complete-task' },
    { status: 'completed', action: 'retry-review' },
  ], 4);

  assert.equal(status.substantive, 2);
  assert.deepEqual(status.retryCounts, {
    'retry-infrastructure': 1,
    'retry-review': 1,
  });
});

test('attemptCapStatus reports consecutive interruptions without turning them into a stop condition', () => {
  const history = [
    { status: 'completed', valid: true },
    { status: 'interrupted', valid: false },
    { status: 'interrupted', valid: false },
    { status: 'interrupted', valid: false },
  ];
  const status = attemptCapStatus(history, 3);
  assert.equal(status.substantive, 1);
  assert.equal(status.overCap, false, 'a lone real attempt must not be blocked by later interrupts');
  assert.equal(status.trailingInterrupts, 3);
  assert.equal(status.unstable, false, 'interruptions preserve the actionable phase and never hard-stop by count');
  assert.equal(status.warning, 'repeated-interruptions');
});

test('reviewIsWellFormed requires a schema verdict and a findings array', () => {
  const approved = { verdict: 'approve', recommended_action: 'approve', summary: 'clean', findings: [] };
  const finding = {
    severity: 'MAJOR', origin: 'implementation', file: 'src/x.js', line: 1,
    title: 'reachable defect', detail: 'wrong result', failure_scenario: 'real caller sees wrong result', suggestion: 'correct result',
  };
  assert.equal(reviewIsWellFormed(approved), true);
  assert.equal(reviewIsWellFormed({ verdict: 'fix-needed', recommended_action: 'local-fix', summary: 'fix', findings: [finding] }), true);
  assert.equal(reviewIsWellFormed({ ...approved, findings: [{ severity: 'MAJOR' }] }), false, 'partial finding is not schema-shaped');
  assert.equal(reviewIsWellFormed({ verdict: 'approve' }), false, 'missing findings array');
  assert.equal(reviewIsWellFormed({ findings: [] }), false, 'missing verdict');
  assert.equal(reviewIsWellFormed(null), false);
});

test('normalizeReview yields a crash-safe schema shape from a truncated review', () => {
  // A reviewer that hit a session limit emits a partial object with no findings key.
  const truncated = normalizeReview({ verdict: 'approve', summary: 'looks fine' });
  assert.deepEqual(truncated.findings, [], 'findings must always be an array');
  assert.equal(truncated.verdict, 'approve');
  assert.equal(truncated.recommended_action, 'approve', 'an approve verdict must not become a rewrite');

  const empty = normalizeReview(undefined);
  assert.equal(empty.verdict, 'fix-needed');
  assert.equal(empty.recommended_action, 'rewrite');
  assert.ok(Array.isArray(empty.findings));

  const dirty = normalizeReview({ verdict: 'fix-needed', findings: [{ severity: 'MAJOR' }, null, 'nope'] });
  assert.equal(dirty.findings.length, 1, 'non-object findings are dropped');
});

test('normalizeReview drops non-material findings so noise never reaches the loop', () => {
  const review = normalizeReview({
    verdict: 'fix-needed',
    findings: [
      { severity: 'BLOCKER', title: 'real' },
      { severity: 'MINOR', title: 'style nit' },
      { severity: 'INFO', title: 'observation' },
      { title: 'no severity at all' },
    ],
  });
  assert.equal(review.findings.length, 1, 'only the BLOCKER survives');
  assert.equal(review.findings[0].title, 'real');
});

test('classifyOutcome ignores a rewrite recommendation backed by no material findings', () => {
  // "Sensible-sounding" reviews with no itemized reachable failure must not burn a cycle.
  assert.deepEqual(classifyOutcome({
    workerStatus: 'completed',
    verification: 'pass',
    findings: [],
    recommendedAction: 'rewrite',
  }), {
    disposition: 'accepted',
    action: 'complete-task',
    cause: null,
  });
});

test('classifyOutcome ignores a local-fix recommendation with no findings', () => {
  assert.deepEqual(classifyOutcome({
    workerStatus: 'completed',
    verification: 'pass',
    findings: [],
    recommendedAction: 'local-fix',
  }), {
    disposition: 'accepted',
    action: 'complete-task',
    cause: null,
  });
});

test('classifyOutcome preserves verified work for one material local correction', () => {
  assert.deepEqual(classifyOutcome({
    workerStatus: 'completed',
    verification: 'pass',
    findings: [{ severity: 'MAJOR', origin: 'implementation' }],
    recommendedAction: 'local-fix',
  }), {
    disposition: 'local-fix',
    action: 'local-fix',
    cause: 'model-capability',
  });
});

test('classifyOutcome ignores a redesign recommendation with no material findings', () => {
  assert.deepEqual(classifyOutcome({
    workerStatus: 'completed',
    verification: 'pass',
    findings: [],
    recommendedAction: 'redesign',
  }), {
    disposition: 'accepted',
    action: 'complete-task',
    cause: null,
  });
});

test('classifyOutcome retries unparseable worker output on a stronger route, not the same one', () => {
  // A clean exit whose output cannot be parsed is usually a model too weak to emit the
  // schema (e.g. the cheapest tier), so the recovery must escalate rather than retry in place.
  assert.deepEqual(classifyOutcome({
    workerStatus: 'blocked',
    workerBlocker: 'unstructured result',
    verification: 'fail',
    runtimeStatus: 0,
    workerParseError: true,
    priorRetryCounts: {},
  }), {
    disposition: 'regenerated',
    action: 'retry-stronger',
    cause: 'environment-failure',
  });
});

test('classifyOutcome keeps a genuine spawn failure on the same route (retry-infrastructure)', () => {
  assert.deepEqual(classifyOutcome({
    workerStatus: 'blocked',
    verification: 'fail',
    runtimeStatus: 1,
    workerParseError: true,
    priorRetryCounts: {},
  }), {
    disposition: 'regenerated',
    action: 'retry-infrastructure',
    cause: 'environment-failure',
  });
});

test('classifyOutcome escalates a repeated unparseable worker result to a human', () => {
  assert.deepEqual(classifyOutcome({
    workerStatus: 'blocked',
    workerBlocker: 'missing structured output',
    verification: 'fail',
    runtimeStatus: 0,
    workerParseError: true,
    priorRetryCounts: { 'retry-stronger': 1 },
  }), {
    disposition: 'human-takeover',
    action: 'stop',
    cause: 'environment-failure',
  });
});

test('classifyOutcome retries initial task ambiguity with stronger context', () => {
  assert.deepEqual(classifyOutcome({
    workerStatus: 'blocked',
    verification: 'fail',
    priorRetryCounts: {},
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
    action: 'return-to-promotion',
    cause: 'incorrect-plan',
  });
});

test('classifyOutcome treats a worker-proven missing API as an incorrect plan', () => {
  assert.deepEqual(classifyOutcome({
    workerStatus: 'blocked',
    workerBlocker: 'incorrect-plan: Pinned package does not expose the planned API',
    verification: 'fail',
    priorRetryCounts: {},
  }), {
    disposition: 'redesign',
    action: 'return-to-promotion',
    cause: 'incorrect-plan',
  });
});

test('classifyOutcome escalates a repeated ambiguous worker result to a human', () => {
  assert.deepEqual(classifyOutcome({
    workerStatus: 'blocked',
    verification: 'fail',
    priorRetryCounts: { 'retry-context': 1 },
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

test('buildRuntimeCommand delegates containment to an existing external sandbox', () => {
  const command = buildRuntimeCommand({
    runtime: 'codex',
    root: '/repo',
    prompt: 'do task',
    model: 'default',
    effort: 'high',
    externalSandbox: true,
  });

  assert.deepEqual(command.args.slice(0, 5), [
    'exec', '--json', '--ephemeral', '--dangerously-bypass-approvals-and-sandbox', '-C',
  ]);
  assert.equal(command.args.includes('--sandbox'), false);
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
