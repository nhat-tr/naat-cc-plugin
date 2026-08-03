const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { blobAtCommit, pairCommonDirectory } = require('../scripts/lib/pair-store');
const { evaluationSummary } = require('../scripts/pair-cli');
const { recordReviewFeedback, recordReviewOutcome } = require('../scripts/lib/review-evidence');
const { EVALUATION_BANK_LIMIT_BYTES, evaluateBank } = require('../scripts/lib/review-evaluation');
const {
  ACTIVE_GUIDANCE_LIMIT,
  GUIDANCE_STATE_LIMIT_BYTES,
  activeReviewGuidance,
  decideReviewGuidance,
  guidanceState,
  proposeReviewGuidance,
} = require('../scripts/lib/review-guidance');

function repository(t) {
  const scratch = process.env.CLAUDE_SCRATCH_DIR || path.join(os.homedir(), '.claude-scratch');
  const parent = path.join(scratch, 'my-claude-code', 'pair-vnext-tests');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'review-'));
  childProcess.execFileSync('git', ['init', '-q'], { cwd: root });
  childProcess.execFileSync('git', ['config', 'user.email', 'pair@test'], { cwd: root });
  childProcess.execFileSync('git', ['config', 'user.name', 'Pair Test'], { cwd: root });
  fs.writeFileSync(path.join(root, 'code.js'), 'export function divide(a, b) {\n  return a / b;\n}\n');
  childProcess.execFileSync('git', ['add', '.'], { cwd: root });
  childProcess.execFileSync('git', ['commit', '-qm', 'checkpoint'], { cwd: root });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function evaluationBank() {
  return {
    schema: 1,
    cases: Array.from({ length: 20 }, (_value, index) => ({
      id: `case-${index + 1}`,
      category: index < 5 ? 'retained-blocker' : index < 10 ? 'manual-escape' : 'false-positive',
      expected: index < 10 ? 'block' : 'approve',
      baseline_command: ['baseline', String(index)],
      candidate_command: ['candidate', String(index)],
    })),
  };
}

function evaluated() {
  return evaluateBank(evaluationBank(), {
    execute(command, context) {
      const expected = context.case.expected;
      const candidate = context.strategy === 'candidate';
      return {
        verdict: candidate ? expected : 'block',
        accepted: true,
        input_tokens: candidate ? 400 : 1000,
        cached_input_tokens: 0,
        output_tokens: 20,
        duration_ms: 10,
        attempts: 1,
        human_rework: candidate ? 0 : 1,
      };
    },
  });
}

test('Review Outcome uses immutable commit/blob evidence and human feedback gates repair', t => {
  const root = repository(t);
  const commit = childProcess.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const blob = blobAtCommit(root, commit, 'code.js');
  const recorded = recordReviewOutcome(root, {
    workId: 'work-review',
    sliceId: 'S1',
    baseCommit: commit,
    checkpointCommit: commit,
    runtime: 'codex',
    review: {
      verdict: 'findings',
      findings: [{
        severity: 'MAJOR',
        claim: 'Division by zero is accepted.',
        scenario: 'Caller passes zero and receives Infinity where contract requires rejection.',
        evidence: { commit, path: 'code.js', blob, line_start: 1, line_end: 2 },
        impact: 'Invalid result crosses public boundary.',
        pass_condition: 'Zero divisor returns the contract error.',
      }],
    },
  });
  const finding = recorded.outcome.findings[0];
  assert.match(recorded.ref, /^refs\/pair\/work-review\/reviews\//);
  assert.ok(fs.statSync(recorded.file).size < 8 * 1024);
  const feedback = recordReviewFeedback(root, {
    workId: 'work-review',
    findingId: finding.finding_id,
    disposition: 'valid',
    reason: 'Production contract rejects division by zero.',
  });
  assert.equal(feedback.disposition, 'valid');
  assert.throws(() => recordReviewFeedback(root, {
    workId: 'work-review', findingId: finding.finding_id, disposition: 'false-positive', reason: 'Conflicting second disposition.',
  }), /already has Review Feedback/);
  assert.throws(() => recordReviewOutcome(root, {
    workId: 'work-review', sliceId: 'S2', baseCommit: commit, checkpointCommit: commit, runtime: 'codex',
    review: { verdict: 'findings', findings: Array.from({ length: 4 }, () => recorded.outcome.findings[0]) },
  }), /at most three/);
});

test('maximum Review Outcome remains below its 8 KiB durable boundary', t => {
  const root = repository(t);
  const commit = childProcess.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const blob = blobAtCommit(root, commit, 'code.js');
  const recorded = recordReviewOutcome(root, {
    workId: 'work-max-review',
    sliceId: 'S1',
    baseCommit: commit,
    checkpointCommit: commit,
    runtime: 'codex',
    review: {
      verdict: 'findings',
      findings: Array.from({ length: 3 }, (_value, index) => ({
        severity: 'MAJOR',
        claim: `${index}`.padEnd(180, 'c'),
        scenario: `${index}`.padEnd(240, 's'),
        evidence: { commit, path: 'code.js', blob, line_start: 1, line_end: 2 },
        impact: `${index}`.padEnd(180, 'i'),
        pass_condition: `${index}`.padEnd(240, 'p'),
      })),
    },
  });
  assert.ok(fs.statSync(recorded.file).size < 8 * 1024);
});

test('maximum Review Evaluation persists and prints bounded summaries', () => {
  const bank = {
    schema: 1,
    cases: Array.from({ length: 50 }, (_value, index) => ({
      id: `case-${index}-${'x'.repeat(70)}`.slice(0, 80),
      category: index % 2 ? 'false-positive' : 'retained-blocker',
      expected: index % 2 ? 'approve' : 'block',
      baseline_command: ['baseline'],
      candidate_command: ['candidate'],
    })),
  };
  const evaluation = evaluateBank(bank, {
    execute(_command, context) {
      return {
        verdict: context.strategy === 'baseline' ? context.case.expected : (context.case.expected === 'block' ? 'approve' : 'block'),
        accepted: context.strategy === 'baseline',
        input_tokens: 1,
        cached_input_tokens: 0,
        output_tokens: 1,
        duration_ms: 1,
        attempts: 1,
        human_rework: 0,
      };
    },
  });
  assert.ok(Buffer.byteLength(JSON.stringify(evaluation), 'utf8') < 16 * 1024);
  assert.equal(evaluation.failed_case_ids.length, 50);
  const summary = evaluationSummary(evaluation, '/bounded/result.json');
  assert.equal(summary.failed_case_count, 50);
  assert.equal(summary.failed_case_ids, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(summary), 'utf8') < 1024);
  assert.throws(() => evaluateBank({
    schema: 1,
    cases: bank.cases.map(item => ({ ...item, baseline_command: ['baseline', 'x'.repeat(240), 'x'.repeat(240), 'x'.repeat(240), 'x'.repeat(240), 'x'.repeat(240), 'x'.repeat(240), 'x'.repeat(240)] })),
  }), new RegExp(`exceeds ${EVALUATION_BANK_LIMIT_BYTES}`));
});

test('Review Guidance activates only after offline improvement and explicit approval', t => {
  const root = repository(t);
  const commit = childProcess.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const blob = blobAtCommit(root, commit, 'code.js');
  const outcome = recordReviewOutcome(root, {
    workId: 'work-guidance', sliceId: 'S1', baseCommit: commit, checkpointCommit: commit, runtime: 'codex',
    review: { verdict: 'findings', findings: [{ severity: 'MAJOR', claim: 'Contract failure.', scenario: 'Reachable contract case.', evidence: { commit, path: 'code.js', blob, line_start: 1, line_end: 2 }, impact: 'Wrong output.', pass_condition: 'Contract case passes.' }] },
  }).outcome;
  const feedback = recordReviewFeedback(root, { workId: 'work-guidance', findingId: outcome.findings[0].finding_id, disposition: 'valid', reason: 'Confirmed manually.' });
  const evaluation = evaluated();
  assert.equal(evaluation.case_count, 20);
  assert.equal(evaluation.guidance_improved, true);
  assert.equal(evaluation.migration_passed, true);
  assert.equal(evaluation.cases, undefined);
  assert.deepEqual(evaluation.failed_case_ids, []);
  assert.ok(Buffer.byteLength(JSON.stringify(evaluation), 'utf8') < 16 * 1024);
  const proposal = proposeReviewGuidance(root, {
    workId: 'work-guidance',
    sourceFeedbackIds: [feedback.review_feedback_id],
    rule: 'Block only when changed contract has a reachable failing caller.',
    scopes: ['public-contract'],
    evaluation: { ...evaluation, baseline: { ...evaluation.baseline, unbounded_detail: 'x'.repeat(100_000) } },
  });
  assert.ok(Buffer.byteLength(JSON.stringify(proposal), 'utf8') < 4 * 1024);
  assert.equal(proposal.evaluation.baseline.unbounded_detail, undefined);
  assert.deepEqual(activeReviewGuidance(root, 'work-guidance', ['public-contract']), []);
  decideReviewGuidance(root, { workId: 'work-guidance', proposalId: proposal.proposal_id, decision: 'approve', reason: 'Evaluation improves precision and token use.' });
  assert.equal(activeReviewGuidance(root, 'work-guidance', ['public-contract']).length, 1);
  assert.equal(activeReviewGuidance(root, 'work-future-session', ['public-contract']).length, 1, 'repository guidance must reach future Work sessions');
  assert.equal(activeReviewGuidance(root, 'work-guidance', ['routine']).length, 0);
});

test('Review Guidance rolls over at sixteen active rules below 32 KiB', t => {
  const root = repository(t);
  const workId = 'w'.repeat(80);
  const commit = childProcess.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const blob = blobAtCommit(root, commit, 'code.js');
  const evaluation = evaluated();
  for (let index = 0; index <= ACTIVE_GUIDANCE_LIMIT; index++) {
    const outcome = recordReviewOutcome(root, {
      workId,
      sliceId: `S${index}`,
      baseCommit: commit,
      checkpointCommit: commit,
      runtime: 'codex',
      review: {
        verdict: 'findings',
        findings: [{
          severity: 'MAJOR',
          claim: `Reachable contract failure ${index}.`,
          scenario: 'One current caller reaches the changed contract.',
          evidence: { commit, path: 'code.js', blob, line_start: 1, line_end: 2 },
          impact: 'The caller receives an invalid result.',
          pass_condition: 'The reachable contract case passes.',
        }],
      },
    }).outcome;
    const feedback = recordReviewFeedback(root, {
      workId,
      findingId: outcome.findings[0].finding_id,
      disposition: 'valid',
      reason: 'Confirmed against the committed caller.',
    });
    const proposal = proposeReviewGuidance(root, {
      workId,
      sourceFeedbackIds: [feedback.review_feedback_id],
      rule: `${index}`.padEnd(240, 'r'),
      scopes: Array.from({ length: 8 }, (_value, scope) => `${scope}-${'s'.repeat(60)}`),
      evaluation,
    });
    decideReviewGuidance(root, {
      workId,
      proposalId: proposal.proposal_id,
      decision: 'approve',
      reason: 'Measured evaluation improves review precision.',
    });
  }
  const guidance = guidanceState(root);
  assert.equal(guidance.active.length, ACTIVE_GUIDANCE_LIMIT);
  assert.equal(guidance.proposals.length, ACTIVE_GUIDANCE_LIMIT);
  const file = path.join(pairCommonDirectory(root), 'review-guidance.json');
  assert.ok(fs.statSync(file).size < GUIDANCE_STATE_LIMIT_BYTES);
});
