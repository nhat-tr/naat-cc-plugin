const { appendPairEvent, loadPairState } = require('./pair-state');
const { claimEngineWork, engineWorkId } = require('./pair-authority');

// Ownership transfer follows whichever store holds the Work. The Evidence-at-Commit engine records
// the claim in its locator (see claimEngineWork); the retired reducer records it as a
// continuation.claimed event. Routing every transfer through the reducer wrote a phantom
// .pair/runs/ store into engine repositories and left the real Work unclaimed.
function takeoverWork(root, sessionId, runtime = null, options = {}) {
  const engineWork = engineWorkId(root);
  if (engineWork) {
    if (options.expectedWorkId !== undefined && engineWork !== options.expectedWorkId) {
      throw new Error(`Pair Work ${options.expectedWorkId} is no longer active`);
    }
    return claimEngineWork(root, engineWork, sessionId, runtime);
  }
  const state = loadPairState(root);
  if (options.expectedWorkId !== undefined && state.work_id !== options.expectedWorkId) {
    throw new Error(`Pair Work ${options.expectedWorkId} is no longer active`);
  }
  if (state.in_flight_request) throw new Error('Pair continuation cannot transfer while a request is in flight');
  appendPairEvent(root, {
    event: 'continuation.claimed',
    workId: state.work_id,
    session_id: sessionId,
    runtime,
  });
  return loadPairState(root);
}

module.exports = { takeoverWork };
