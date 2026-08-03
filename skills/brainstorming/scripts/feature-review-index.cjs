const crypto = require('node:crypto');
const path = require('node:path');

const WORK_ID = /^work-[0-9]{8}-[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const STABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const ACCEPTANCE_CRITERION = /^AC-[1-9][0-9]*$/u;
const DECISION_RECORD = /^DR-[0-9]{3}-[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
}

function exactKeys(value, allowed, label) {
  const unknown = Object.keys(value).find(key => !allowed.includes(key));
  if (unknown) throw new TypeError(`unsupported field ${label}.${unknown}`);
}

function text(value, label, maximum = 2_000) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) throw new TypeError(`${label} is required without surrounding whitespace`);
  if (value.length > maximum) throw new RangeError(`${label} exceeds ${maximum} characters`);
  return value;
}

function identifier(value, label, pattern) {
  const result = text(value, label, 500);
  if (!pattern.test(result)) throw new TypeError(`${label} has an invalid identifier`);
  return result;
}

function list(value, label, options = {}) {
  if (!Array.isArray(value) || value.length < (options.minimum || 0)) throw new TypeError(`${label} is too short`);
  const result = value.map((item, index) => {
    const candidate = text(item, `${label}[${index}]`, options.maximum || 2_000);
    if (options.pattern && !options.pattern.test(candidate)) throw new TypeError(`${label}[${index}] has an invalid identifier`);
    return candidate;
  });
  if (new Set(result).size !== result.length) throw new TypeError(`${label} contains duplicates`);
  return result.sort();
}

function repositoryPath(value, label) {
  const candidate = text(value, label);
  const normalized = path.posix.normalize(candidate);
  if (candidate.includes('\\') || path.posix.isAbsolute(candidate) || normalized === '.' || normalized !== candidate || normalized.startsWith('../')) {
    throw new TypeError(`${label} must stay inside the repository`);
  }
  return normalized;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

function canonicalBytes(value) {
  return `${JSON.stringify(canonical(value))}\n`;
}

function digest(value) {
  return crypto.createHash('sha256').update(canonicalBytes(value)).digest('hex');
}

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freeze(child);
  return value;
}

function attribution(value, label) {
  object(value, label);
  exactKeys(value, ['kind', 'review_slice_ids'], label);
  if (value.kind === 'unmapped') {
    if (value.review_slice_ids !== undefined) throw new TypeError(`${label}.review_slice_ids is not allowed`);
    return { kind: 'unmapped' };
  }
  if (!['review_slice', 'cross_slice'].includes(value.kind)) throw new TypeError(`${label}.kind is invalid`);
  const reviewSliceIds = list(value.review_slice_ids, `${label}.review_slice_ids`, { minimum: value.kind === 'cross_slice' ? 2 : 1, pattern: STABLE_ID });
  if (value.kind === 'review_slice' && reviewSliceIds.length !== 1) throw new TypeError(`${label} requires cross_slice attribution`);
  return { kind: value.kind, review_slice_ids: reviewSliceIds };
}

function patchFile(value, index) {
  const label = `files[${index}]`;
  object(value, label);
  exactKeys(value, ['path', 'patch_digest', 'acceptance_criteria', 'attribution'], label);
  const normalizedAttribution = attribution(value.attribution, `${label}.attribution`);
  return {
    path: repositoryPath(value.path, `${label}.path`),
    patch_digest: text(value.patch_digest, `${label}.patch_digest`),
    acceptance_criteria: list(value.acceptance_criteria, `${label}.acceptance_criteria`, {
      minimum: normalizedAttribution.kind === 'unmapped' ? 0 : 1,
      pattern: ACCEPTANCE_CRITERION,
    }),
    attribution: normalizedAttribution,
  };
}

function normalizePatchSet(value, checkIdentity = false) {
  object(value, 'patch set');
  exactKeys(value, ['schema', 'patch_set_id', 'attempt_id', 'work_id', 'spec_digest', 'plan_digest', 'plan_state_digest', 'decision_record_ids', 'base_tree', 'head_tree', 'files'], 'patch set');
  const files = (value.files || []).map(patchFile).sort((left, right) => left.path.localeCompare(right.path));
  if (new Set(files.map(file => file.path)).size !== files.length) throw new TypeError('patch set contains duplicate file paths');
  const normalized = {
    schema: 1,
    attempt_id: identifier(value.attempt_id, 'attempt_id', STABLE_ID),
    work_id: identifier(value.work_id, 'work_id', WORK_ID),
    ...(value.spec_digest == null ? {} : { spec_digest: text(value.spec_digest, 'spec_digest') }),
    plan_digest: text(value.plan_digest, 'plan_digest'),
    ...(value.plan_state_digest == null ? {} : { plan_state_digest: identifier(value.plan_state_digest, 'plan_state_digest', SHA256) }),
    ...(value.decision_record_ids == null ? {} : { decision_record_ids: list(value.decision_record_ids, 'decision_record_ids', { pattern: DECISION_RECORD }) }),
    base_tree: text(value.base_tree, 'base_tree'),
    head_tree: text(value.head_tree, 'head_tree'),
    files,
  };
  const patchSetId = digest(normalized);
  if (checkIdentity && value.patch_set_id !== patchSetId) throw new TypeError('patch set ID does not match its immutable content');
  return { ...normalized, patch_set_id: patchSetId };
}

function buildPatchSet(value) {
  return freeze(normalizePatchSet(value));
}

function createPatchSetReview(value) {
  const patchSet = normalizePatchSet(value, true);
  const files = Object.fromEntries(patchSet.files.map(file => [file.path, {
    patch_digest: file.patch_digest,
    acceptance_criteria: [...file.acceptance_criteria],
    viewed: false,
    viewed_patch_set_id: null,
  }]));
  return freeze({
    schema: 1,
    patch_set_id: patchSet.patch_set_id,
    attempt_id: patchSet.attempt_id,
    work_id: patchSet.work_id,
    base_tree: patchSet.base_tree,
    head_tree: patchSet.head_tree,
    files,
    acceptance_evidence: {},
    whole_feature_verdict: null,
    viewed_progress: { viewed: 0, total: Object.keys(files).length },
    can_approve: false,
  });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertReview(value) {
  object(value, 'patch set review');
  exactKeys(value, ['schema', 'patch_set_id', 'attempt_id', 'work_id', 'base_tree', 'head_tree', 'files', 'acceptance_evidence', 'whole_feature_verdict', 'viewed_progress', 'can_approve'], 'patch set review');
  if (value.schema !== 1) throw new TypeError('patch set review.schema must be 1');
  identifier(value.patch_set_id, 'review.patch_set_id', SHA256);
  object(value.files, 'review.files');
  object(value.acceptance_evidence, 'review.acceptance_evidence');
}

function acceptanceCriteria(patchSet) {
  return [...new Set(patchSet.files.flatMap(file => file.acceptance_criteria))].sort();
}

function finalize(review) {
  const states = Object.values(review.files);
  review.viewed_progress = { viewed: states.filter(file => file.viewed).length, total: states.length };
  review.can_approve = review.whole_feature_verdict?.verdict === 'approved';
  return freeze(review);
}

function currentPatchSet(review, event) {
  if (event.patch_set_id !== review.patch_set_id) throw new TypeError('review event belongs to a different patch set');
}

function changedCriteria(previous, nextPatchSet) {
  const nextByPath = new Map(nextPatchSet.files.map(file => [file.path, file]));
  const changed = new Set();
  for (const [filePath, file] of Object.entries(previous.files)) {
    const next = nextByPath.get(filePath);
    if (!next || next.patch_digest !== file.patch_digest) {
      for (const criterion of file.acceptance_criteria) changed.add(criterion);
      for (const criterion of next?.acceptance_criteria || []) changed.add(criterion);
    }
  }
  for (const file of nextPatchSet.files) {
    if (!previous.files[file.path]) for (const criterion of file.acceptance_criteria) changed.add(criterion);
  }
  return changed;
}

function updatePatchSetReview(value, event) {
  assertReview(value);
  object(event, 'review event');
  const review = clone(value);
  if (event.type === 'file_viewed') {
    exactKeys(event, ['type', 'patch_set_id', 'path'], 'review event');
    currentPatchSet(review, event);
    const filePath = repositoryPath(event.path, 'review event.path');
    if (!review.files[filePath]) throw new TypeError(`patch set does not contain ${filePath}`);
    review.files[filePath].viewed = true;
    review.files[filePath].viewed_patch_set_id = review.patch_set_id;
    return finalize(review);
  }
  if (event.type === 'acceptance_evidence_recorded') {
    exactKeys(event, ['type', 'patch_set_id', 'acceptance_criterion_id', 'evidence_ids'], 'review event');
    currentPatchSet(review, event);
    const criterion = identifier(event.acceptance_criterion_id, 'review event.acceptance_criterion_id', ACCEPTANCE_CRITERION);
    const known = new Set(Object.values(review.files).flatMap(file => file.acceptance_criteria));
    if (!known.has(criterion)) throw new TypeError(`patch set does not cover ${criterion}`);
    review.acceptance_evidence[criterion] = {
      status: 'current',
      patch_set_id: review.patch_set_id,
      evidence_ids: list(event.evidence_ids, 'review event.evidence_ids', { minimum: 1 }),
    };
    return finalize(review);
  }
  if (event.type === 'patch_set_replaced') {
    exactKeys(event, ['type', 'patch_set'], 'review event');
    const next = normalizePatchSet(event.patch_set, true);
    if (next.work_id !== review.work_id) throw new TypeError('replacement patch set belongs to another Work ID');
    const changed = changedCriteria(review, next);
    const evidence = {};
    for (const criterion of acceptanceCriteria(next)) {
      const prior = review.acceptance_evidence[criterion];
      if (!prior) continue;
      evidence[criterion] = changed.has(criterion)
        ? { ...prior, status: 'outdated' }
        : { ...prior, status: 'current', patch_set_id: next.patch_set_id };
    }
    const priorFiles = review.files;
    const files = Object.fromEntries(next.files.map(file => {
      const prior = priorFiles[file.path];
      const unchanged = prior?.patch_digest === file.patch_digest;
      return [file.path, {
        patch_digest: file.patch_digest,
        acceptance_criteria: [...file.acceptance_criteria],
        viewed: Boolean(unchanged && prior.viewed),
        viewed_patch_set_id: unchanged && prior.viewed ? next.patch_set_id : null,
      }];
    }));
    return finalize({
      schema: 1, patch_set_id: next.patch_set_id, attempt_id: next.attempt_id, work_id: next.work_id,
      base_tree: next.base_tree, head_tree: next.head_tree, files, acceptance_evidence: evidence,
      whole_feature_verdict: null, viewed_progress: null, can_approve: false,
    });
  }
  if (event.type === 'whole_feature_verdict_recorded') {
    exactKeys(event, ['type', 'patch_set_id', 'verdict', 'acceptance_criteria', 'evidence_ids'], 'review event');
    currentPatchSet(review, event);
    if (!['approved', 'rejected'].includes(event.verdict)) throw new TypeError('whole-feature verdict is invalid');
    const criteria = list(event.acceptance_criteria, 'review event.acceptance_criteria', { minimum: 1, pattern: ACCEPTANCE_CRITERION });
    const expected = [...new Set(Object.values(review.files).flatMap(file => file.acceptance_criteria))].sort();
    if (JSON.stringify(criteria) !== JSON.stringify(expected)) throw new TypeError('whole-feature verdict must cover every Acceptance Criteria ID');
    review.whole_feature_verdict = {
      verdict: event.verdict,
      patch_set_id: review.patch_set_id,
      acceptance_criteria: criteria,
      evidence_ids: list(event.evidence_ids, 'review event.evidence_ids', { minimum: 1 }),
    };
    return finalize(review);
  }
  throw new TypeError(`unsupported review event ${String(event.type)}`);
}

module.exports = { buildPatchSet, createPatchSetReview, updatePatchSetReview };
