const path = require('node:path');

const {
  appendEvent,
  pairCommonDirectory,
  readJson,
  safeSegment,
  storeJsonBlob,
  withWorkLock,
  writeJson,
} = require('./pair-store');
const { feedbackRows, stableId } = require('./review-evidence');

const GUIDANCE_SCHEMA = 1;
const ACTIVE_GUIDANCE_LIMIT = 16;
const GUIDANCE_STATE_LIMIT_BYTES = 32 * 1024;
const METRIC_FIELDS = [
  'precision',
  'known_defects_detected',
  'expected_defects',
  'escapes',
  'median_input_tokens_per_accepted_case',
  'total_input_tokens',
  'total_cached_input_tokens',
  'total_output_tokens',
  'total_duration_ms',
  'total_attempts',
  'total_human_rework',
];

function normalizeMetrics(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} metrics are required`);
  return Object.fromEntries(METRIC_FIELDS.map(field => {
    const metric = value[field];
    if (field === 'median_input_tokens_per_accepted_case' && metric === null) return [field, null];
    if (!Number.isFinite(metric) || metric < 0) throw new Error(`${label} ${field} is invalid`);
    if (field === 'precision' && metric > 1) throw new Error(`${label} precision is invalid`);
    return [field, metric];
  }));
}

function normalizeEvaluation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Review Guidance evaluation is required');
  if (!/^[a-f0-9]{64}$/u.test(String(value.bank_digest || ''))) throw new Error('Review Guidance evaluation bank digest is invalid');
  if (!/^[a-f0-9]{64}$/u.test(String(value.trial_digest || ''))) throw new Error('Review Guidance evaluation trial digest is invalid');
  if (!Number.isInteger(value.case_count) || value.case_count < 20 || value.case_count > 50) {
    throw new Error('Review Guidance requires a 20-50 case offline evaluation');
  }
  if (value.guidance_improved !== true) throw new Error('Review Guidance requires an improving offline evaluation');
  return {
    bank_digest: value.bank_digest,
    trial_digest: value.trial_digest,
    case_count: value.case_count,
    baseline: normalizeMetrics(value.baseline, 'baseline'),
    candidate: normalizeMetrics(value.candidate, 'candidate'),
    retained_cases_caught: value.retained_cases_caught === true,
    guidance_improved: true,
    migration_passed: value.migration_passed === true,
  };
}

function cleanRule(value) {
  const rule = String(value || '').replace(/\s+/gu, ' ').trim();
  if (!rule || rule.length > 240) throw new Error('Review Guidance rule must use 1-240 characters');
  return rule;
}

function cleanScopes(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) throw new Error('Review Guidance requires 1-8 scope tags');
  return [...new Set(value.map(item => String(item).trim()).filter(item => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(item)))];
}

function guidancePath(root) {
  return path.join(pairCommonDirectory(root), 'review-guidance.json');
}

function guidanceState(root) {
  return readJson(guidancePath(root), { schema: GUIDANCE_SCHEMA, proposals: [], active: [] });
}

function saveGuidanceState(root, state) {
  writeJson(guidancePath(root), state, GUIDANCE_STATE_LIMIT_BYTES);
  return state;
}

function proposeReviewGuidance(root, input) {
  const workId = safeSegment(input.workId, 'Work ID');
  const evaluation = normalizeEvaluation(input.evaluation);
  const sourceIds = [...new Set(input.sourceFeedbackIds || [])];
  if (sourceIds.length === 0 || sourceIds.length > 12) throw new Error('Review Guidance requires 1-12 source Review Feedback IDs');
  const existingFeedback = new Map(feedbackRows(root, workId).map(item => [item.review_feedback_id, item]));
  for (const id of sourceIds) {
    const row = existingFeedback.get(id);
    if (!row) throw new Error(`Review Feedback ${id} does not exist`);
    // A rule the whole repository will be reviewed against has to come from human judgement. An autonomous
    // slice's own verdict on its own reviewer is not that, however well it read: it would let the bank learn
    // a model's opinion of a model and call it measured feedback.
    if (row.adjudicator === 'autonomous') {
      throw new Error(`Review Feedback ${id} was adjudicated autonomously, so it cannot source Review Guidance`);
    }
  }
  const rule = cleanRule(input.rule);
  const scopes = cleanScopes(input.scopes);
  const proposalId = stableId('review-guidance-proposal', [workId, rule, scopes.join(','), evaluation.bank_digest]);
  const proposal = {
    schema: GUIDANCE_SCHEMA,
    proposal_id: proposalId,
    work_id: workId,
    rule,
    scopes,
    source_feedback_ids: sourceIds,
    evaluation,
    status: 'proposed',
    proposed_at: new Date().toISOString(),
  };
  const stored = storeJsonBlob(root, 'repository-guidance', `proposals/${proposalId}`, proposal);
  const result = withWorkLock(root, 'repository-guidance', () => {
    const state = guidanceState(root);
    const existing = state.proposals.find(item => item.proposal_id === proposalId);
    if (existing) return existing;
    state.proposals.push({ ...proposal, evidence_ref: stored.ref, evidence_blob: stored.objectId });
    saveGuidanceState(root, state);
    return proposal;
  });
  appendEvent(root, workId, { event: 'review-guidance-proposed', proposal_id: proposalId, evidence_ref: stored.ref, evidence_blob: stored.objectId });
  return result;
}

function decideReviewGuidance(root, input) {
  const workId = safeSegment(input.workId, 'Work ID');
  if (!['approve', 'reject'].includes(input.decision)) throw new Error('Review Guidance decision must be approve or reject');
  const reason = String(input.reason || '').replace(/\s+/gu, ' ').trim();
  if (!reason || reason.length > 500) throw new Error('Review Guidance decision reason must use 1-500 characters');
  const result = withWorkLock(root, 'repository-guidance', () => {
    const state = guidanceState(root);
    const proposal = state.proposals.find(item => item.proposal_id === input.proposalId);
    if (!proposal) throw new Error(`Review Guidance proposal ${input.proposalId} does not exist`);
    if (proposal.status !== 'proposed') throw new Error(`Review Guidance proposal ${input.proposalId} is already decided`);
    proposal.status = input.decision === 'approve' ? 'active' : 'rejected';
    proposal.decision_reason = reason;
    proposal.decided_at = new Date().toISOString();
    const decided = { ...proposal };
    state.proposals = state.proposals.filter(item => item.proposal_id !== proposal.proposal_id);
    if (input.decision === 'approve') {
      state.proposals.push({
        proposal_id: proposal.proposal_id,
        work_id: proposal.work_id,
        rule: proposal.rule,
        scopes: proposal.scopes,
        status: 'active',
        proposed_at: proposal.proposed_at,
        decided_at: proposal.decided_at,
        evidence_ref: proposal.evidence_ref,
        evidence_blob: proposal.evidence_blob,
      });
      state.active = [...state.active.filter(id => id !== proposal.proposal_id), proposal.proposal_id];
      while (state.active.length > ACTIVE_GUIDANCE_LIMIT) {
        const retired = state.active.shift();
        state.proposals = state.proposals.filter(item => item.proposal_id !== retired);
      }
    }
    saveGuidanceState(root, state);
    return decided;
  });
  const decision = { proposal_id: result.proposal_id, decision: input.decision, reason, at: result.decided_at };
  const stored = storeJsonBlob(root, 'repository-guidance', `decisions/${result.proposal_id}`, decision);
  appendEvent(root, workId, { event: 'review-guidance-decided', proposal_id: result.proposal_id, decision: input.decision, evidence_ref: stored.ref, evidence_blob: stored.objectId });
  return result;
}

function activeReviewGuidance(root, _workId, scopeTags) {
  const scopes = new Set(scopeTags || []);
  const state = guidanceState(root);
  return state.proposals
    .filter(item => item.status === 'active' && state.active.includes(item.proposal_id))
    .filter(item => item.scopes.some(scope => scopes.has(scope) || scope === 'all'))
    .slice(-3)
    .map(item => ({ guidance_id: item.proposal_id, rule: item.rule, scopes: item.scopes }));
}

module.exports = {
  ACTIVE_GUIDANCE_LIMIT,
  GUIDANCE_STATE_LIMIT_BYTES,
  activeReviewGuidance,
  decideReviewGuidance,
  guidanceState,
  proposeReviewGuidance,
};
