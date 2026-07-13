const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  appendEvidenceRecord,
  appendOutcomeRecord,
  createWorkRoot,
  validateEvidenceFile,
  validateWorkDirectory,
  writeDecisionRecord,
} = require('../scripts/work-lineage.cjs');
const workSchema = require('../schemas/work.schema.json');
const { createScratchDirectory } = require('./test-support');

const workId = 'work-20260712-visual-companion-vnext';

function approvedSpec(title = 'Approved specification') {
  return [
    `# ${title}`,
    '',
    `- **Work ID:** \`${workId}\``,
    '',
    '## Engineering Quality Contract',
    '',
    'Approved quality obligations.',
    '',
  ].join('\n');
}

function acceptedDecision(overrides = {}) {
  return {
    schema: 1,
    id: 'DR-001-visual-companion-vnext',
    status: 'accepted',
    workId,
    title: 'Structured Visual Companion vNext',
    originSpec: `docs/work/${workId}/spec.md`,
    acceptanceCriteria: ['AC-13', 'AC-14'],
    context: 'The current workflow loses semantic lineage.',
    decision: 'Persist accepted choices below the canonical Work root.',
    rationale: 'Later sessions must recover intent without private runtime state.',
    alternatives: ['Keep decisions only in the active session.'],
    consequences: ['Accepted records become immutable Git artifacts.'],
    evidence: ['evidence/capability.json'],
    changes: ['changes/CHG-001-implementation.json'],
    supersedes: null,
    supersededBy: null,
    ...overrides,
  };
}

function assertContainsAll(contents, values) {
  for (const value of values) assert.match(contents, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}

test('work lineage root creates a canonical spec and digest-linked active mirror for one Work ID', t => {
  const repositoryRoot = createScratchDirectory(t, 'work-lineage-root');
  const canonicalSpec = approvedSpec();
  const expectedDigest = crypto.createHash('sha256').update(canonicalSpec).digest('hex');

  const created = createWorkRoot({ repositoryRoot, workId, canonicalSpec });
  const workRoot = path.join(repositoryRoot, 'docs', 'work', workId);
  const work = JSON.parse(fs.readFileSync(path.join(workRoot, 'work.json'), 'utf8'));
  const mirror = fs.readFileSync(path.join(repositoryRoot, '.pair', 'spec.md'), 'utf8');

  assert.equal(created.workId, workId);
  assert.equal(work.work_id, workId);
  assert.equal(work.spec.path, `docs/work/${workId}/spec.md`);
  assert.equal(work.spec.sha256, expectedDigest);
  assert.equal(work.active_pair_mirror, '.pair/spec.md');
  assert.deepEqual(work.engineering_quality_contract, {
    path: `docs/work/${workId}/spec.md`,
    section: 'Engineering Quality Contract',
    status: 'approved',
  });
  assert.equal(fs.readFileSync(path.join(workRoot, 'spec.md'), 'utf8'), canonicalSpec);
  assert.match(mirror, new RegExp(`^Canonical: docs/work/${workId}/spec\\.md$`, 'm'));
  assert.match(mirror, new RegExp(`^Canonical SHA-256: ${expectedDigest}$`, 'm'));
});

test('work lineage root deterministically tiebreaks a same-day same-slug Work ID collision', t => {
  const repositoryRoot = createScratchDirectory(t, 'work-lineage-id-collision');
  const collidingSpec = approvedSpec('Colliding approved specification');
  const suffix = crypto.createHash('sha256').update(collidingSpec).digest('hex').slice(0, 12);
  const collisionWorkId = `${workId}-${suffix}`;

  createWorkRoot({ repositoryRoot, workId, canonicalSpec: approvedSpec() });
  const created = createWorkRoot({ repositoryRoot, workId, canonicalSpec: collidingSpec });
  const workRoot = path.join(repositoryRoot, 'docs', 'work', collisionWorkId);
  const persistedSpec = fs.readFileSync(path.join(workRoot, 'spec.md'), 'utf8');
  const persistedWork = JSON.parse(fs.readFileSync(path.join(workRoot, 'work.json'), 'utf8'));

  assert.equal(created.workId, collisionWorkId);
  assert.match(persistedSpec, new RegExp('^- \\*\\*Work ID:\\*\\* `' + collisionWorkId + '`$', 'm'));
  assert.equal(persistedWork.work_id, collisionWorkId);
  assert.equal(persistedWork.spec.path, `docs/work/${collisionWorkId}/spec.md`);
  assert.equal(
    persistedWork.spec.sha256,
    crypto.createHash('sha256').update(persistedSpec).digest('hex'),
  );
});

test('work lineage root does not treat an identical Work retry as a slug collision', t => {
  const repositoryRoot = createScratchDirectory(t, 'work-lineage-id-retry');
  const canonicalSpec = approvedSpec();
  const suffix = crypto.createHash('sha256').update(canonicalSpec).digest('hex').slice(0, 12);

  createWorkRoot({ repositoryRoot, workId, canonicalSpec });

  assert.throws(
    () => createWorkRoot({ repositoryRoot, workId, canonicalSpec }),
    /already exists/i,
  );
  assert.equal(
    fs.existsSync(path.join(repositoryRoot, 'docs', 'work', `${workId}-${suffix}`)),
    false,
  );
});

test('Work schema encodes the deterministic Work ID collision suffix rule', () => {
  const collisionSuffix = workSchema.$defs.work_id_collision_suffix;

  assert.deepEqual(
    {
      type: collisionSuffix?.type,
      pattern: collisionSuffix?.pattern,
      minLength: collisionSuffix?.minLength,
      maxLength: collisionSuffix?.maxLength,
    },
    {
      type: 'string',
      pattern: '^[a-f0-9]{12}$',
      minLength: 12,
      maxLength: 12,
    },
  );
  assert.match(collisionSuffix.$comment, /same-day same-slug.*SHA-256.*canonical spec/i);
});

test('work lineage root rejects a malformed or mismatched Work ID', t => {
  const repositoryRoot = createScratchDirectory(t, 'work-id');

  assert.throws(
    () => createWorkRoot({ repositoryRoot, workId: 'session-123', canonicalSpec: approvedSpec() }),
    /Work ID/i,
  );

  assert.throws(
    () => createWorkRoot({
      repositoryRoot,
      workId,
      canonicalSpec: approvedSpec().replace(workId, 'work-20260712-different-work'),
    }),
    /Work ID|match/i,
  );
});

test('work lineage root rejects a heading-only Engineering Quality Contract', t => {
  const repositoryRoot = createScratchDirectory(t, 'work-lineage-empty-quality-contract');
  const canonicalSpec = [
    '# Approved specification',
    '',
    `- **Work ID:** \`${workId}\``,
    '',
    '## Engineering Quality Contract',
    '',
  ].join('\n');

  assert.throws(
    () => createWorkRoot({ repositoryRoot, workId, canonicalSpec }),
    /Engineering Quality Contract.*(content|obligation)|empty/i,
  );
});

test('work lineage root rejects repository symlink escapes and recovers from mirror setup failure', t => {
  const repositoryRoot = createScratchDirectory(t, 'work-lineage-path-safety');
  const outside = createScratchDirectory(t, 'work-lineage-path-safety-outside');
  const workParent = path.join(repositoryRoot, 'docs', 'work');
  const targetRoot = path.join(workParent, workId);
  fs.mkdirSync(workParent, { recursive: true });
  fs.symlinkSync(outside, targetRoot, 'dir');

  assert.throws(
    () => createWorkRoot({ repositoryRoot, workId, canonicalSpec: approvedSpec() }),
    /symbolic link|symlink/i,
  );
  assert.equal(fs.existsSync(path.join(outside, 'spec.md')), false);
  fs.unlinkSync(targetRoot);

  fs.symlinkSync(outside, path.join(repositoryRoot, '.pair'), 'dir');
  assert.throws(
    () => createWorkRoot({ repositoryRoot, workId, canonicalSpec: approvedSpec() }),
    /symbolic link|symlink/i,
  );
  assert.equal(fs.existsSync(path.join(outside, 'spec.md')), false);
  fs.unlinkSync(path.join(repositoryRoot, '.pair'));

  fs.writeFileSync(path.join(repositoryRoot, '.pair'), 'not a directory');
  assert.throws(
    () => createWorkRoot({ repositoryRoot, workId, canonicalSpec: approvedSpec() }),
    /directory|mirror|pair/i,
  );
  assert.equal(fs.existsSync(targetRoot), false);

  fs.unlinkSync(path.join(repositoryRoot, '.pair'));
  const created = createWorkRoot({ repositoryRoot, workId, canonicalSpec: approvedSpec() });
  assert.equal(created.path, targetRoot);
});

test('decision record lifecycle preserves accepted records, supersedes explicitly, and appends later manual outcomes', t => {
  const repositoryRoot = createScratchDirectory(t, 'decision-record-lifecycle');
  createWorkRoot({ repositoryRoot, workId, canonicalSpec: approvedSpec() });

  const first = writeDecisionRecord({ repositoryRoot, record: acceptedDecision() });
  const acceptedBytes = fs.readFileSync(first.path);
  assert.equal(
    path.relative(repositoryRoot, first.path),
    `docs/work/${workId}/decisions/DR-001-visual-companion-vnext.md`,
  );
  assertContainsAll(acceptedBytes.toString('utf8'), [
    workId,
    'accepted',
    'AC-13',
    'AC-14',
    'evidence/capability.json',
    'changes/CHG-001-implementation.json',
    '## Context',
    '## Decision',
    '## Rationale',
    '## Alternatives Rejected',
    '## Consequences',
  ]);
  assert.throws(
    () => writeDecisionRecord({
      repositoryRoot,
      record: acceptedDecision({
        id: 'DR-009-forged-reverse-link',
        supersededBy: 'DR-010-not-written',
      }),
    }),
    /supersededBy|successor/i,
  );
  assert.throws(
    () => writeDecisionRecord({
      repositoryRoot,
      record: acceptedDecision({ title: 'Mutated after acceptance' }),
    }),
    /immutable|accepted/i,
  );
  assert.deepEqual(fs.readFileSync(first.path), acceptedBytes);

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
  assert.equal(
    path.relative(repositoryRoot, second.path),
    `docs/work/${workId}/decisions/DR-002-revised-companion.md`,
  );
  assertContainsAll(fs.readFileSync(second.path, 'utf8'), [
    workId,
    'AC-14',
    first.id,
  ]);
  assert.deepEqual(fs.readFileSync(first.path), acceptedBytes);

  const work = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'docs', 'work', workId, 'work.json')));
  assert.deepEqual(work.decision_supersessions, [{
    predecessor: first.id,
    successor: second.id,
  }]);

  const outcome = appendOutcomeRecord({
    repositoryRoot,
    outcome: {
      schema: 1,
      id: 'OUT-001-manual-review',
      workId,
      decisionRecordIds: [first.id, 'DR-002-revised-companion'],
      source: 'manual_review',
      result: 'redesign_required',
      evidence: ['evidence/manual-review.md'],
      recordedAt: '2026-08-01T10:00:00.000Z',
    },
  });

  assert.equal(outcome.source, 'manual_review');
  assert.deepEqual(outcome.decisionRecordIds, [first.id, 'DR-002-revised-companion']);
  assert.equal(
    path.relative(repositoryRoot, outcome.path),
    `docs/work/${workId}/outcomes/OUT-001-manual-review.md`,
  );
  assertContainsAll(fs.readFileSync(outcome.path, 'utf8'), [
    workId,
    first.id,
    'DR-002-revised-companion',
    'manual_review',
    'redesign_required',
    'evidence/manual-review.md',
  ]);
  assert.deepEqual(fs.readFileSync(first.path), acceptedBytes);
});

test('evidence and Work validation share exact identifiers, timestamps, paths, and indexed contents', t => {
  const repositoryRoot = createScratchDirectory(t, 'work-lineage-validation');
  createWorkRoot({ repositoryRoot, workId, canonicalSpec: approvedSpec() });
  const decision = writeDecisionRecord({ repositoryRoot, record: acceptedDecision() });
  const evidence = appendEvidenceRecord({
    repositoryRoot,
    record: {
      schema: 1,
      id: 'EVD-001-validation',
      workId,
      kind: 'integration_test',
      acceptanceCriteria: ['AC-13'],
      decisionRecordIds: [decision.id],
      source: 'node_test',
      recordedAt: '2026-08-01T10:01:00.000Z',
      result: { passed: true },
    },
  });

  assert.equal(validateEvidenceFile(evidence.path).id, 'EVD-001-validation');
  const directory = path.join(repositoryRoot, 'docs', 'work', workId);
  assert.equal(validateWorkDirectory(directory, ['integration_test']).work_id, workId);

  const valid = JSON.parse(fs.readFileSync(evidence.path, 'utf8'));
  const invalidRecords = [
    { ...valid, acceptance_criteria: ['not-an-ac'] },
    { ...valid, decision_record_ids: ['not-a-decision'] },
    { ...valid, recorded_at: 'yesterday' },
    { ...valid, recorded_at: '2026-02-30T10:01:00.000Z' },
    { ...valid, unexpected: true },
  ];
  for (const invalid of invalidRecords) {
    fs.writeFileSync(evidence.path, `${JSON.stringify(invalid)}\n`);
    assert.throws(() => validateEvidenceFile(evidence.path), /invalid|unsupported|recorded|acceptance|Decision/i);
  }

  fs.writeFileSync(evidence.path, `${JSON.stringify(valid, null, 2)}\n`);
  fs.unlinkSync(evidence.path);
  assert.throws(
    () => validateWorkDirectory(directory, ['integration_test']),
    /missing|does not exist|evidence/i,
  );
});

test('Work validation rejects hollow Decision Records, stripped outcomes, and ambiguous supersession', t => {
  const repositoryRoot = createScratchDirectory(t, 'work-lineage-semantic-validation');
  createWorkRoot({ repositoryRoot, workId, canonicalSpec: approvedSpec() });
  const directory = path.join(repositoryRoot, 'docs', 'work', workId);
  const first = writeDecisionRecord({ repositoryRoot, record: acceptedDecision() });
  const outcome = appendOutcomeRecord({
    repositoryRoot,
    outcome: {
      schema: 1,
      id: 'OUT-001-semantic-validation',
      workId,
      decisionRecordIds: [first.id],
      source: 'manual_review',
      result: 'validated',
      evidence: [],
      recordedAt: '2026-08-01T10:00:00.000Z',
    },
  });
  const decisionBytes = fs.readFileSync(first.path, 'utf8');
  const invalidDecisions = [
    decisionBytes.replace(/## Context\n\n[\s\S]*?\n\n## Decision/, '## Context\n\n## Decision'),
    decisionBytes.replace('- **Supersedes:** none', '- **Supersedes:** `totally-invalid`'),
    decisionBytes.replace(
      /^- \*\*Acceptance Criteria:\*\* .+$/m,
      '- **Acceptance Criteria:** garbage, `AC-13`, `AC-13`',
    ),
  ];
  for (const invalid of invalidDecisions) {
    fs.writeFileSync(first.path, invalid);
    assert.throws(
      () => validateWorkDirectory(directory),
      /Context|Supersedes|Acceptance Criteria|duplicate|semantic/i,
    );
    fs.writeFileSync(first.path, decisionBytes);
  }

  const outcomeBytes = fs.readFileSync(outcome.path, 'utf8');
  const strippedOutcome = outcomeBytes.replace(
    /^- \*\*(?:Schema|Source|Result|Evidence):\*\*.*\n/gm,
    '',
  );
  fs.writeFileSync(outcome.path, strippedOutcome);
  assert.throws(() => validateWorkDirectory(directory), /outcome.*(Schema|Source|Result|Evidence|malformed)/i);
  fs.writeFileSync(outcome.path, outcomeBytes);

  const second = writeDecisionRecord({
    repositoryRoot,
    record: acceptedDecision({ id: 'DR-002-first-successor', title: 'First successor', supersedes: first.id }),
  });
  const third = writeDecisionRecord({
    repositoryRoot,
    record: acceptedDecision({ id: 'DR-003-second-successor', title: 'Second successor' }),
  });
  fs.writeFileSync(
    third.path,
    fs.readFileSync(third.path, 'utf8').replace('- **Supersedes:** none', `- **Supersedes:** \`${first.id}\``),
  );
  const workFile = path.join(directory, 'work.json');
  const work = JSON.parse(fs.readFileSync(workFile, 'utf8'));
  work.decision_supersessions.push({ predecessor: first.id, successor: third.id });
  fs.writeFileSync(workFile, `${JSON.stringify(work, null, 2)}\n`);

  assert.equal(second.supersedes, first.id);
  assert.throws(
    () => validateWorkDirectory(directory),
    /multiple|duplicate|predecessor|supersess/i,
  );
});

test('Work validation rejects cyclic Decision Record supersession', t => {
  const repositoryRoot = createScratchDirectory(t, 'work-lineage-supersession-cycle');
  createWorkRoot({ repositoryRoot, workId, canonicalSpec: approvedSpec() });
  const directory = path.join(repositoryRoot, 'docs', 'work', workId);
  const first = writeDecisionRecord({ repositoryRoot, record: acceptedDecision() });
  const second = writeDecisionRecord({
    repositoryRoot,
    record: acceptedDecision({ id: 'DR-002-cycle', title: 'Cycle successor', supersedes: first.id }),
  });
  fs.writeFileSync(
    first.path,
    fs.readFileSync(first.path, 'utf8').replace('- **Supersedes:** none', `- **Supersedes:** \`${second.id}\``),
  );
  const workFile = path.join(directory, 'work.json');
  const work = JSON.parse(fs.readFileSync(workFile, 'utf8'));
  work.decision_supersessions.push({ predecessor: second.id, successor: first.id });
  fs.writeFileSync(workFile, `${JSON.stringify(work, null, 2)}\n`);

  assert.throws(() => validateWorkDirectory(directory), /cycle|cyclic/i);
});
