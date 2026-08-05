const fs = require('node:fs');
const path = require('node:path');

const { pairStatePaths } = require('./pair-state');
const store = require('./pair-store');

// Pair Work state has lived in two stores, and Agent Conversation Handover authority has to read
// whichever one the repository actually has.
//
//   Evidence-at-Commit engine (lib/pair-engine.js via lib/pair-store.js)
//     <git-common-dir>/pair/works/<id>/state.json, located by <git-dir>/pair-current.json
//   retired attempt-ledger reducer (lib/pair-state.js)
//     .pair/runs/<id>/state.json, located by .pair/current-run.json
//
// Reading only the reducer made every live Pair repository look like a repository with no Pair Work
// at all: the conversation kind fell back to `general`, the handover manifest sealed `pair_work` as
// null, and the checkpoint's next action degraded from the engine's own `next_action` to whatever
// prose the transcript recovery had scraped. This module is the single seam that answers "which
// store owns the current Work", so no caller has to guess.

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Every store accessor shells out to git for the common directory, so a non-repository root (which
// the reducer never needed) throws rather than reporting absence. Absence is the answer here.
function engineWork(root) {
  try {
    const workId = store.readCurrentWork(root)?.work_id || null;
    if (!workId) return null;
    const paths = store.workPaths(root, workId);
    const state = readJson(paths.state);
    if (!state || state.work_id !== workId) return null;
    return { workId, state, paths };
  } catch {
    return null;
  }
}

function engineWorkId(root) {
  try {
    return store.readCurrentWork(root)?.work_id || null;
  } catch {
    return null;
  }
}

function legacyWorkId(root) {
  return readJson(path.join(root, '.pair', 'current-run.json'))?.work_id || null;
}

// Presence only — deliberately not loadPairState, which rebuilds and writes a reducer projection as
// a side effect and would plant an empty .pair/state.json in every engine-store repository.
function livePairWorkId(root) {
  return engineWorkId(root) || legacyWorkId(root);
}

function pairProjectionPath(root, workId) {
  const engine = workId !== null && engineWorkId(root) === workId ? engineWork(root) : null;
  const absolute = engine ? engine.paths.state : pairStatePaths(root, workId).state;
  return path.relative(root, absolute).split(path.sep).join('/');
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// The engine has no in_flight_request field: a mutation is guarded by a short lock and a
// verification by a lease that outlives it by up to an hour. The lease is the one that matters for
// adoption — taking a Work over while its suite is running hands the fresh conversation a Review
// Slice whose verdict is still being written.
function engineVerificationOwner(root, workId) {
  const work = engineWork(root);
  if (!work || work.workId !== workId) return null;
  const owner = readJson(path.join(work.paths.verificationLease, 'owner.json'));
  return owner?.pid && processAlive(owner.pid) ? owner : null;
}

// Ownership is recorded in the locator, never in state.json: a sealed handover binds
// projection_sha256, so mutating the projection during adoption would invalidate the very binding
// adoption is validating against.
function engineOwner(root, workId) {
  try {
    const locator = store.readCurrentWork(root);
    if (!locator || locator.work_id !== workId) return null;
    return locator.owner_session_id ? locator : null;
  } catch {
    return null;
  }
}

function claimEngineWork(root, workId, sessionId, runtime, now = new Date()) {
  const work = engineWork(root);
  if (!work || work.workId !== workId) throw new Error(`Pair Work ${workId} is no longer active`);
  const lease = engineVerificationOwner(root, workId);
  if (lease) {
    throw new Error(`Pair continuation cannot transfer while a verification of ${workId} is running (pid ${lease.pid})`);
  }
  const locator = store.readCurrentWork(root) || {};
  store.writeCurrentWork(root, {
    ...locator,
    schema: locator.schema || 1,
    work_id: workId,
    owner_session_id: String(sessionId),
    owner_runtime: runtime || null,
    owner_claimed_at: now.toISOString(),
  });
  return work.state;
}

module.exports = {
  claimEngineWork,
  engineOwner,
  engineVerificationOwner,
  engineWork,
  engineWorkId,
  livePairWorkId,
  pairProjectionPath,
};
