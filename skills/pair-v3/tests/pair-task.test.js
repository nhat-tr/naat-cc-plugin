const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { isExpectedFailingTestTask, readWorkLinkage, recoverActiveAttempt, verify } = require('../scripts/pair-task');
const { planContractDigest } = require('../scripts/lib/pair-core');
const {
  createWorkRoot,
  writeDecisionRecord,
} = require('../../brainstorming/scripts/work-lineage.cjs');

function testRepo(t) {
  const scratchRoot = process.env.CLAUDE_SCRATCH_DIR
    || path.join(os.homedir(), '.claude-scratch');
  fs.mkdirSync(path.join(scratchRoot, 'my-claude-code', 'pair-v3-tests'), { recursive: true });
  const root = fs.mkdtempSync(path.join(scratchRoot, 'my-claude-code', 'pair-v3-tests', 'repo-'));
  require('node:child_process').spawnSync('git', ['init', '-q'], { cwd: root });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('verify replays a reported passing command', t => {
  const root = testRepo(t);
  const result = verify(root, { type: 'feature', text: 'implement behavior' }, {
    tests: [{ command: 'node -e "process.exit(0)"', status: 'pass' }],
  });

  assert.equal(result.status, 'pass');
  assert.match(result.command, /replayed worker verification/);
});

test('verify rejects a claimed pass when command replay fails', t => {
  const root = testRepo(t);
  const result = verify(root, { type: 'feature', text: 'implement behavior' }, {
    tests: [{ command: 'node -e "process.exit(1)"', status: 'pass' }],
  });

  assert.equal(result.status, 'fail');
});

test('verify proves a tests-first task by replaying the expected failure', t => {
  const root = testRepo(t);
  const result = verify(root, { type: 'test', text: 'write failing tests for behavior' }, {
    tests: [{ command: 'node -e "process.exit(1)"', status: 'fail' }],
  });

  assert.equal(result.status, 'pass');
  assert.match(result.output, /expected failure reproduced/);
});

test('tests-first detection honors the explicit red phase', () => {
  assert.equal(isExpectedFailingTestTask({ type: 'test', phase: 'red', text: 'capture expected behavior' }), true);
});

test('recoverActiveAttempt classifies an interrupted attempt before retry', t => {
  const root = testRepo(t);
  const pairDir = path.join(root, '.pair');
  fs.mkdirSync(pairDir);
  const paths = {
    active: path.join(pairDir, 'active-attempt.json'),
    ledger: path.join(root, 'attempts.jsonl'),
  };
  fs.writeFileSync(paths.active, JSON.stringify({
    attemptId: '1.1-interrupted',
    taskId: '1.1',
    routeId: 'codex-default-low',
    profile: { type: 'feature', risk: 'low' },
  }));

  assert.equal(recoverActiveAttempt(paths), true);
  assert.equal(fs.existsSync(paths.active), false);
  const record = JSON.parse(fs.readFileSync(paths.ledger, 'utf8').trim());
  assert.equal(record.disposition, 'regenerated');
  assert.equal(record.action, 'retry-infrastructure');
  assert.equal(record.valid, false);
});

test('readWorkLinkage resolves the canonical Work envelope and rejects mirror tampering', t => {
  const root = testRepo(t);
  const workId = 'work-20260712-pair-linkage';
  const spec = [
    '# Pair linkage',
    '',
    `- **Work ID:** \`${workId}\``,
    '',
    '## Engineering Quality Contract',
    '',
    'Approved attempt-linkage obligations.',
    '',
  ].join('\n');
  createWorkRoot({ repositoryRoot: root, workId, canonicalSpec: spec });
  writeDecisionRecord({
    repositoryRoot: root,
    record: {
      schema: 1,
      id: 'DR-001-pair-linkage',
      status: 'accepted',
      workId,
      title: 'Pair linkage',
      originSpec: `docs/work/${workId}/spec.md`,
      acceptanceCriteria: ['AC-1'],
      context: 'Attempts need canonical Work lineage.',
      decision: 'Record the Work envelope at attempt start.',
      rationale: 'Later evidence must resolve the approved intent.',
      alternatives: ['Keep linkage only in the active prompt.'],
      consequences: ['Attempt records carry stable semantic references.'],
      evidence: [],
      changes: [],
      supersedes: null,
      supersededBy: null,
    },
  });
  const plan = '# validated plan bytes\n';
  const approvedPlanDigest = planContractDigest(plan);
  const workFile = path.join(root, 'docs', 'work', workId, 'work.json');
  const work = JSON.parse(fs.readFileSync(workFile, 'utf8'));
  work.plan = {
    path: '.pair/plan.md',
    sha256: approvedPlanDigest,
    status: 'validated',
    independent_review: 'no-blockers',
  };
  fs.writeFileSync(workFile, `${JSON.stringify(work, null, 2)}\n`);

  assert.deepEqual(readWorkLinkage(root, plan), {
    workId,
    specDigest: crypto.createHash('sha256').update(spec).digest('hex'),
    planDigest: approvedPlanDigest,
    planStateDigest: crypto.createHash('sha256').update(plan).digest('hex'),
    decisionRecordIds: ['DR-001-pair-linkage'],
  });

  assert.throws(
    () => readWorkLinkage(root, `${plan}mapping changed\n`),
    /plan.*digest|approved.*plan/i,
  );

  fs.writeFileSync(workFile, `${JSON.stringify({
    ...work,
    decision_records: [`docs/work/${workId}/decisions/DR-999-missing.md`],
  }, null, 2)}\n`);
  assert.throws(() => readWorkLinkage(root, plan), /Decision Record|missing|canonical Work/i);
  fs.writeFileSync(workFile, `${JSON.stringify(work, null, 2)}\n`);

  fs.appendFileSync(path.join(root, '.pair', 'spec.md'), 'tampered\n');
  assert.throws(() => readWorkLinkage(root, plan), /mirror bytes/i);
});
