// A Work whose slices ask a question of a running program, and a stand-in for that program. Shared by the
// two runtime test files — observation (start it, ask it, stop it) and ownership (whose program is it) —
// because they drive the same fixture and only differ in what they assert about it.

const fs = require('node:fs');
const path = require('node:path');

const { completedSlice, greenVerification, openTestWork, providerResult } = require('./warm-work');
const { workPaths } = require('../../scripts/lib/pair-store');

const PROBE = 'curl -fsS http://localhost:5080/health';
const SECOND_PROBE = 'curl -fsS http://localhost:5080/ready';

const RUNTIME_DECLARATION = JSON.stringify({
  up: 'start-the-program',
  ready: 'ask-whether-it-is-up',
  down: 'stop-the-program',
  env: { PAIR_TEST_RUNTIME: 'declared' },
});

// The same repository, able to answer which code its program is serving.
const IDENTIFIED_DECLARATION = JSON.stringify({
  up: 'start-the-program',
  ready: 'ask-whether-it-is-up',
  down: 'stop-the-program',
  identity: 'ask-which-code-it-serves',
  env: { PAIR_TEST_RUNTIME: 'declared' },
});

const TWO_SLICE_SPEC = '# Spec\n\n## Acceptance Criteria\n\n- [ ] AC-1: value becomes two\n- [ ] AC-2: value becomes three\n';

function twoSlicesWithProbes() {
  return [
    { id: 'S1', acceptance_criteria: ['AC-1'], outcome: 'Existing value returns two.', depends_on: [], verify: 'node verify.js', probe: PROBE },
    { id: 'S2', acceptance_criteria: ['AC-2'], outcome: 'Existing value returns three.', depends_on: ['S1'], verify: 'node verify.js', probe: SECOND_PROBE },
  ];
}

// A program that is down until something starts it, and stays up once started — which is what makes "run
// `up` once" observable: a second slice that asked `ready` first would find it already answering.
// `startsServing` is what this repository's own `up` brings up, which is only distinct from `serves` when the
// program answering first belongs to somebody else and is replaced.
function fakeRuntime({ probeStatus = 0, downStatus = 0, serves = null, startsServing = serves, alreadyUp = false } = {}) {
  const calls = [];
  let up = alreadyUp;
  let serving = serves;
  function runtime(input) {
    calls.push({ phase: input.phase, command: input.command, env: input.env });
    // What the program says it is serving. Only a repository that declared an `identity` command ever asks.
    if (input.phase === 'identity') return { status: 0, duration_ms: 1, log_digest: 'i'.repeat(64), output: `serving ${serving}\n` };
    if (input.phase === 'up') {
      up = true;
      serving = startsServing;
      return { status: 0, duration_ms: 1, log_digest: 'u'.repeat(64) };
    }
    if (input.phase === 'ready') return { status: up ? 0 : 1, duration_ms: 1, log_digest: 'r'.repeat(64) };
    if (input.phase === 'down') {
      // A `down` that fails stops nothing, which is the point of the failed-teardown case.
      if (downStatus === 0) up = false;
      return { status: downStatus, duration_ms: 1, log_digest: 'd'.repeat(64) };
    }
    return { status: probeStatus, duration_ms: 1, log_digest: 'p'.repeat(64) };
  }
  return { calls, runtime, isUp: () => up };
}

function scriptedProvider(extra) {
  const calls = [];
  return {
    calls,
    dependencies: {
      runProvider(input) {
        calls.push(input);
        if (input.schema?.properties?.verdict) return providerResult({ verdict: 'approve', findings: [] }, { session_id: 'review-sess' });
        fs.writeFileSync(path.join(input.root, 'value.js'), `module.exports = ${calls.length + 1};\n`);
        return providerResult(completedSlice(), { session_id: 'impl-sess' });
      },
      verify: greenVerification,
      hydrate: () => ({ hydrated: false }),
      ...extra,
    },
  };
}

function openProbedWork(t, { prefix, workId, slices = twoSlicesWithProbes(), config = {}, declaration = RUNTIME_DECLARATION }) {
  return openTestWork(t, {
    prefix,
    workId,
    slices,
    specMarkdown: TWO_SLICE_SPEC,
    // Committed, so the declaration is present in the Pair worktree the engine runs from — a runtime
    // declaration is repository content, not Pair state.
    files: { '.pair/runtime.json': declaration },
    config: { human_in_the_loop_default: false, ...config },
  });
}

function phases(calls) {
  return calls.map(call => call.phase);
}

function ownerRecord(opened) {
  return workPaths(opened.worktree, opened.workId).runtimeOwner;
}

module.exports = {
  IDENTIFIED_DECLARATION,
  PROBE,
  RUNTIME_DECLARATION,
  SECOND_PROBE,
  TWO_SLICE_SPEC,
  fakeRuntime,
  openProbedWork,
  ownerRecord,
  phases,
  scriptedProvider,
  twoSlicesWithProbes,
};
