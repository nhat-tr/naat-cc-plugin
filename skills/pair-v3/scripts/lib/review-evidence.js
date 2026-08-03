const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  appendEvent,
  assertRelativePath,
  blobAtCommit,
  git,
  readJson,
  safeSegment,
  storeJsonBlob,
  workPaths,
  writeJson,
} = require('./pair-store');

const REVIEW_OUTCOME_SCHEMA = 1;
const REVIEW_FEEDBACK_SCHEMA = 1;
const REVIEW_DISPOSITIONS = new Set(['valid', 'false-positive', 'not-worth-fixing', 'missing-context']);

function stableId(prefix, parts) {
  return `${prefix}-${crypto.createHash('sha256').update(parts.map(value => String(value ?? '')).join('\0')).digest('hex').slice(0, 24)}`;
}

function boundedText(value, label, max) {
  const text = String(value || '').replace(/\s+/gu, ' ').trim();
  if (!text || text.length > max) throw new Error(`${label} must use 1-${max} characters`);
  return text;
}

function blobLineCount(root, objectId) {
  return git(root, ['cat-file', '-p', objectId], { trim: false }).stdout.split(/\r?\n/u).length;
}

function validateFinding(root, checkpointCommit, finding, index) {
  if (!finding || typeof finding !== 'object' || Array.isArray(finding)) throw new Error(`review finding ${index + 1} must be an object`);
  if (!['BLOCKER', 'MAJOR'].includes(finding.severity)) throw new Error(`review finding ${index + 1} severity is invalid`);
  const evidence = finding.evidence;
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) throw new Error(`review finding ${index + 1} evidence is required`);
  if (evidence.commit !== checkpointCommit) throw new Error(`review finding ${index + 1} must anchor checkpoint commit ${checkpointCommit}`);
  const repositoryPath = assertRelativePath(evidence.path, `review finding ${index + 1} path`);
  if (repositoryPath.length > 240) throw new Error(`review finding ${index + 1} path exceeds 240 characters`);
  const expectedBlob = blobAtCommit(root, checkpointCommit, repositoryPath);
  if (evidence.blob !== expectedBlob) throw new Error(`review finding ${index + 1} blob does not match ${repositoryPath} at checkpoint`);
  const lineStart = Number(evidence.line_start);
  const lineEnd = Number(evidence.line_end);
  if (!Number.isInteger(lineStart) || !Number.isInteger(lineEnd) || lineStart < 1 || lineEnd < lineStart || lineEnd - lineStart > 40) {
    throw new Error(`review finding ${index + 1} line range is invalid or wider than 40 lines`);
  }
  if (lineEnd > blobLineCount(root, expectedBlob)) throw new Error(`review finding ${index + 1} line range exceeds its immutable blob`);
  return {
    severity: finding.severity,
    claim: boundedText(finding.claim, `review finding ${index + 1} claim`, 180),
    scenario: boundedText(finding.scenario, `review finding ${index + 1} scenario`, 240),
    evidence: {
      commit: checkpointCommit,
      path: repositoryPath,
      blob: expectedBlob,
      line_start: lineStart,
      line_end: lineEnd,
    },
    impact: boundedText(finding.impact, `review finding ${index + 1} impact`, 180),
    pass_condition: boundedText(finding.pass_condition, `review finding ${index + 1} pass condition`, 240),
  };
}

function validateReviewResult(root, checkpointCommit, result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Review Outcome must be one object');
  if (!['approve', 'findings'].includes(result.verdict)) throw new Error('Review Outcome verdict is invalid');
  if (!Array.isArray(result.findings) || result.findings.length > 3) throw new Error('Review Outcome findings must contain at most three items');
  if (result.verdict === 'approve' && result.findings.length !== 0) throw new Error('approved Review Outcome must contain no findings or narrative');
  if (result.verdict === 'findings' && result.findings.length === 0) throw new Error('findings Review Outcome must contain evidence');
  return {
    verdict: result.verdict,
    findings: result.findings.map((finding, index) => validateFinding(root, checkpointCommit, finding, index)),
  };
}

function recordReviewOutcome(root, input) {
  const workId = safeSegment(input.workId, 'Work ID');
  const sliceId = safeSegment(input.sliceId, 'Review Slice ID');
  const review = validateReviewResult(root, input.checkpointCommit, input.review);
  const outcomeId = stableId('review-outcome', [workId, sliceId, input.checkpointCommit, JSON.stringify(review)]);
  const findings = review.findings.map((finding, index) => ({
    ...finding,
    finding_id: stableId('review-finding', [outcomeId, index, finding.claim, finding.evidence.blob, finding.evidence.line_start]),
  }));
  const outcome = {
    schema: REVIEW_OUTCOME_SCHEMA,
    review_outcome_id: outcomeId,
    work_id: workId,
    review_slice_id: sliceId,
    base_commit: input.baseCommit,
    checkpoint_commit: input.checkpointCommit,
    verdict: review.verdict,
    findings,
    usage: input.usage || null,
    reviewer: {
      runtime: input.runtime,
      model: input.model || 'default',
      effort: input.effort || 'medium',
      fresh: true,
    },
    recorded_at: input.recordedAt || new Date().toISOString(),
  };
  const paths = workPaths(root, workId);
  fs.mkdirSync(paths.outcomes, { recursive: true, mode: 0o700 });
  const file = path.join(paths.outcomes, `${outcomeId}.json`);
  const existing = readJson(file);
  if (existing && JSON.stringify(existing) !== JSON.stringify(outcome)) throw new Error(`immutable Review Outcome ${outcomeId} conflicts`);
  if (!existing) writeJson(file, outcome, 8 * 1024);
  const stored = storeJsonBlob(root, workId, `reviews/${outcomeId}`, outcome);
  appendEvent(root, workId, {
    event: 'review-recorded',
    review_slice_id: sliceId,
    review_outcome_id: outcomeId,
    verdict: outcome.verdict,
    finding_count: findings.length,
    checkpoint_commit: input.checkpointCommit,
    evidence_ref: stored.ref,
    evidence_blob: stored.objectId,
  });
  return { outcome, file, ref: stored.ref, blob: stored.objectId };
}

function listReviewOutcomes(root, workId) {
  const directory = workPaths(root, workId).outcomes;
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter(file => file.endsWith('.json')).map(file => readJson(path.join(directory, file))).filter(Boolean);
}

function findFinding(root, workId, findingId) {
  for (const outcome of listReviewOutcomes(root, workId)) {
    const finding = outcome.findings.find(item => item.finding_id === findingId);
    if (finding) return { outcome, finding };
  }
  return null;
}

function feedbackRows(root, workId) {
  const file = workPaths(root, workId).feedback;
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
}

function recordReviewFeedback(root, input) {
  const workId = safeSegment(input.workId, 'Work ID');
  const findingId = String(input.findingId || '').trim();
  const target = findFinding(root, workId, findingId);
  if (!target) throw new Error(`Review Outcome finding ${findingId} does not exist`);
  const disposition = String(input.disposition || '').trim();
  if (!REVIEW_DISPOSITIONS.has(disposition)) throw new Error('Review Feedback disposition is invalid');
  const reason = boundedText(input.reason, 'Review Feedback reason', 500);
  const feedbackId = stableId('review-feedback', [findingId, disposition, reason]);
  const feedback = {
    schema: REVIEW_FEEDBACK_SCHEMA,
    review_feedback_id: feedbackId,
    work_id: workId,
    review_outcome_id: target.outcome.review_outcome_id,
    finding_id: findingId,
    disposition,
    reason,
    recorded_at: input.recordedAt || new Date().toISOString(),
  };
  const prior = feedbackRows(root, workId).find(item => item.finding_id === findingId);
  if (prior?.review_feedback_id === feedbackId) return prior;
  if (prior) throw new Error(`Review Outcome finding ${findingId} already has Review Feedback`);
  const stored = storeJsonBlob(root, workId, `feedback/${feedbackId}`, feedback);
  const line = JSON.stringify(feedback);
  if (Buffer.byteLength(line, 'utf8') > 2048) throw new Error('Review Feedback exceeds 2048 UTF-8 bytes');
  const file = workPaths(root, workId).feedback;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, `${line}\n`, { mode: 0o600 });
  appendEvent(root, workId, {
    event: 'review-feedback-recorded',
    review_feedback_id: feedbackId,
    review_outcome_id: target.outcome.review_outcome_id,
    finding_id: findingId,
    disposition,
    evidence_ref: stored.ref,
    evidence_blob: stored.objectId,
  });
  return feedback;
}

function feedbackForFinding(root, workId, findingId) {
  return feedbackRows(root, workId).filter(item => item.finding_id === findingId);
}

module.exports = {
  REVIEW_DISPOSITIONS,
  feedbackForFinding,
  feedbackRows,
  findFinding,
  listReviewOutcomes,
  recordReviewFeedback,
  recordReviewOutcome,
  stableId,
  validateReviewResult,
};
