const { appendPairEvent, loadPairState } = require('./pair-state');

function takeoverWork(root, sessionId, runtime = null, options = {}) {
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
