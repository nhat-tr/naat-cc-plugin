const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  appendChangeRecord,
  appendEvidenceRecord,
  appendOutcomeRecord,
  createWorkRoot,
  evaluateQualityContract,
  validateEvidenceFile,
  validateWorkDirectory,
  writeDecisionRecord,
} = require('../scripts/work-lineage.cjs');
const { createScratchDirectory } = require('./test-support');

const workId = 'work-20260712-visual-companion-vnext';

function git(repositoryRoot, args, expectedStatus = 0) {
  const result = childProcess.spawnSync('git', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  assert.equal(
    result.status,
    expectedStatus,
    `git ${args.join(' ')}\n${result.stdout}${result.stderr}`,
  );
  return result.stdout.trim();
}

function acceptedDecision(overrides = {}) {
  return {
    schema: 1,
    id: 'DR-001-visual-companion-vnext',
    status: 'accepted',
    workId,
    title: 'Structured Visual Companion vNext',
    originSpec: `docs/work/${workId}/spec.md`,
    acceptanceCriteria: ['AC-13', 'AC-14', 'AC-15'],
    context: 'The approved Work needs durable semantic lineage.',
    decision: 'Persist the choice under the canonical Work root.',
    rationale: 'Git-trackable records survive sessions and runtime changes.',
    alternatives: ['Keep the choice only in chat history.'],
    consequences: ['Accepted Decision Records become immutable.'],
    evidence: ['evidence/EVD-001-domain-veto.json'],
    changes: [],
    supersedes: null,
    supersededBy: null,
    ...overrides,
  };
}

function approvedSpec() {
  return [
    '# Spec: Visual Companion vNext',
    '',
    `- **Work ID:** \`${workId}\``,
    '',
    'Approved integration intent.',
    '',
    '## Engineering Quality Contract',
    '',
    'Approved quality obligations.',
    '',
  ].join('\n');
}

test('approved Work remains Git-trackable with immutable linked decisions, outcomes, evidence, and domain veto', t => {
  const repositoryRoot = createScratchDirectory(t, 'work-lineage-integration');
  git(repositoryRoot, ['init', '--quiet']);
  fs.writeFileSync(path.join(repositoryRoot, '.gitignore'), '.pair/\n.artifacts/\n');
  git(repositoryRoot, ['add', '.gitignore']);
  git(repositoryRoot, [
    '-c', 'user.name=Pair Test',
    '-c', 'user.email=pair-test@example.invalid',
    'commit', '--quiet', '-m', 'test baseline',
  ]);

  const canonicalSpec = approvedSpec();
  const specDigest = crypto.createHash('sha256').update(canonicalSpec).digest('hex');
  createWorkRoot({ repositoryRoot, workId, canonicalSpec });

  const workRoot = path.join(repositoryRoot, 'docs', 'work', workId);
  const mirrorPath = path.join(repositoryRoot, '.pair', 'spec.md');
  let work = JSON.parse(fs.readFileSync(path.join(workRoot, 'work.json'), 'utf8'));
  const mirror = fs.readFileSync(mirrorPath, 'utf8');

  assert.equal(work.work_id, workId);
  assert.deepEqual(work.spec, {
    path: `docs/work/${workId}/spec.md`,
    sha256: specDigest,
  });
  assert.equal(work.active_pair_mirror, '.pair/spec.md');
  assert.deepEqual(work.engineering_quality_contract, {
    path: `docs/work/${workId}/spec.md`,
    section: 'Engineering Quality Contract',
    status: 'approved',
  });
  assert.match(mirror, new RegExp(`^Canonical: docs/work/${workId}/spec\\.md$`, 'm'));
  assert.match(mirror, new RegExp(`^Canonical SHA-256: ${specDigest}$`, 'm'));

  git(repositoryRoot, ['check-ignore', '--quiet', '.pair/spec.md']);
  git(repositoryRoot, ['check-ignore', '--quiet', `docs/work/${workId}/work.json`], 1);
  git(repositoryRoot, ['add', `docs/work/${workId}`]);
  const initialTracked = git(repositoryRoot, ['diff', '--cached', '--name-only']).split('\n');
  assert.ok(initialTracked.includes(`docs/work/${workId}/work.json`));
  assert.ok(initialTracked.includes(`docs/work/${workId}/spec.md`));
  assert.ok(!initialTracked.includes('.pair/spec.md'));

  const first = writeDecisionRecord({ repositoryRoot, record: acceptedDecision() });
  const acceptedBytes = fs.readFileSync(first.path);
  const second = writeDecisionRecord({
    repositoryRoot,
    record: acceptedDecision({
      id: 'DR-002-revised-companion',
      title: 'Revised Visual Companion',
      acceptanceCriteria: ['AC-14'],
      supersedes: first.id,
    }),
  });
  assert.equal(second.supersedes, first.id);
  assert.deepEqual(fs.readFileSync(first.path), acceptedBytes);

  const outcome = appendOutcomeRecord({
    repositoryRoot,
    outcome: {
      schema: 1,
      id: 'OUT-001-manual-review',
      workId,
      decisionRecordIds: [first.id, second.id],
      source: 'manual_review',
      result: 'validated',
      evidence: ['evidence/EVD-001-domain-veto.json'],
      recordedAt: '2026-08-01T10:00:00.000Z',
    },
  });

  const qualityResult = evaluateQualityContract({
    workId,
    facts: ['new_authenticated_endpoint'],
    obligations: [{
      id: 'EQC-SEC',
      quality: 'security',
      activation: 'fact',
      activationFacts: ['new_authenticated_endpoint'],
      impact: 'high',
      owner: 'Runtime owner',
      status: 'inactive',
    }],
    exclusions: [{
      obligationId: 'EQC-SEC',
      status: 'not_applicable',
      evidence: ['evidence/security-analysis.md'],
      decider: 'product-owner',
      reviewer: 'senior-reviewer',
      owner: 'runtime-owner',
      residualRisk: 'Authentication behavior still requires specialist review.',
      approval: { state: 'approved', approvedBy: 'user', provenanceId: 'APR-user' },
    }],
  }, {
    verifyApproval(approval) {
      return approval.provenanceId === 'APR-user'
        ? { approvedBy: 'user', authority: 'user', domain: null }
        : null;
    },
  });
  assert.equal(qualityResult.obligations[0].status, 'open');
  assert.equal(qualityResult.obligations[0].exclusion.state, 'domain_approval_required');
  assert.equal(qualityResult.canClose, false);

  const evidence = appendEvidenceRecord({
    repositoryRoot,
    record: {
      schema: 1,
      id: 'EVD-001-domain-veto',
      workId,
      kind: 'engineering_quality_contract',
      acceptanceCriteria: ['AC-15'],
      decisionRecordIds: [first.id, second.id],
      source: 'integration_test',
      recordedAt: '2026-08-01T10:01:00.000Z',
      result: qualityResult,
    },
  });

  assert.equal(
    path.relative(repositoryRoot, outcome.path),
    `docs/work/${workId}/outcomes/OUT-001-manual-review.md`,
  );
  assert.equal(
    path.relative(repositoryRoot, evidence.path),
    `docs/work/${workId}/evidence/EVD-001-domain-veto.json`,
  );
  const persistedEvidence = JSON.parse(fs.readFileSync(evidence.path, 'utf8'));
  assert.equal(persistedEvidence.work_id, workId);
  assert.deepEqual(persistedEvidence.acceptance_criteria, ['AC-15']);
  assert.deepEqual(persistedEvidence.decision_record_ids, [first.id, second.id]);
  assert.equal(persistedEvidence.result.obligations[0].status, 'open');

  work = JSON.parse(fs.readFileSync(path.join(workRoot, 'work.json'), 'utf8'));
  assert.deepEqual(work.decision_records, [
    `docs/work/${workId}/decisions/DR-001-visual-companion-vnext.md`,
    `docs/work/${workId}/decisions/DR-002-revised-companion.md`,
  ]);
  assert.deepEqual(work.decision_supersessions, [{
    predecessor: first.id,
    successor: second.id,
  }]);
  assert.deepEqual(work.outcomes, [`docs/work/${workId}/outcomes/OUT-001-manual-review.md`]);
  assert.deepEqual(work.evidence_records, [`docs/work/${workId}/evidence/EVD-001-domain-veto.json`]);
  assert.deepEqual(fs.readFileSync(first.path), acceptedBytes);

  git(repositoryRoot, ['add', `docs/work/${workId}`]);
  const allTracked = git(repositoryRoot, ['diff', '--cached', '--name-only']).split('\n');
  assert.ok(allTracked.includes(path.relative(repositoryRoot, first.path)));
  assert.ok(allTracked.includes(path.relative(repositoryRoot, second.path)));
  assert.ok(allTracked.includes(path.relative(repositoryRoot, outcome.path)));
  assert.ok(allTracked.includes(path.relative(repositoryRoot, evidence.path)));
  assert.equal(validateWorkDirectory(workRoot, ['engineering_quality_contract']).work_id, workId);
});

test('work-lineage create CLI publishes an approved candidate as a canonical Work and generated mirror', t => {
  const repositoryRoot = createScratchDirectory(t, 'work-lineage-create-cli');
  const candidate = path.join(repositoryRoot, 'approved-candidate.md');
  fs.writeFileSync(candidate, approvedSpec());
  const script = path.resolve(__dirname, '../scripts/work-lineage.cjs');
  const result = childProcess.spawnSync(script, [
    'create',
    '--repository-root', repositoryRoot,
    '--work-id', workId,
    '--spec-file', candidate,
  ], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.created, true);
  assert.equal(output.work_id, workId);
  assert.deepEqual(output.spec, {
    path: `docs/work/${workId}/spec.md`,
    sha256: crypto.createHash('sha256').update(approvedSpec()).digest('hex'),
  });
  assert.equal(
    validateWorkDirectory(path.join(repositoryRoot, 'docs', 'work', workId)).work_id,
    workId,
  );
});

test('all lineage writers and validators reject repository symlink escapes', t => {
  const repositoryRoot = createScratchDirectory(t, 'work-lineage-writer-symlinks');
  const outside = createScratchDirectory(t, 'work-lineage-writer-symlinks-outside');
  createWorkRoot({ repositoryRoot, workId, canonicalSpec: approvedSpec() });
  const workRoot = path.join(repositoryRoot, 'docs', 'work', workId);

  const decisionsDirectory = path.join(workRoot, 'decisions');
  fs.symlinkSync(outside, decisionsDirectory, 'dir');
  assert.throws(
    () => writeDecisionRecord({ repositoryRoot, record: acceptedDecision() }),
    /symbolic link|symlink/i,
  );
  assert.equal(fs.existsSync(path.join(outside, `${acceptedDecision().id}.md`)), false);
  fs.unlinkSync(decisionsDirectory);
  const decision = writeDecisionRecord({ repositoryRoot, record: acceptedDecision() });

  const writerCases = [
    {
      directory: 'outcomes',
      outsideFile: 'OUT-001-symlink.md',
      write() {
        appendOutcomeRecord({
          repositoryRoot,
          outcome: {
            schema: 1,
            id: 'OUT-001-symlink',
            workId,
            decisionRecordIds: [decision.id],
            source: 'manual_review',
            result: 'validated',
            evidence: [],
            recordedAt: '2026-08-01T10:00:00.000Z',
          },
        });
      },
    },
    {
      directory: 'evidence',
      outsideFile: 'EVD-001-symlink.json',
      write() {
        appendEvidenceRecord({
          repositoryRoot,
          record: {
            schema: 1,
            id: 'EVD-001-symlink',
            workId,
            kind: 'symlink_test',
            acceptanceCriteria: ['AC-13'],
            decisionRecordIds: [decision.id],
            source: 'integration_test',
            recordedAt: '2026-08-01T10:00:00.000Z',
            result: { passed: false },
          },
        });
      },
    },
    {
      directory: 'changes',
      outsideFile: 'CHG-001-symlink.json',
      write() {
        appendChangeRecord({
          repositoryRoot,
          record: {
            schema: 1,
            id: 'CHG-001-symlink',
            workId,
            acceptanceCriteria: ['AC-13'],
            decisionRecordIds: [decision.id],
            summary: 'Exercise path containment.',
            files: ['skills/brainstorming/scripts/work-lineage.cjs'],
            recordedAt: '2026-08-01T10:00:00.000Z',
          },
        });
      },
    },
  ];

  for (const writerCase of writerCases) {
    const directory = path.join(workRoot, writerCase.directory);
    fs.symlinkSync(outside, directory, 'dir');
    assert.throws(writerCase.write, /symbolic link|symlink/i);
    assert.equal(fs.existsSync(path.join(outside, writerCase.outsideFile)), false);
    fs.unlinkSync(directory);
  }

  const outsideEvidence = path.join(outside, 'outside-evidence.json');
  fs.writeFileSync(outsideEvidence, JSON.stringify({ schema: 1 }));
  const evidenceLink = path.join(workRoot, 'linked-evidence.json');
  fs.symlinkSync(outsideEvidence, evidenceLink, 'file');
  assert.throws(() => validateEvidenceFile(evidenceLink), /symbolic link|symlink/i);

  const specFile = path.join(workRoot, 'spec.md');
  const specBytes = fs.readFileSync(specFile);
  const outsideSpec = path.join(outside, 'outside-spec.md');
  fs.writeFileSync(outsideSpec, specBytes);
  fs.unlinkSync(specFile);
  fs.symlinkSync(outsideSpec, specFile, 'file');
  assert.throws(() => validateWorkDirectory(workRoot), /symbolic link|symlink/i);
});

test('concurrent lineage writers reclaim one stale lock without losing Work index references', async t => {
  const repositoryRoot = createScratchDirectory(t, 'work-lineage-concurrency');
  createWorkRoot({ repositoryRoot, workId, canonicalSpec: approvedSpec() });
  const modulePath = path.resolve(__dirname, '../scripts/work-lineage.cjs');
  const lockFile = path.join(repositoryRoot, 'docs', 'work', workId, '.work-lineage.lock');
  fs.writeFileSync(lockFile, `${JSON.stringify({ pid: 2_147_483_647, token: 'stale-owner' })}\n`);
  fs.writeFileSync(`${lockFile}.reclaim`, `${JSON.stringify({ pid: 2_147_483_647, token: 'stale-reclaimer' })}\n`);

  const writes = Array.from({ length: 8 }, (_, index) => {
    const number = String(index + 1).padStart(3, '0');
    const seconds = String(index + 1).padStart(2, '0');
    const record = {
      schema: 1,
      id: `EVD-${number}-concurrent`,
      workId,
      kind: 'concurrency_test',
      acceptanceCriteria: ['AC-13'],
      decisionRecordIds: [],
      source: 'integration_test',
      recordedAt: `2026-08-01T10:00:${seconds}.000Z`,
      result: { index },
    };
    const script = [
      `const { appendEvidenceRecord } = require(${JSON.stringify(modulePath)});`,
      `appendEvidenceRecord({ repositoryRoot: ${JSON.stringify(repositoryRoot)}, record: ${JSON.stringify(record)} });`,
    ].join('\n');
    return new Promise((resolve, reject) => {
      const child = childProcess.spawn(process.execPath, ['-e', script], { encoding: 'utf8' });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', code => {
        if (code === 0) resolve();
        else reject(new Error(stderr || `child exited ${code}`));
      });
    });
  });

  await Promise.all(writes);
  const work = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'docs', 'work', workId, 'work.json')));
  assert.equal(work.evidence_records.length, 8);
  assert.deepEqual(
    [...work.evidence_records].sort(),
    Array.from({ length: 8 }, (_, index) => {
      const number = String(index + 1).padStart(3, '0');
      return `docs/work/${workId}/evidence/EVD-${number}-concurrent.json`;
    }),
  );
});

test('Work creation resumes after interruption between root and mirror publication', t => {
  const repositoryRoot = createScratchDirectory(t, 'work-lineage-create-recovery');
  const modulePath = path.resolve(__dirname, '../scripts/work-lineage.cjs');
  const targetRoot = path.join(repositoryRoot, 'docs', 'work', workId);
  fs.mkdirSync(path.join(repositoryRoot, '.pair'), { recursive: true });
  fs.writeFileSync(path.join(repositoryRoot, '.pair', 'spec.md'), 'prior active mirror\n');
  const script = [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    `const { createWorkRoot } = require(${JSON.stringify(modulePath)});`,
    `const target = ${JSON.stringify(targetRoot)};`,
    'const rename = fs.renameSync;',
    'fs.renameSync = function(source, destination) {',
    '  const result = rename.call(fs, source, destination);',
    '  if (path.resolve(destination) === path.resolve(target)) process.exit(73);',
    '  return result;',
    '};',
    `createWorkRoot({ repositoryRoot: ${JSON.stringify(repositoryRoot)}, workId: ${JSON.stringify(workId)}, canonicalSpec: ${JSON.stringify(approvedSpec())} });`,
  ].join('\n');
  const interrupted = childProcess.spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });

  assert.equal(interrupted.status, 73, interrupted.stderr);
  assert.equal(fs.existsSync(targetRoot), true);
  assert.equal(fs.existsSync(path.join(repositoryRoot, '.pair', 'spec.md')), false);

  const recovered = createWorkRoot({ repositoryRoot, workId, canonicalSpec: approvedSpec() });
  assert.equal(recovered.path, targetRoot);
  assert.equal(validateWorkDirectory(targetRoot).work_id, workId);
  assert.equal(
    fs.readdirSync(path.join(repositoryRoot, '.pair')).some(file => file.endsWith('.backup') || file.endsWith('.staging')),
    false,
  );
});

test('Work creation restarts after interruption during staged-root preparation', t => {
  const repositoryRoot = createScratchDirectory(t, 'work-lineage-stage-recovery');
  const modulePath = path.resolve(__dirname, '../scripts/work-lineage.cjs');
  const targetRoot = path.join(repositoryRoot, 'docs', 'work', workId);
  const script = [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    `const { createWorkRoot } = require(${JSON.stringify(modulePath)});`,
    'const mkdir = fs.mkdirSync;',
    'fs.mkdirSync = function(directory, options) {',
    '  const result = mkdir.call(fs, directory, options);',
    `  if (path.basename(directory).startsWith('.${workId}.') && path.basename(directory).endsWith('.staging')) process.exit(75);`,
    '  return result;',
    '};',
    `createWorkRoot({ repositoryRoot: ${JSON.stringify(repositoryRoot)}, workId: ${JSON.stringify(workId)}, canonicalSpec: ${JSON.stringify(approvedSpec())} });`,
  ].join('\n');
  const interrupted = childProcess.spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });

  assert.equal(interrupted.status, 75, interrupted.stderr);
  const recovered = createWorkRoot({ repositoryRoot, workId, canonicalSpec: approvedSpec() });
  assert.equal(recovered.path, targetRoot);
  assert.equal(validateWorkDirectory(targetRoot).work_id, workId);
});

test('interrupted record publication is reported as unindexed and repaired by an idempotent retry', t => {
  const repositoryRoot = createScratchDirectory(t, 'work-lineage-record-recovery');
  createWorkRoot({ repositoryRoot, workId, canonicalSpec: approvedSpec() });
  const modulePath = path.resolve(__dirname, '../scripts/work-lineage.cjs');
  const record = {
    schema: 1,
    id: 'EVD-001-orphan',
    workId,
    kind: 'crash_recovery',
    acceptanceCriteria: ['AC-13'],
    decisionRecordIds: [],
    source: 'integration_test',
    recordedAt: '2026-08-01T10:00:00.000Z',
    result: { interrupted: true },
  };
  const target = path.join(repositoryRoot, 'docs', 'work', workId, 'evidence', `${record.id}.json`);
  const script = [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    `const { appendEvidenceRecord } = require(${JSON.stringify(modulePath)});`,
    `const target = ${JSON.stringify(target)};`,
    'const rename = fs.renameSync;',
    'fs.renameSync = function(source, destination) {',
    '  const result = rename.call(fs, source, destination);',
    '  if (path.resolve(destination) === path.resolve(target)) process.exit(74);',
    '  return result;',
    '};',
    `appendEvidenceRecord({ repositoryRoot: ${JSON.stringify(repositoryRoot)}, record: ${JSON.stringify(record)} });`,
  ].join('\n');
  const interrupted = childProcess.spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });

  assert.equal(interrupted.status, 74, interrupted.stderr);
  assert.equal(fs.existsSync(target), true);
  const directory = path.join(repositoryRoot, 'docs', 'work', workId);
  assert.throws(() => validateWorkDirectory(directory), /unindexed.*evidence|orphan/i);

  appendEvidenceRecord({ repositoryRoot, record });
  const work = JSON.parse(fs.readFileSync(path.join(directory, 'work.json'), 'utf8'));
  assert.deepEqual(work.evidence_records, [`docs/work/${workId}/evidence/${record.id}.json`]);
  assert.equal(validateWorkDirectory(directory, ['crash_recovery']).work_id, workId);
});
