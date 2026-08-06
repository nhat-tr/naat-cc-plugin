// AC-4: review prompts include the base→checkpoint unified diff when it fits the configured cap and fall
// back to current behavior otherwise; review calls remain fresh one-shots.

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { advanceWork, checkpointDiff } = require('../scripts/lib/pair-engine');
const { reviewPrompt } = require('../scripts/lib/pair-prompts');
const { greenVerification, openTestWork } = require('./helpers/warm-work');

const SLICE = { id: 'S1', outcome: 'Existing value returns two.' };
const REVIEW = {
  slice: SLICE,
  criteria: '- AC-1: value becomes two',
  baseCommit: 'aaaaaaa',
  checkpointCommit: 'bbbbbbb',
  verification: { status: 0 },
};

test('an inlined diff replaces the instruction to derive one', () => {
  const derived = reviewPrompt({ ...REVIEW, diff: null });
  assert.match(derived, /Start with git diff aaaaaaa\.\.bbbbbbb\./u,
    'over the cap the reviewer derives it, exactly as every review did before');

  const inlined = reviewPrompt({ ...REVIEW, diff: '--- a/value.js\n+++ b/value.js\n@@ -1 +1 @@\n-module.exports = 1;\n+module.exports = 2;\n' });
  assert.match(inlined, /do not re-derive it/u);
  assert.match(inlined, /\+module\.exports = 2;/u);
  assert.doesNotMatch(inlined, /Start with git diff/u, 'asking for both is asking for the tool call twice');
});

// Refusing to read an oversized diff is the point: inlining a 400 KiB diff would crowd out the code
// reading that makes the review worth having, so past the cap the reviewer derives it selectively.
test('the diff is inlined only while it fits the configured cap', t => {
  const opened = openTestWork(t, { prefix: 'diffcap', workId: 'work-diff-cap' });
  const file = path.join(opened.worktree, 'value.js');
  fs.writeFileSync(file, 'module.exports = 2;\n');
  childProcess.execFileSync('git', ['add', '-A'], { cwd: opened.worktree });
  childProcess.execFileSync('git', ['-c', 'user.email=p@t', '-c', 'user.name=P', 'commit', '-qm', 'checkpoint'], { cwd: opened.worktree });
  const base = childProcess.execFileSync('git', ['rev-parse', 'HEAD~1'], { cwd: opened.worktree, encoding: 'utf8' }).trim();
  const head = childProcess.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: opened.worktree, encoding: 'utf8' }).trim();

  const inlined = checkpointDiff(opened.worktree, base, head, 24 * 1024);
  assert.match(inlined, /-module\.exports = 1;/u);
  assert.equal(checkpointDiff(opened.worktree, base, head, 8), null, 'past the cap there is no diff to inline');
  assert.equal(checkpointDiff(opened.worktree, null, head, 24 * 1024), null, 'and none before a checkpoint exists');
});

test('a checkpoint review inlines its diff and still runs as a fresh one-shot session', t => {
  const opened = openTestWork(t, {
    prefix: 'reviewfresh',
    workId: 'work-review-fresh',
    slices: [{ id: 'S1', acceptance_criteria: ['AC-1'], outcome: 'Existing value returns two.', depends_on: [], verify: 'node verify.js' }],
  });
  const calls = [];
  const dependencies = {
    runProvider(input) {
      calls.push(input);
      if (input.mode === 'review') return { output: { verdict: 'approve', findings: [] }, usage: {}, duration_ms: 1, runtime: 'claude', model: 'm', effort: 'medium', session_id: 'review-sess' };
      fs.writeFileSync(path.join(input.root, 'value.js'), 'module.exports = 2;\n');
      return {
        output: { status: 'completed', architecture_risk: null, design_check: null, failure_proof: { boundary: 'module export', method: 'unit', negative_control: 'Returning 1 fails.' }, blocker: null },
        usage: { context_tokens: 900 }, duration_ms: 1, runtime: 'claude', model: 'm', effort: 'medium', session_id: 'impl-sess',
      };
    },
    verify: greenVerification,
    hydrate: () => ({ hydrated: false }),
  };
  // One transition per invocation: the checkpoint is created by the first run, reviewed by the next.
  advanceWork(opened.worktree, { runtime: 'claude', reviewPolicy: 'all' }, dependencies);
  advanceWork(opened.worktree, { runtime: 'claude', reviewPolicy: 'all' }, dependencies);

  const review = calls.find(call => call.mode === 'review');
  assert.ok(review, 'the review ran');
  assert.equal(review.resumeSessionId, null, 'fresh eyes are a guarantee, not a default');
  assert.equal(review.persistSession, false, 'and a review leaves nothing behind to resume');
  assert.match(review.prompt, /do not re-derive it/u);
  assert.match(review.prompt, /\+module\.exports = 2;/u, 'the coordinator already held this diff as two commit ids');
});
