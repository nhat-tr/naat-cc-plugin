const assert = require('node:assert/strict');
const test = require('node:test');

const {
  classifyChallengeAttempt,
  planReviewPrompt,
  reviewIsClean,
  reviewIsSchemaShaped,
} = require('../scripts/pair-plan-challenge');

// D-5 / AC-4: a coordinator-resolvable cross-task ordering conflict must not be reported
// as a plan-review finding; BLOCKER/MAJOR and the empty-findings approval rule stay intact.

test('plan-challenge policy excludes coordinator-resolvable cross-task ordering conflicts while preserving BLOCKER/MAJOR and the empty-findings approval rule', () => {
  const prompt = planReviewPrompt({
    planPath: '.pair/plan.md',
    specPath: 'docs/work/example/spec.md',
    digest: 'current-digest',
  });

  // The exclusion rule itself.
  assert.match(prompt, /cross-task ordering conflict/i);
  assert.match(prompt, /coordinator can resolve.*without a plan or spec change/i);
  assert.match(prompt, /not a material plan defect/i);
  assert.match(prompt, /do not report it as a finding/i);
  assert.match(prompt, /note it in the summary at most/i);

  // The pre-existing severity taxonomy stays untouched.
  assert.match(prompt, /BLOCKER means the plan cannot be executed faithfully or cannot prove an acceptance criterion/i);
  assert.match(prompt, /MAJOR means the written plan will predictably cause substantial rework/i);

  // Approval and structured-result contract stay untouched.
  assert.match(prompt, /Approve only with an empty findings array/i);
  assert.match(prompt, /Return only the requested structured result/i);
});

test('a plan whose only defect is a coordinator-resolvable ordering conflict yields an approve verdict with an empty findings array', () => {
  const review = {
    verdict: 'approve',
    // A summary note is permitted at most; it must not become a finding.
    summary: 'Task 3 and Task 7 have a cross-task ordering note the coordinator can resolve during implementation; no material plan defect found.',
    findings: [],
  };

  assert.equal(reviewIsSchemaShaped(review), true);
  assert.equal(reviewIsClean(review), true);
  assert.equal(
    classifyChallengeAttempt({ run: { status: 0 }, review }).kind,
    'approved',
  );
});

test('a plan needing a genuine plan/spec decision still yields a BLOCKER even in the sequencing category', () => {
  const review = {
    verdict: 'fix-needed',
    summary: 'Task 2.1 has a hidden forward dependency on Task 6 that cannot be resolved without restructuring the plan.',
    findings: [{
      severity: 'BLOCKER',
      origin: 'plan',
      category: 'sequencing',
      task_id: '2.1',
      line: 44,
      title: 'Task 2.1 depends on an unwritten later task',
      detail: 'Task 2.1 consumes a contract only Task 6 produces, and no earlier task produces it.',
      failure_scenario: 'The worker cannot implement Task 2.1 before Task 6 exists, and reordering requires re-authoring the plan streams.',
      suggestion: 'Reorder the streams or restate the dependency so Task 2.1 no longer needs a later task.',
    }],
  };

  assert.equal(reviewIsSchemaShaped(review), true);
  assert.equal(reviewIsClean(review), false);
  assert.equal(
    classifyChallengeAttempt({ run: { status: 0 }, review }).kind,
    'plan-findings',
  );
});
