const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { appendPairEvent, loadPairState } = require('../scripts/lib/pair-state');
const { dispatchOpeningPhase } = require('../scripts/pair-task');
const { pauseWork, resumeWork } = require('../scripts/lib/pair-control');

function fixture(t) {
  const scratchBase = process.env.CLAUDE_SCRATCH_DIR || path.join(os.homedir(), '.claude-scratch');
  const root = fs.mkdtempSync(path.join(scratchBase, 'my-claude-code-resume-phase-'));
  childProcess.spawnSync('git', ['init', '-q'], { cwd: root });
  appendPairEvent(root, { event: 'work.opened', workId: 'work-resume-phase', phase: 'ready' });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('dispatch re-opens at the recorded resume target instead of round-tripping through ready', t => {
  const root = fixture(t);
  appendPairEvent(root, {
    event: 'work.phase.entered', workId: 'work-resume-phase', phase: 'cumulative-verification',
  });
  assert.equal(dispatchOpeningPhase(loadPairState(root)), 'cumulative-verification');
});

test('dispatch re-opens a resumed Work at the phase the pause bookmarked', t => {
  const root = fixture(t);
  appendPairEvent(root, {
    event: 'work.phase.entered', workId: 'work-resume-phase', phase: 'cumulative-verification',
  });
  pauseWork(root);
  resumeWork(root);
  assert.equal(dispatchOpeningPhase(loadPairState(root)), 'cumulative-verification');
});

test('dispatch keeps a genuinely new Work at ready', t => {
  const root = fixture(t);
  assert.equal(dispatchOpeningPhase(loadPairState(root)), 'ready');
});

test('an active attempt phase outranks the resume target', t => {
  const root = fixture(t);
  appendPairEvent(root, {
    event: 'attempt.started', workId: 'work-resume-phase', attemptId: '1.1-resume', taskId: '1.1',
    phase: 'verifying',
  });
  assert.equal(dispatchOpeningPhase(loadPairState(root)), 'verifying');
});
