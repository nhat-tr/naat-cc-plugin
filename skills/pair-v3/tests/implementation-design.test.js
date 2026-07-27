const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Ajv2020 = require('ajv/dist/2020').default;

const {
  compileReviewSliceExecutionPacket,
  validateImplementationDesignRecord,
  validatePlanImplementationDesign,
} = require('../scripts/lib/implementation-design');
const { validatePlan } = require('../scripts/lib/pair-core');
const { planContractDigest } = require('../scripts/lib/pair-core');
const { appendPairEvent } = require('../scripts/lib/pair-state');
const {
  appendEvidenceRecord,
  createWorkRoot,
} = require('../../brainstorming/scripts/work-lineage.cjs');
const {
  WORK_ID,
  canonicalSpec,
  compiledPlan,
  implementationDesignRecord,
  sha256,
} = require('./support/compiled-plan-fixture');

function scratchRepository(t) {
  const scratchRoot = process.env.CLAUDE_SCRATCH_DIR || path.join(os.homedir(), '.claude-scratch');
  const base = path.join(scratchRoot, 'my-claude-code', 'compiled-plan-tests');
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'repo-'));
  childProcess.spawnSync('git', ['init', '-q'], { cwd: root });
  fs.mkdirSync(path.join(root, 'src', 'commands'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'commands', 'help.js'), 'exports.registerHelp = () => {};\n');
  fs.writeFileSync(path.join(root, 'package.json'), '{"private":true,"scripts":{"test":"node --test"}}\n');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function persistFixture(t, overrides = {}) {
  const root = scratchRepository(t);
  const spec = canonicalSpec();
  createWorkRoot({ repositoryRoot: root, workId: WORK_ID, canonicalSpec: spec });
  const persisted = appendEvidenceRecord({
    repositoryRoot: root,
    record: {
      schema: 1,
      id: 'EVD-001-implementation-design',
      workId: WORK_ID,
      kind: 'implementation-design-contract',
      acceptanceCriteria: ['AC-1'],
      decisionRecordIds: [],
      source: 'pair-promote/repository-grounding',
      recordedAt: '2026-07-27T10:00:00.000Z',
      result: implementationDesignRecord(overrides).result,
    },
  });
  const bytes = fs.readFileSync(persisted.path);
  const plan = compiledPlan({ spec, designDigest: sha256(bytes) });
  fs.writeFileSync(path.join(root, '.pair', 'plan.md'), plan);
  return { root, plan, designPath: persisted.path };
}

test('compiled plans require explicit implementation profiles and decision mappings', () => {
  const missingProfile = compiledPlan()
    .replace('[type:feature] ', '')
    .replace('  - **Design:** IMP-001\n', '');
  const result = validatePlan(missingProfile);

  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /missing explicit type/i);
  assert.match(result.errors.join('\n'), /implementation decision/i);

  const providerConstraint = validatePlan(compiledPlan().replace(
    'Preserve the current command API; no new command framework.',
    'Use Claude Code to implement the greeting.',
  ));
  assert.equal(providerConstraint.valid, false);
  assert.match(providerConstraint.errors.join('\n'), /Constraints.*provider-specific executor instruction/i);
});

test('Implementation Design Contract rejects provider prompts and unresolved decisions', () => {
  const testCase = implementationDesignRecord().result.decisions[0].tests[0];
  const providerSpecific = implementationDesignRecord({
    resultOverrides: { provider: 'claude', prompt: 'read everything' },
    decisionOverrides: {
      outcome: 'Use Claude Code to implement the greeting.',
      failure_handling: ['TODO decide later'],
      non_goals: ['Do not ask Codex to perform this task.'],
      verify: 'claude -p implement the change',
      tests: [{ ...testCase, purpose: 'Ask Codex to implement the behavior.' }],
    },
  });
  const result = validateImplementationDesignRecord(providerSpecific);

  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /provider|prompt/i);
  assert.match(result.errors.join('\n'), /unresolved/i);
  assert.match(result.errors.join('\n'), /provider-specific executor instruction/i);
  assert.match(result.errors.join('\n'), /\.verify.*provider-specific/i);
  assert.match(result.errors.join('\n'), /\.tests\[0\]\.purpose.*provider-specific/i);
});

test('Implementation Design Contract requires explicit data shapes and acyclic decisions', () => {
  const missingShapes = implementationDesignRecord();
  delete missingShapes.result.decisions[0].data_shapes;
  const missingResult = validateImplementationDesignRecord(missingShapes);
  assert.equal(missingResult.valid, false);
  assert.match(missingResult.errors.join('\n'), /data_shapes/i);

  const cyclic = implementationDesignRecord();
  const first = cyclic.result.decisions[0];
  first.depends_on = ['IMP-002'];
  cyclic.result.decisions.push({
    ...structuredClone(first),
    id: 'IMP-002',
    depends_on: ['IMP-001'],
  });
  const cycleResult = validateImplementationDesignRecord(cyclic);
  assert.equal(cycleResult.valid, false);
  assert.match(cycleResult.errors.join('\n'), /dependency cycle/i);

  const hollowEvidence = implementationDesignRecord();
  hollowEvidence.result.repository_evidence[0].symbols = [];
  const hollowResult = validateImplementationDesignRecord(hollowEvidence);
  assert.equal(hollowResult.valid, false);
  assert.match(hollowResult.errors.join('\n'), /repository_evidence\[0\]\.symbols.*non-empty/i);
});

test('compiled plan validation binds an indexed immutable design digest and exact mappings', t => {
  const { root, plan } = persistFixture(t);
  const result = validatePlanImplementationDesign({
    root,
    planPath: path.join(root, '.pair', 'plan.md'),
    plan,
  });

  assert.equal(result.valid, true, result.errors.join('\n'));
  assert.equal(result.design.record.id, 'EVD-001-implementation-design');

  const tamperedDigest = plan.replace(result.design.sha256, 'f'.repeat(64));
  const tampered = validatePlanImplementationDesign({
    root,
    planPath: path.join(root, '.pair', 'plan.md'),
    plan: tamperedDigest,
  });
  assert.equal(tampered.valid, false);
  assert.match(tampered.errors.join('\n'), /digest mismatch/i);
});

test('compiled plan validation rejects unmapped decisions and decision-owned files outside the slice', t => {
  const { root, plan } = persistFixture(t, {
    decisionOverrides: {
      symbols: [{ path: 'src/unowned.js', symbol: 'surprise()', action: 'add' }],
    },
  });
  const result = validatePlanImplementationDesign({
    root,
    planPath: path.join(root, '.pair', 'plan.md'),
    plan,
  });

  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /src\/unowned\.js.*owned files/i);

  const noMapping = validatePlanImplementationDesign({
    root,
    planPath: path.join(root, '.pair', 'plan.md'),
    plan: plan.replace('  - **Design:** IMP-001\n', ''),
  });
  assert.equal(noMapping.valid, false);
  assert.match(noMapping.errors.join('\n'), /implementation decision/i);

  const hiddenOwnership = validatePlanImplementationDesign({
    root,
    planPath: path.join(root, '.pair', 'plan.md'),
    plan: plan.replace(
      '`src/commands/greeting.js`',
      '`src/commands/greeting.js`, `src/hidden.js`',
    ),
  });
  assert.equal(hiddenOwnership.valid, false);
  assert.match(hiddenOwnership.errors.join('\n'), /src\/hidden\.js.*not covered.*implementation decision/i);
});

test('compiled plan proves every existing decision reference and rejects unprojected repository evidence', t => {
  const missingPattern = persistFixture(t, {
    decisionOverrides: {
      pattern_references: [{ path: 'src/commands/missing.js', symbol: 'missingPattern' }],
    },
  });
  const missingResult = validatePlanImplementationDesign({
    root: missingPattern.root,
    planPath: path.join(missingPattern.root, '.pair', 'plan.md'),
    plan: missingPattern.plan,
  });
  assert.equal(missingResult.valid, false);
  assert.match(missingResult.errors.join('\n'), /src\/commands\/missing\.js.*(?:missing|evidence|exist)/i);

  const repositoryEvidence = implementationDesignRecord().result.repository_evidence;
  const orphaned = persistFixture(t, {
    resultOverrides: {
      repository_evidence: [...repositoryEvidence, { path: 'orphan.txt', symbols: ['unused'] }],
    },
  });
  fs.writeFileSync(path.join(orphaned.root, 'orphan.txt'), 'unused\n');
  const orphanedResult = validatePlanImplementationDesign({
    root: orphaned.root,
    planPath: path.join(orphaned.root, '.pair', 'plan.md'),
    plan: orphaned.plan,
  });
  assert.equal(orphanedResult.valid, false);
  assert.match(orphanedResult.errors.join('\n'), /orphan\.txt.*not referenced.*implementation decision/i);
});

test('compiled plan requires the design tests to match every declared test boundary', t => {
  const { root, plan } = persistFixture(t, {
    decisionOverrides: {
      tests: [{
        name: 'greeting unit behavior',
        file: 'tests/greeting.integration.test.js',
        boundary: 'unit',
        purpose: 'Exercise a narrow helper.',
        red_signal: 'helper is absent',
      }],
    },
  });
  const result = validatePlanImplementationDesign({
    root,
    planPath: path.join(root, '.pair', 'plan.md'),
    plan,
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /test boundary.*integration.*not covered/i);
});

test('compiled plan remains valid after an explicitly designed repository-evidence deletion', t => {
  const original = implementationDesignRecord().result.decisions[0].symbols;
  const repositoryEvidence = implementationDesignRecord().result.repository_evidence;
  const { root, plan } = persistFixture(t, {
    resultOverrides: {
      repository_evidence: [
        ...repositoryEvidence,
        { path: 'src/obsolete.js', symbols: ['obsolete()'] },
      ],
    },
    decisionOverrides: {
      symbols: [...original, { path: 'src/obsolete.js', symbol: 'obsolete()', action: 'delete' }],
      deletions: ['Delete src/obsolete.js after command dispatch no longer calls it.'],
    },
  });
  const deletionPlan = plan.replace(
    '`src/commands/greeting.js`',
    '`src/commands/greeting.js`, `src/obsolete.js`',
  );

  const beforeAttempt = validatePlanImplementationDesign({
    root,
    planPath: path.join(root, '.pair', 'plan.md'),
    plan: deletionPlan,
  });
  assert.equal(beforeAttempt.valid, false, 'promotion must prove the repository evidence existed');
  appendPairEvent(root, { event: 'work.opened', workId: WORK_ID, phase: 'ready' });
  appendPairEvent(root, {
    event: 'attempt.started', workId: WORK_ID, attemptId: 'delete-attempt', taskId: '1.1', phase: 'implementing',
  });
  const result = validatePlanImplementationDesign({
    root,
    planPath: path.join(root, '.pair', 'plan.md'),
    plan: deletionPlan,
  });
  assert.equal(result.valid, true, result.errors.join('\n'));
});

test('Review Slice Execution Packet is bounded, self-contained, and cheap-ready for grounded M work', t => {
  const { root, plan } = persistFixture(t);
  const packet = compileReviewSliceExecutionPacket({
    root,
    planPath: path.join(root, '.pair', 'plan.md'),
    plan,
    taskId: '1.1',
  });

  assert.equal(packet.schema, 1);
  assert.equal(packet.review_slice.id, '1.1');
  assert.deepEqual(packet.review_slice.acceptance_criteria, [
    { id: 'AC-1', text: 'the command prints the requested greeting.' },
  ]);
  assert.deepEqual(packet.review_slice.implementation_decisions.map(item => item.id), ['IMP-001']);
  assert.deepEqual(packet.review_slice.dependency_decisions, []);
  assert.deepEqual(packet.review_slice.constraints, [
    'Preserve the current command API; no new command framework.',
  ]);
  assert.deepEqual(packet.review_slice.repository_evidence.map(item => item.path), [
    'src/commands/help.js', 'package.json',
  ]);
  assert.match(packet.review_slice.implementation_decisions[0].call_paths[0], /registerGreeting/);
  assert.match(packet.review_slice.implementation_decisions[0].tests[0].red_signal, /not registered/);
  assert.deepEqual(packet.review_slice.non_goals, ['Do not introduce a general command framework.']);
  assert.equal(packet.routing.cheap_ready, true);
  assert.equal(packet.routing.recommended_strength, 2);
  assert.equal(packet.routing.packet_bytes <= 8192, true);
  assert.equal(packet.routing.packet_bytes, Buffer.byteLength(JSON.stringify(packet), 'utf8'));
  assert.doesNotMatch(JSON.stringify(packet), /claude|codex|prompt/i);
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const designSchema = JSON.parse(fs.readFileSync(path.join(__dirname, '../schemas/implementation-design.schema.json'), 'utf8'));
  const packetSchema = JSON.parse(fs.readFileSync(path.join(__dirname, '../schemas/review-slice-execution-packet.schema.json'), 'utf8'));
  ajv.addSchema(designSchema, 'implementation-design.schema.json');
  const validatePacket = ajv.compile(packetSchema);
  const schemaValid = validatePacket(packet);
  assert.equal(schemaValid, true, JSON.stringify(validatePacket.errors));
});

test('later Review Slice packets carry transitive upstream decision contracts', t => {
  const first = implementationDesignRecord().result.decisions[0];
  const second = {
    ...structuredClone(first),
    id: 'IMP-002',
    outcome: 'Format the registered greeting before it reaches stdout.',
    depends_on: ['IMP-001'],
    symbols: [{ path: 'src/greeting-format.js', symbol: 'formatGreeting(value)', action: 'add' }],
    call_paths: ['registered greeting -> formatGreeting(value) -> stdout'],
    tests: [{
      name: 'formatted greeting reaches stdout',
      file: 'tests/greeting-format.integration.test.js',
      boundary: 'integration',
      purpose: 'Prove AC-1 through the formatted command output.',
      red_signal: 'stdout contains the unformatted greeting',
    }],
    verify: 'node --test tests/greeting-format.integration.test.js',
  };
  const fixture = persistFixture(t, {
    resultOverrides: { decisions: [first, second] },
  });
  const plan = fixture.plan.replace('## Acceptance Criteria', [
    '- [ ] Task 1.2 — format the greeting at the command boundary',
    '  - **Profile:** [type:feature] [risk:medium] [scope:cross-module] [uncertainty:low] [ac:AC-1] [test:integration] · **M**',
    '  - **Files:** `tests/greeting-format.integration.test.js`, `src/greeting-format.js`',
    '  - **Tests:** `tests/greeting-format.integration.test.js`',
    '  - **Design:** IMP-002',
    '  - **Verify:** `node --test tests/greeting-format.integration.test.js`',
    '',
    '## Acceptance Criteria',
  ].join('\n'));
  fs.writeFileSync(path.join(fixture.root, '.pair', 'plan.md'), plan);

  const packet = compileReviewSliceExecutionPacket({
    root: fixture.root,
    planPath: path.join(fixture.root, '.pair', 'plan.md'),
    plan,
    taskId: '1.2',
  });

  assert.deepEqual(packet.review_slice.implementation_decisions.map(item => item.id), ['IMP-002']);
  assert.deepEqual(packet.review_slice.dependency_decisions.map(item => item.id), ['IMP-001']);
  assert.match(packet.review_slice.dependency_decisions[0].contract.after[0], /command dispatch prints/i);
});

test('cheap-ready is a gate, not an S/M alias', t => {
  const { root, plan } = persistFixture(t);
  const highRisk = plan.replace('[risk:medium]', '[risk:high]');
  const packet = compileReviewSliceExecutionPacket({
    root,
    planPath: path.join(root, '.pair', 'plan.md'),
    plan: highRisk,
    taskId: '1.1',
  });

  assert.equal(packet.routing.cheap_ready, false);
  assert.equal(packet.routing.recommended_strength, 3);
  assert.match(packet.routing.reasons.join('\n'), /high risk/i);
});

test('validate-plan CLI enforces the indexed design digest, not only Markdown shape', t => {
  const { root, designPath } = persistFixture(t);
  const validator = path.resolve(__dirname, '../scripts/validate-plan');
  const valid = childProcess.spawnSync(process.execPath, [validator, '.pair/plan.md'], {
    cwd: root, encoding: 'utf8',
  });
  assert.equal(valid.status, 0, valid.stdout + valid.stderr);
  assert.match(valid.stdout, /implementation design.*sha256/i);
  assert.match(valid.stdout, /Review Slice 1\.1.*cheap-ready=yes.*recommended-strength=2/i);

  fs.appendFileSync(designPath, ' ');
  const tampered = childProcess.spawnSync(process.execPath, [validator, '.pair/plan.md'], {
    cwd: root, encoding: 'utf8',
  });
  assert.equal(tampered.status, 1);
  assert.match(tampered.stdout + tampered.stderr, /Implementation design digest mismatch/i);
});

test('work-lineage CLI records a validated persisted evidence envelope immutably', t => {
  const root = scratchRepository(t);
  const spec = canonicalSpec();
  createWorkRoot({ repositoryRoot: root, workId: WORK_ID, canonicalSpec: spec });
  const candidate = path.join(root, 'implementation-design.json');
  fs.writeFileSync(candidate, `${JSON.stringify(implementationDesignRecord(), null, 2)}\n`);
  const lineage = path.resolve(__dirname, '../../brainstorming/scripts/work-lineage.cjs');

  const recorded = childProcess.spawnSync(process.execPath, [
    lineage, 'record-evidence', '--file', candidate, '--repository-root', root,
  ], { cwd: root, encoding: 'utf8' });

  assert.equal(recorded.status, 0, recorded.stdout + recorded.stderr);
  const output = JSON.parse(recorded.stdout);
  assert.equal(output.recorded, true);
  const work = JSON.parse(fs.readFileSync(path.join(root, 'docs', 'work', WORK_ID, 'work.json'), 'utf8'));
  assert.deepEqual(work.evidence_records, [
    `docs/work/${WORK_ID}/evidence/EVD-001-implementation-design.json`,
  ]);
});

test('Implementation Design validator enforces the generic persisted evidence envelope', t => {
  const root = scratchRepository(t);
  const candidate = path.join(root, 'implementation-design.json');
  const record = implementationDesignRecord();
  record.source = 'x'.repeat(101);
  fs.writeFileSync(candidate, `${JSON.stringify(record, null, 2)}\n`);

  const validation = childProcess.spawnSync(
    path.resolve(__dirname, '../../../bin/validate-implementation-design'),
    [candidate],
    { cwd: root, encoding: 'utf8' },
  );

  assert.equal(validation.status, 1);
  assert.match(validation.stdout + validation.stderr, /source.*100|too long/i);
});

test('Pair opens compiled Work with one private execution packet and no full-spec reread instruction', t => {
  const { root, plan } = persistFixture(t);
  const workFile = path.join(root, 'docs', 'work', WORK_ID, 'work.json');
  const work = JSON.parse(fs.readFileSync(workFile, 'utf8'));
  const digest = planContractDigest(plan);
  work.plan = {
    path: '.pair/plan.md', sha256: digest, status: 'validated',
    independent_review: `no-blockers:${digest}:codex/test`,
  };
  fs.writeFileSync(workFile, `${JSON.stringify(work, null, 2)}\n`);
  const fakeBin = path.join(root, 'fake-bin');
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(path.join(fakeBin, 'codex'), '#!/bin/sh\nexit 70\n', { mode: 0o755 });
  childProcess.spawnSync('git', ['add', '.'], { cwd: root });
  childProcess.spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'compiled plan'], { cwd: root });

  const run = childProcess.spawnSync(process.execPath, [
    path.resolve(__dirname, '../scripts/pair-task'), '--runtime', 'codex', '--once',
  ], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      CODEX_THREAD_ID: '', CLAUDE_CODE_SESSION_ID: '', CLAUDECODE: '',
      PAIR_AUTO_PLAN_CHALLENGE: '0',
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
    },
  });

  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /cheap-ready=yes.*recommended-strength=2/i);
  assert.doesNotMatch(run.stdout, /canonical specification.*before editing/i);
  const active = JSON.parse(fs.readFileSync(path.join(root, '.pair', 'active-attempt.json'), 'utf8'));
  assert.equal(active.cheapReady, true);
  assert.equal(active.recommendedStrength, 2);
  const packetFile = path.join(root, active.executionPacketPath);
  assert.equal(fs.statSync(packetFile).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(packetFile, 'utf8')).review_slice.id, '1.1');
});

test('compiled Pair dry-run is provider-portable and persists no runtime state', t => {
  const { root, plan } = persistFixture(t);
  const workFile = path.join(root, 'docs', 'work', WORK_ID, 'work.json');
  const work = JSON.parse(fs.readFileSync(workFile, 'utf8'));
  const digest = planContractDigest(plan);
  work.plan = {
    path: '.pair/plan.md', sha256: digest, status: 'validated',
    independent_review: `no-blockers:${digest}:codex/test`,
  };
  fs.writeFileSync(workFile, `${JSON.stringify(work, null, 2)}\n`);
  childProcess.spawnSync('git', ['add', '.'], { cwd: root });
  childProcess.spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'compiled plan'], { cwd: root });
  const fakeBin = path.join(root, 'fake-bin');
  fs.mkdirSync(fakeBin);
  for (const runtime of ['codex', 'claude']) {
    fs.writeFileSync(path.join(fakeBin, runtime), '#!/bin/sh\nexit 70\n', { mode: 0o755 });
  }

  for (const runtime of ['codex', 'claude']) {
    const run = childProcess.spawnSync(process.execPath, [
      path.resolve(__dirname, '../scripts/pair-task'), '--runtime', runtime, '--once', '--dry-run',
    ], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        CODEX_THREAD_ID: '', CLAUDE_CODE_SESSION_ID: '', CLAUDECODE: '',
        PAIR_AUTO_PLAN_CHALLENGE: '0',
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
      },
    });

    assert.equal(run.status, 0, `${runtime}: ${run.stdout}${run.stderr}`);
    const attempt = JSON.parse(run.stdout).attempt;
    assert.equal(attempt.cheapReady, true);
    assert.equal(attempt.recommendedStrength, 2);
    assert.equal(attempt.executionPacketPath, undefined);
    assert.equal(fs.existsSync(path.join(root, '.pair', 'runs')), false);
  }
});
