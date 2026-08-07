// Whose program is answering. The runtime binds fixed host ports, so anything up answers green — and only
// the `identity` question can tell this Work's program apart from another Work's, or from the human's own
// stack. What the answer buys is the right to refuse.
//
// AC-3: when `identity` is declared and its output does not match, the runtime is not probed; a claim held
//       by another Work is torn down first, and with no such claim the run refuses.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { advanceWork } = require('../scripts/lib/pair-engine');
const { readEvents, readState, workPaths } = require('../scripts/lib/pair-store');
const {
  IDENTIFIED_DECLARATION,
  fakeRuntime,
  openProbedWork,
  phases,
  scriptedProvider,
} = require('./helpers/runtime-work');

// AC-3: green, serving another Work's worktree, and claimed by that Work — so the loop started it and still
// owes it a `down`. Stopping it is that teardown, and it frees the fixed host ports this Work's own instance
// needs. Nothing is asked of the stranger on the way past.
test('a program serving another Work is stopped before this Work starts its own', t => {
  const opened = openProbedWork(t, {
    prefix: 'probestranger',
    workId: 'work-probe-stranger',
    declaration: IDENTIFIED_DECLARATION,
  });
  // Up before this run begins and serving the other Work, so only this repository's own `up` can make the
  // program answer for this worktree.
  const runtime = fakeRuntime({
    alreadyUp: true,
    serves: 'work-probe-elsewhere',
    startsServing: path.basename(opened.worktree),
  });
  const { dependencies } = scriptedProvider({ runtime: runtime.runtime });
  // Parked, not abandoned: reclamation leaves a `null` pid alone by design, so this is the claim only the
  // identity answer can expose.
  const stranger = workPaths(opened.worktree, 'work-probe-elsewhere').runtimeOwner;
  fs.mkdirSync(path.dirname(stranger), { recursive: true });
  fs.writeFileSync(stranger, JSON.stringify({
    pid: null,
    work_id: 'work-probe-elsewhere',
    worktree: opened.worktree,
    at: new Date().toISOString(),
  }));

  const state = advanceWork(opened.worktree, { runtime: 'claude', reviewPolicy: 'all' }, dependencies);

  assert.equal(state.lifecycle, 'complete');
  assert.deepEqual(phases(runtime.calls).slice(0, 4), ['ready', 'identity', 'down', 'up'],
    'the stranger is torn down before this Work’s own program is started, and is never probed');
  assert.equal(fs.existsSync(stranger), false, 'the other Work’s claim is settled by the teardown that honoured it');
  assert.equal(
    readEvents(opened.worktree, opened.workId).filter(event => event.event === 'runtime-foreign').length,
    1);
});

// AC-3, the other half: nobody claims what is answering, so this loop never started it — the human's own
// stack on the same fixed ports. Stopping it is not this run's to do and probing it would answer this
// slice's question against their checkout, so the run refuses and names why.
test('a program nobody claims stops the run instead of being adopted', t => {
  const opened = openProbedWork(t, {
    prefix: 'probeunowned',
    workId: 'work-probe-unowned',
    declaration: IDENTIFIED_DECLARATION,
  });
  const runtime = fakeRuntime({ serves: 'the-humans-own-checkout' });
  runtime.runtime({ phase: 'up', command: 'started-by-the-human', env: {} });
  runtime.calls.length = 0;
  const { dependencies } = scriptedProvider({ runtime: runtime.runtime });

  const state = advanceWork(opened.worktree, { runtime: 'claude', reviewPolicy: 'all' }, dependencies);

  assert.equal(state.lifecycle, 'blocked');
  assert.deepEqual(phases(runtime.calls).filter(phase => phase !== 'ready' && phase !== 'identity'), [],
    'nothing was started, nothing was stopped, and nothing was asked of a program that is not ours');
  assert.equal(runtime.isUp(), true);
  const failure = readState(opened.worktree, opened.workId).slices[0].verification_failure || '';
  assert.match(failure, /no Pair Work claims it/);
  assert.equal(failure.includes(path.basename(opened.worktree)), true, 'the refusal names the worktree the program should have been serving');
});
