#!/usr/bin/env node

const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { parsePlan, planContractDigest, validatePlan } = require('./lib/pair-core');

const WORK_ID_PATTERN = /^work-[0-9]{8}-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ACCEPTANCE_CRITERION_PATTERN = /^AC-[1-9][0-9]*$/;
const DECISION_RECORD_PATTERN = /^DR-[0-9]{3}-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const STABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const GIT_OBJECT_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function rejectUnknown(value, allowed, label) {
  const unknown = Object.keys(value).find(key => !allowed.includes(key));
  if (unknown !== undefined) throw new TypeError(`unsupported field ${label}.${unknown}`);
}

function requiredText(value, label, maximum = 2_000) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} is required`);
  if (value !== value.trim()) throw new TypeError(`${label} must not have surrounding whitespace`);
  if (value.length > maximum) throw new RangeError(`${label} must be at most ${maximum} characters`);
  return value;
}

function patternedText(value, label, pattern) {
  const text = requiredText(value, label, 500);
  if (!pattern.test(text)) throw new TypeError(`${label} has an invalid identifier`);
  return text;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedTextList(value, label, options = {}) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  const minimum = options.minimum ?? 0;
  if (value.length < minimum) throw new TypeError(`${label} must contain at least ${minimum} item(s)`);
  const normalized = value.map((item, index) => {
    const text = requiredText(item, `${label}[${index}]`, options.maximum ?? 2_000);
    if (options.pattern && !options.pattern.test(text)) {
      throw new TypeError(`${label}[${index}] has an invalid identifier`);
    }
    return text;
  });
  if (new Set(normalized).size !== normalized.length) throw new TypeError(`${label} contains duplicate items`);
  return normalized.sort(compareText);
}

function repositoryPath(value, label) {
  const candidate = requiredText(value, label);
  if (candidate.includes('\\') || path.posix.isAbsolute(candidate)) {
    throw new TypeError(`${label} must be a repository-relative POSIX path`);
  }
  const normalized = path.posix.normalize(candidate);
  const segments = normalized.split('/');
  if (normalized === '.' || normalized !== candidate || normalized.startsWith('../')
    || segments.some(segment => ['__proto__', 'prototype', 'constructor'].includes(segment))) {
    throw new TypeError(`${label} must stay inside the repository`);
  }
  return normalized;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort(compareText)
    .map(key => [key, canonicalValue(value[key])]));
}

function canonicalBytes(value) {
  return `${JSON.stringify(canonicalValue(value))}\n`;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function changeComparator(left, right) {
  return compareText(left.path, right.path) || compareText(left.hunk_id, right.hunk_id);
}

function normalizeManifestChange(value, index, taskIds) {
  assertObject(value, `changes[${index}]`);
  rejectUnknown(value, ['path', 'hunkId', 'claimedBy'], `changes[${index}]`);
  const claimedBy = sortedTextList(value.claimedBy, `changes[${index}].claimedBy`, {
    pattern: STABLE_ID_PATTERN,
  });
  for (const taskId of claimedBy) {
    if (!taskIds.has(taskId)) throw new TypeError(`changes[${index}] claims unknown Review Slice ${taskId}`);
  }
  return {
    path: repositoryPath(value.path, `changes[${index}].path`),
    hunk_id: requiredText(value.hunkId, `changes[${index}].hunkId`),
    claimed_by: claimedBy,
  };
}

function gitBytes(repositoryRoot, args, label) {
  const result = childProcess.spawnSync('git', args, {
    cwd: repositoryRoot,
    encoding: null,
    maxBuffer: 20_000_000,
  });
  if (result.error) throw new Error(`${label} failed: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = result.stderr?.toString('utf8').trim();
    throw new Error(`${label} failed${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout;
}

function treeEntryChangeId(repositoryRoot, baseTree, headTree, filePath) {
  const entry = tree => gitBytes(repositoryRoot, [
    'ls-tree', '-z', '--full-tree', tree, '--', `:(literal)${filePath}`,
  ], `Review Slice Git tree entry for ${filePath}`);
  const baseEntry = entry(baseTree);
  const headEntry = entry(headTree);
  const identity = Buffer.concat([
    Buffer.from(`base:${baseEntry.length}\0`, 'utf8'),
    baseEntry,
    Buffer.from(`head:${headEntry.length}\0`, 'utf8'),
    headEntry,
  ]);
  return sha256(identity);
}

function deriveManifestChanges(repositoryRoot, baseTree, headTree, reviewSlices) {
  const names = gitBytes(repositoryRoot, [
    'diff-tree', '--no-commit-id', '--name-only', '-r', '-z', '--no-renames',
    baseTree, headTree, '--',
  ], 'Review Slice Git diff').toString('utf8').split('\0').filter(Boolean);
  const uniqueNames = [...new Set(names.map((name, index) => repositoryPath(
    name,
    `Git diff path[${index}]`,
  )))].sort(compareText);
  return uniqueNames.map((filePath, index) => {
    const claimedBy = reviewSlices
      .filter(slice => slice.expected_files.includes(filePath))
      .map(slice => slice.task_id)
      .sort(compareText);
    return normalizeManifestChange({
      path: filePath,
      hunkId: treeEntryChangeId(repositoryRoot, baseTree, headTree, filePath),
      claimedBy,
    }, index, new Set(reviewSlices.map(slice => slice.task_id)));
  });
}

function buildReviewSliceManifest(input) {
  assertObject(input, 'manifest input');
  rejectUnknown(input, [
    'workId', 'repositoryRoot', 'plan', 'baseTree', 'headTree', 'planDigest', 'indexerVersion',
  ], 'manifest input');
  const validation = validatePlan(requiredText(input.plan, 'plan', 5_000_000));
  if (!validation.valid) {
    throw new TypeError(`validated Pair plan is required: ${validation.errors.join('; ')}`);
  }
  const suppliedPlanDigest = patternedText(input.planDigest, 'planDigest', SHA256_PATTERN);
  if (planContractDigest(input.plan) !== suppliedPlanDigest) {
    throw new TypeError('planDigest does not match the current Pair plan contract');
  }
  const parsed = parsePlan(input.plan);
  const reviewSlices = parsed.tasks.map(task => ({
    task_id: task.id,
    stream_id: task.streamId,
    acceptance_criteria: sortedTextList(task.acceptanceCriteria, `Task ${task.id} acceptance criteria`, {
      minimum: 1,
      pattern: ACCEPTANCE_CRITERION_PATTERN,
    }),
    expected_files: task.files.map((file, index) => repositoryPath(file, `Task ${task.id} files[${index}]`))
      .sort(compareText),
    verification_command: requiredText(task.verify, `Task ${task.id} verification command`, 10_000),
    actual_changes: [],
  })).sort((left, right) => compareText(left.task_id, right.task_id));
  const baseTree = patternedText(input.baseTree, 'baseTree', GIT_OBJECT_PATTERN);
  const headTree = patternedText(input.headTree, 'headTree', GIT_OBJECT_PATTERN);
  const repositoryRoot = realDirectory(input.repositoryRoot, 'repositoryRoot');
  const changes = deriveManifestChanges(repositoryRoot, baseTree, headTree, reviewSlices)
    .sort(changeComparator);
  const changeKeys = changes.map(change => `${change.path}\0${change.hunk_id}`);
  if (new Set(changeKeys).size !== changeKeys.length) {
    throw new TypeError('changes contains duplicate path and hunk identities');
  }

  for (const slice of reviewSlices) {
    slice.actual_changes = changes.filter(change => change.claimed_by.includes(slice.task_id)).map(clone);
  }

  const manifest = normalizeReviewSliceManifest({
    schema: 1,
    work_id: patternedText(input.workId, 'workId', WORK_ID_PATTERN),
    base_tree: baseTree,
    head_tree: headTree,
    plan_digest: suppliedPlanDigest,
    indexer_version: requiredText(input.indexerVersion, 'indexerVersion'),
    review_slices: reviewSlices,
    cross_slice_changes: changes.filter(change => change.claimed_by.length > 1).map(clone),
    unmapped_changes: changes.filter(change => change.claimed_by.length === 0)
      .map(change => ({ path: change.path, hunk_id: change.hunk_id })),
  });
  const bytes = canonicalBytes(manifest);
  return deepFreeze({ manifest: deepFreeze(manifest), bytes, digest: sha256(bytes) });
}

function manifestChangeKey(change) {
  return `${change.path}\0${change.hunk_id}`;
}

function normalizeAttributedChange(value, label, minimumClaims = 1) {
  assertObject(value, label);
  rejectUnknown(value, ['path', 'hunk_id', 'claimed_by'], label);
  return {
    path: repositoryPath(value.path, `${label}.path`),
    hunk_id: patternedText(value.hunk_id, `${label}.hunk_id`, SHA256_PATTERN),
    claimed_by: sortedTextList(value.claimed_by, `${label}.claimed_by`, {
      minimum: minimumClaims,
      pattern: STABLE_ID_PATTERN,
    }),
  };
}

function normalizeUnmappedChange(value, label) {
  assertObject(value, label);
  rejectUnknown(value, ['path', 'hunk_id'], label);
  return {
    path: repositoryPath(value.path, `${label}.path`),
    hunk_id: patternedText(value.hunk_id, `${label}.hunk_id`, SHA256_PATTERN),
  };
}

function equalCanonical(left, right) {
  return canonicalBytes(left) === canonicalBytes(right);
}

function normalizeReviewSliceManifest(value) {
  assertObject(value, 'Review Slice manifest');
  rejectUnknown(value, [
    'schema', 'work_id', 'base_tree', 'head_tree', 'plan_digest', 'indexer_version',
    'review_slices', 'cross_slice_changes', 'unmapped_changes',
  ], 'Review Slice manifest');
  if (value.schema !== 1) throw new TypeError('Review Slice manifest.schema must be 1');
  if (!Array.isArray(value.review_slices)) {
    throw new TypeError('Review Slice manifest.review_slices must be an array');
  }

  const reviewSlices = value.review_slices.map((slice, index) => {
    const label = `Review Slice manifest.review_slices[${index}]`;
    assertObject(slice, label);
    rejectUnknown(slice, [
      'task_id', 'stream_id', 'acceptance_criteria', 'expected_files',
      'verification_command', 'actual_changes',
    ], label);
    if (!Array.isArray(slice.actual_changes)) throw new TypeError(`${label}.actual_changes must be an array`);
    const actualChanges = slice.actual_changes
      .map((change, changeIndex) => normalizeAttributedChange(
        change,
        `${label}.actual_changes[${changeIndex}]`,
      ))
      .sort(changeComparator);
    if (new Set(actualChanges.map(manifestChangeKey)).size !== actualChanges.length) {
      throw new TypeError(`${label}.actual_changes contains duplicate changes`);
    }
    return {
      task_id: patternedText(slice.task_id, `${label}.task_id`, STABLE_ID_PATTERN),
      stream_id: patternedText(slice.stream_id, `${label}.stream_id`, STABLE_ID_PATTERN),
      acceptance_criteria: sortedTextList(slice.acceptance_criteria, `${label}.acceptance_criteria`, {
        minimum: 1,
        pattern: ACCEPTANCE_CRITERION_PATTERN,
      }),
      expected_files: sortedTextList(slice.expected_files, `${label}.expected_files`, { minimum: 1 })
        .map((file, fileIndex) => repositoryPath(file, `${label}.expected_files[${fileIndex}]`))
        .sort(compareText),
      verification_command: requiredText(
        slice.verification_command,
        `${label}.verification_command`,
        10_000,
      ),
      actual_changes: actualChanges,
    };
  }).sort((left, right) => compareText(left.task_id, right.task_id));
  const taskIds = reviewSlices.map(slice => slice.task_id);
  if (new Set(taskIds).size !== taskIds.length) {
    throw new TypeError('Review Slice manifest contains duplicate Review Slice IDs');
  }
  const knownTaskIds = new Set(taskIds);
  const actualByKey = new Map();
  const participantsByKey = new Map();
  for (const slice of reviewSlices) {
    for (const change of slice.actual_changes) {
      if (!slice.expected_files.includes(change.path)) {
        throw new TypeError(`Review Slice manifest change ${change.path} is outside ${slice.task_id} expected files`);
      }
      if (!change.claimed_by.includes(slice.task_id)) {
        throw new TypeError(`Review Slice manifest change ${change.path} does not claim ${slice.task_id}`);
      }
      for (const claimedId of change.claimed_by) {
        if (!knownTaskIds.has(claimedId)) {
          throw new TypeError(`Review Slice manifest change ${change.path} claims unknown Review Slice ${claimedId}`);
        }
      }
      const key = manifestChangeKey(change);
      const prior = actualByKey.get(key);
      if (prior && !equalCanonical(prior, change)) {
        throw new TypeError(`Review Slice manifest change ${change.path} has inconsistent claims`);
      }
      actualByKey.set(key, change);
      if (!participantsByKey.has(key)) participantsByKey.set(key, new Set());
      participantsByKey.get(key).add(slice.task_id);
    }
  }
  for (const [key, change] of actualByKey) {
    const participants = [...participantsByKey.get(key)].sort(compareText);
    if (!equalCanonical(participants, change.claimed_by)) {
      throw new TypeError(`Review Slice manifest change ${change.path} has inconsistent actual change membership`);
    }
  }

  if (!Array.isArray(value.cross_slice_changes)) {
    throw new TypeError('Review Slice manifest.cross_slice_changes must be an array');
  }
  const crossSliceChanges = value.cross_slice_changes
    .map((change, index) => normalizeAttributedChange(
      change,
      `Review Slice manifest.cross_slice_changes[${index}]`,
      2,
    ))
    .sort(changeComparator);
  if (new Set(crossSliceChanges.map(manifestChangeKey)).size !== crossSliceChanges.length) {
    throw new TypeError('Review Slice manifest.cross_slice_changes contains duplicate changes');
  }
  for (const change of crossSliceChanges) {
    for (const claimedId of change.claimed_by) {
      if (!knownTaskIds.has(claimedId)) {
        throw new TypeError(`Review Slice manifest cross-slice change claims unknown Review Slice ${claimedId}`);
      }
    }
  }
  const expectedCrossSliceChanges = [...actualByKey.values()]
    .filter(change => change.claimed_by.length > 1)
    .sort(changeComparator);
  if (!equalCanonical(crossSliceChanges, expectedCrossSliceChanges)) {
    throw new TypeError('Review Slice manifest cross-slice changes are structurally inconsistent');
  }

  if (!Array.isArray(value.unmapped_changes)) {
    throw new TypeError('Review Slice manifest.unmapped_changes must be an array');
  }
  const unmappedChanges = value.unmapped_changes
    .map((change, index) => normalizeUnmappedChange(
      change,
      `Review Slice manifest.unmapped_changes[${index}]`,
    ))
    .sort(changeComparator);
  const unmappedKeys = unmappedChanges.map(manifestChangeKey);
  if (new Set(unmappedKeys).size !== unmappedKeys.length) {
    throw new TypeError('Review Slice manifest.unmapped_changes contains duplicate changes');
  }
  for (const change of unmappedChanges) {
    if (actualByKey.has(manifestChangeKey(change))) {
      throw new TypeError(`Review Slice manifest change ${change.path} cannot be both mapped and unmapped`);
    }
    if (reviewSlices.some(slice => slice.expected_files.includes(change.path))) {
      throw new TypeError(`Review Slice manifest expected change ${change.path} cannot be unmapped`);
    }
  }

  return {
    schema: 1,
    work_id: patternedText(value.work_id, 'Review Slice manifest.work_id', WORK_ID_PATTERN),
    base_tree: patternedText(value.base_tree, 'Review Slice manifest.base_tree', GIT_OBJECT_PATTERN),
    head_tree: patternedText(value.head_tree, 'Review Slice manifest.head_tree', GIT_OBJECT_PATTERN),
    plan_digest: patternedText(value.plan_digest, 'Review Slice manifest.plan_digest', SHA256_PATTERN),
    indexer_version: requiredText(value.indexer_version, 'Review Slice manifest.indexer_version'),
    review_slices: reviewSlices,
    cross_slice_changes: crossSliceChanges,
    unmapped_changes: unmappedChanges,
  };
}

function normalizeAttribution(value, label) {
  assertObject(value, label);
  rejectUnknown(value, ['kind', 'review_slice_ids'], label);
  if (value.kind === 'unmapped') {
    if (value.review_slice_ids !== undefined) {
      throw new TypeError(`${label}.review_slice_ids is not allowed for unmapped attribution`);
    }
    return { kind: 'unmapped' };
  }
  if (!['review_slice', 'cross_slice'].includes(value.kind)) {
    throw new TypeError(`${label}.kind must be review_slice, cross_slice, or unmapped`);
  }
  const minimum = value.kind === 'cross_slice' ? 2 : 1;
  const reviewSliceIds = sortedTextList(value.review_slice_ids, `${label}.review_slice_ids`, {
    minimum,
    pattern: STABLE_ID_PATTERN,
  });
  if (value.kind === 'review_slice' && reviewSliceIds.length !== 1) {
    throw new TypeError(`${label} must use cross_slice attribution for multiple Review Slice IDs`);
  }
  return { kind: value.kind, review_slice_ids: reviewSliceIds };
}

function normalizePatchFile(value, index) {
  const label = `files[${index}]`;
  assertObject(value, label);
  rejectUnknown(value, ['path', 'patch_digest', 'acceptance_criteria', 'attribution'], label);
  const attribution = normalizeAttribution(value.attribution, `${label}.attribution`);
  return {
    path: repositoryPath(value.path, `${label}.path`),
    patch_digest: requiredText(value.patch_digest, `${label}.patch_digest`),
    acceptance_criteria: sortedTextList(value.acceptance_criteria, `${label}.acceptance_criteria`, {
      minimum: attribution.kind === 'unmapped' ? 0 : 1,
      pattern: ACCEPTANCE_CRITERION_PATTERN,
    }),
    attribution,
  };
}

function normalizePatchSet(value, allowIdentity = false) {
  assertObject(value, 'patch set');
  const allowed = [
    'schema', 'patch_set_id', 'attempt_id', 'work_id', 'spec_digest', 'plan_digest',
    'plan_state_digest',
    'decision_record_ids', 'base_tree', 'head_tree', 'files',
  ];
  rejectUnknown(value, allowed, 'patch set');
  const files = (value.files == null ? [] : value.files)
    .map(normalizePatchFile)
    .sort((left, right) => compareText(left.path, right.path));
  if (new Set(files.map(file => file.path)).size !== files.length) {
    throw new TypeError('patch set contains duplicate file paths');
  }
  const normalized = {
    schema: 1,
    attempt_id: patternedText(value.attempt_id, 'attempt_id', STABLE_ID_PATTERN),
    work_id: patternedText(value.work_id, 'work_id', WORK_ID_PATTERN),
    ...(value.spec_digest == null ? {} : { spec_digest: requiredText(value.spec_digest, 'spec_digest') }),
    plan_digest: requiredText(value.plan_digest, 'plan_digest'),
    ...(value.plan_state_digest == null ? {} : {
      plan_state_digest: patternedText(value.plan_state_digest, 'plan_state_digest', SHA256_PATTERN),
    }),
    ...(value.decision_record_ids == null ? {} : {
      decision_record_ids: sortedTextList(value.decision_record_ids, 'decision_record_ids', {
        pattern: DECISION_RECORD_PATTERN,
      }),
    }),
    base_tree: requiredText(value.base_tree, 'base_tree'),
    head_tree: requiredText(value.head_tree, 'head_tree'),
    files,
  };
  const patchSetId = sha256(canonicalBytes(normalized));
  if (allowIdentity && value.patch_set_id !== patchSetId) {
    throw new TypeError('patch set ID does not match its immutable content');
  }
  return { ...normalized, patch_set_id: patchSetId };
}

function buildPatchSet(input) {
  return deepFreeze(normalizePatchSet(input));
}

function acceptanceCriteriaForPatchSet(patchSet) {
  return [...new Set(patchSet.files.flatMap(file => file.acceptance_criteria))].sort(compareText);
}

function reviewProgress(files) {
  const values = Object.values(files);
  return { viewed: values.filter(file => file.viewed).length, total: values.length };
}

function reviewFiles(patchSet, previous = null) {
  const result = {};
  for (const file of patchSet.files) {
    const prior = previous?.files?.[file.path];
    const unchanged = prior?.patch_digest === file.patch_digest;
    result[file.path] = {
      patch_digest: file.patch_digest,
      acceptance_criteria: [...file.acceptance_criteria],
      viewed: Boolean(unchanged && prior.viewed),
      viewed_patch_set_id: unchanged && prior.viewed ? patchSet.patch_set_id : null,
    };
  }
  return result;
}

function finalizeReview(review) {
  review.viewed_progress = reviewProgress(review.files);
  review.can_approve = review.whole_feature_verdict?.verdict === 'approved';
  return deepFreeze(review);
}

function createPatchSetReview(value) {
  const patchSet = normalizePatchSet(value, true);
  return finalizeReview({
    schema: 1,
    patch_set_id: patchSet.patch_set_id,
    attempt_id: patchSet.attempt_id,
    work_id: patchSet.work_id,
    base_tree: patchSet.base_tree,
    head_tree: patchSet.head_tree,
    files: reviewFiles(patchSet),
    acceptance_evidence: {},
    whole_feature_verdict: null,
    viewed_progress: null,
    can_approve: false,
  });
}

function assertReview(value) {
  assertObject(value, 'patch set review');
  rejectUnknown(value, [
    'schema', 'patch_set_id', 'attempt_id', 'work_id', 'base_tree', 'head_tree', 'files',
    'acceptance_evidence', 'whole_feature_verdict', 'viewed_progress', 'can_approve',
  ], 'patch set review');
  if (value.schema !== 1) throw new TypeError('patch set review.schema must be 1');
  patternedText(value.patch_set_id, 'review.patch_set_id', SHA256_PATTERN);
  patternedText(value.attempt_id, 'review.attempt_id', STABLE_ID_PATTERN);
  patternedText(value.work_id, 'review.work_id', WORK_ID_PATTERN);
  requiredText(value.base_tree, 'review.base_tree');
  requiredText(value.head_tree, 'review.head_tree');
  assertObject(value.files, 'review.files');
  assertObject(value.acceptance_evidence, 'review.acceptance_evidence');
  if (value.whole_feature_verdict !== null) assertObject(value.whole_feature_verdict, 'review.whole_feature_verdict');
  assertObject(value.viewed_progress, 'review.viewed_progress');
  if (typeof value.can_approve !== 'boolean') throw new TypeError('review.can_approve must be boolean');
}

function normalizeReviewForPersistence(value, patchSet) {
  assertReview(value);
  if (value.patch_set_id !== patchSet.patch_set_id
    || value.attempt_id !== patchSet.attempt_id
    || value.work_id !== patchSet.work_id
    || value.base_tree !== patchSet.base_tree
    || value.head_tree !== patchSet.head_tree) {
    throw new TypeError('patch set review lineage does not match the immutable patch set');
  }

  const expectedFiles = new Map(patchSet.files.map(file => [file.path, file]));
  if (Object.keys(value.files).length !== expectedFiles.size) {
    throw new TypeError('patch set review files do not match the immutable patch set');
  }
  const files = {};
  for (const [filePath, state] of Object.entries(value.files).sort(([left], [right]) => compareText(left, right))) {
    repositoryPath(filePath, 'review file path');
    assertObject(state, `review.files.${filePath}`);
    rejectUnknown(state, [
      'patch_digest', 'acceptance_criteria', 'viewed', 'viewed_patch_set_id',
    ], `review.files.${filePath}`);
    const expected = expectedFiles.get(filePath);
    if (!expected) throw new TypeError(`review contains a file outside the patch set: ${filePath}`);
    const criteria = sortedTextList(state.acceptance_criteria, `review.files.${filePath}.acceptance_criteria`, {
      minimum: expected.attribution.kind === 'unmapped' ? 0 : 1,
      pattern: ACCEPTANCE_CRITERION_PATTERN,
    });
    if (state.patch_digest !== expected.patch_digest
      || JSON.stringify(criteria) !== JSON.stringify(expected.acceptance_criteria)) {
      throw new TypeError(`review state for ${filePath} does not match the immutable patch set`);
    }
    if (typeof state.viewed !== 'boolean') throw new TypeError(`review.files.${filePath}.viewed must be boolean`);
    if ((state.viewed && state.viewed_patch_set_id !== patchSet.patch_set_id)
      || (!state.viewed && state.viewed_patch_set_id !== null)) {
      throw new TypeError(`review.files.${filePath} has an invalid patch-specific Viewed identity`);
    }
    files[filePath] = {
      patch_digest: expected.patch_digest,
      acceptance_criteria: criteria,
      viewed: state.viewed,
      viewed_patch_set_id: state.viewed_patch_set_id,
    };
  }

  const knownCriteria = new Set(acceptanceCriteriaForPatchSet(patchSet));
  const acceptanceEvidence = {};
  for (const [criterion, evidence] of Object.entries(value.acceptance_evidence)
    .sort(([left], [right]) => compareText(left, right))) {
    patternedText(criterion, 'review Acceptance Criteria key', ACCEPTANCE_CRITERION_PATTERN);
    if (!knownCriteria.has(criterion)) throw new TypeError(`review evidence references unknown ${criterion}`);
    assertObject(evidence, `review.acceptance_evidence.${criterion}`);
    rejectUnknown(evidence, ['status', 'patch_set_id', 'evidence_ids'], `review.acceptance_evidence.${criterion}`);
    if (!['current', 'outdated'].includes(evidence.status)) {
      throw new TypeError(`review.acceptance_evidence.${criterion}.status is invalid`);
    }
    const evidencePatchSetId = patternedText(
      evidence.patch_set_id,
      `review.acceptance_evidence.${criterion}.patch_set_id`,
      SHA256_PATTERN,
    );
    if (evidence.status === 'current' && evidencePatchSetId !== patchSet.patch_set_id) {
      throw new TypeError(`current evidence for ${criterion} belongs to another patch set`);
    }
    acceptanceEvidence[criterion] = {
      status: evidence.status,
      patch_set_id: evidencePatchSetId,
      evidence_ids: sortedTextList(
        evidence.evidence_ids,
        `review.acceptance_evidence.${criterion}.evidence_ids`,
        { minimum: 1 },
      ),
    };
  }

  let wholeFeatureVerdict = null;
  if (value.whole_feature_verdict !== null) {
    const verdict = value.whole_feature_verdict;
    rejectUnknown(verdict, [
      'verdict', 'patch_set_id', 'acceptance_criteria', 'evidence_ids',
    ], 'review.whole_feature_verdict');
    if (!['approved', 'rejected'].includes(verdict.verdict)) {
      throw new TypeError('review.whole_feature_verdict.verdict is invalid');
    }
    if (verdict.patch_set_id !== patchSet.patch_set_id) {
      throw new TypeError('whole-feature verdict belongs to another patch set');
    }
    const criteria = sortedTextList(
      verdict.acceptance_criteria,
      'review.whole_feature_verdict.acceptance_criteria',
      { minimum: 1, pattern: ACCEPTANCE_CRITERION_PATTERN },
    );
    if (JSON.stringify(criteria) !== JSON.stringify([...knownCriteria])) {
      throw new TypeError('whole-feature verdict does not cover every Acceptance Criteria ID');
    }
    wholeFeatureVerdict = {
      verdict: verdict.verdict,
      patch_set_id: patchSet.patch_set_id,
      acceptance_criteria: criteria,
      evidence_ids: sortedTextList(verdict.evidence_ids, 'review.whole_feature_verdict.evidence_ids', {
        minimum: 1,
      }),
    };
  }

  const progress = reviewProgress(files);
  if (value.viewed_progress.viewed !== progress.viewed || value.viewed_progress.total !== progress.total) {
    throw new TypeError('review Viewed progress does not match its file states');
  }
  const canApprove = wholeFeatureVerdict?.verdict === 'approved';
  if (value.can_approve !== canApprove) throw new TypeError('review approval state does not match its whole-feature verdict');
  return {
    schema: 1,
    patch_set_id: patchSet.patch_set_id,
    attempt_id: patchSet.attempt_id,
    work_id: patchSet.work_id,
    base_tree: patchSet.base_tree,
    head_tree: patchSet.head_tree,
    files,
    acceptance_evidence: acceptanceEvidence,
    whole_feature_verdict: wholeFeatureVerdict,
    viewed_progress: progress,
    can_approve: canApprove,
  };
}

function assertCurrentPatchSet(review, event) {
  if (event.patch_set_id !== review.patch_set_id) {
    throw new TypeError('review event belongs to a different patch set');
  }
}

function changedAcceptanceCriteria(previous, nextPatchSet) {
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
    if (!previous.files[file.path]) {
      for (const criterion of file.acceptance_criteria) changed.add(criterion);
    }
  }
  return changed;
}

function updatePatchSetReview(value, event) {
  assertReview(value);
  assertObject(event, 'review event');
  const review = clone(value);

  if (event.type === 'file_viewed') {
    rejectUnknown(event, ['type', 'patch_set_id', 'path'], 'review event');
    assertCurrentPatchSet(review, event);
    const filePath = repositoryPath(event.path, 'review event.path');
    if (!review.files[filePath]) throw new TypeError(`patch set does not contain ${filePath}`);
    review.files[filePath].viewed = true;
    review.files[filePath].viewed_patch_set_id = review.patch_set_id;
    return finalizeReview(review);
  }

  if (event.type === 'acceptance_evidence_recorded') {
    rejectUnknown(event, [
      'type', 'patch_set_id', 'acceptance_criterion_id', 'evidence_ids',
    ], 'review event');
    assertCurrentPatchSet(review, event);
    const criterion = patternedText(
      event.acceptance_criterion_id,
      'review event.acceptance_criterion_id',
      ACCEPTANCE_CRITERION_PATTERN,
    );
    const known = new Set(Object.values(review.files).flatMap(file => file.acceptance_criteria));
    if (!known.has(criterion)) throw new TypeError(`patch set does not cover ${criterion}`);
    review.acceptance_evidence[criterion] = {
      status: 'current',
      patch_set_id: review.patch_set_id,
      evidence_ids: sortedTextList(event.evidence_ids, 'review event.evidence_ids', { minimum: 1 }),
    };
    return finalizeReview(review);
  }

  if (event.type === 'patch_set_replaced') {
    rejectUnknown(event, ['type', 'patch_set'], 'review event');
    const nextPatchSet = normalizePatchSet(event.patch_set, true);
    if (nextPatchSet.work_id !== review.work_id) throw new TypeError('replacement patch set belongs to another Work ID');
    const changedCriteria = changedAcceptanceCriteria(review, nextPatchSet);
    const acceptanceEvidence = {};
    for (const criterion of acceptanceCriteriaForPatchSet(nextPatchSet)) {
      const prior = review.acceptance_evidence[criterion];
      if (!prior) continue;
      acceptanceEvidence[criterion] = changedCriteria.has(criterion)
        ? { ...prior, status: 'outdated' }
        : { ...prior, status: 'current', patch_set_id: nextPatchSet.patch_set_id };
    }
    return finalizeReview({
      schema: 1,
      patch_set_id: nextPatchSet.patch_set_id,
      attempt_id: nextPatchSet.attempt_id,
      work_id: nextPatchSet.work_id,
      base_tree: nextPatchSet.base_tree,
      head_tree: nextPatchSet.head_tree,
      files: reviewFiles(nextPatchSet, review),
      acceptance_evidence: acceptanceEvidence,
      whole_feature_verdict: null,
      viewed_progress: null,
      can_approve: false,
    });
  }

  if (event.type === 'whole_feature_verdict_recorded') {
    rejectUnknown(event, [
      'type', 'patch_set_id', 'verdict', 'acceptance_criteria', 'evidence_ids',
    ], 'review event');
    assertCurrentPatchSet(review, event);
    if (!['approved', 'rejected'].includes(event.verdict)) {
      throw new TypeError('whole-feature verdict must be approved or rejected');
    }
    const criteria = sortedTextList(event.acceptance_criteria, 'review event.acceptance_criteria', {
      minimum: 1,
      pattern: ACCEPTANCE_CRITERION_PATTERN,
    });
    const expected = [...new Set(Object.values(review.files).flatMap(file => file.acceptance_criteria))]
      .sort(compareText);
    if (JSON.stringify(criteria) !== JSON.stringify(expected)) {
      throw new TypeError('whole-feature verdict must cover every Acceptance Criteria ID in the patch set');
    }
    review.whole_feature_verdict = {
      verdict: event.verdict,
      patch_set_id: review.patch_set_id,
      acceptance_criteria: criteria,
      evidence_ids: sortedTextList(event.evidence_ids, 'review event.evidence_ids', { minimum: 1 }),
    };
    return finalizeReview(review);
  }

  throw new TypeError(`unsupported review event ${String(event.type)}`);
}

function lstatIfPresent(file) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

function realDirectory(value, label, create = false) {
  const requested = path.resolve(requiredText(value, label));
  if (create) fs.mkdirSync(requested, { recursive: true, mode: 0o700 });
  const stat = lstatIfPresent(requested);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new TypeError(`${label} must be a real directory`);
  const real = fs.realpathSync(requested);
  if (real !== requested) throw new TypeError(`${label} must not contain symbolic links`);
  return real;
}

function resolveInside(root, ...segments) {
  const resolved = path.resolve(root, ...segments);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new TypeError('review evidence path must stay inside its root');
  }
  let current = root;
  for (const part of path.relative(root, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = lstatIfPresent(current);
    if (stat?.isSymbolicLink()) throw new TypeError(`review evidence path contains a symbolic link: ${current}`);
  }
  return resolved;
}

function exactFileDigest(file, expected, label) {
  const stat = lstatIfPresent(file);
  if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error(`${label} does not exist`);
  if (sha256(fs.readFileSync(file)) !== expected) throw new TypeError(`${label} digest does not match`);
}

function writeImmutable(file, bytes) {
  const stat = lstatIfPresent(file);
  if (stat) {
    if (!stat.isFile() || stat.isSymbolicLink() || fs.readFileSync(file, 'utf8') !== bytes) {
      throw new Error(`immutable review evidence already exists at ${file}`);
    }
    return;
  }
  fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
}

function manifestEnvelope(value) {
  assertObject(value, 'manifest');
  rejectUnknown(value, ['manifest', 'bytes', 'digest'], 'manifest');
  assertObject(value.manifest, 'manifest.manifest');
  if (typeof value.bytes !== 'string' || value.bytes.length === 0 || value.bytes.length > 20_000_000) {
    throw new TypeError('manifest.bytes must be a non-empty string of at most 20000000 characters');
  }
  const bytes = value.bytes;
  const digest = patternedText(value.digest, 'manifest.digest', SHA256_PATTERN);
  if (canonicalBytes(value.manifest) !== bytes || sha256(bytes) !== digest) {
    throw new TypeError('Review Slice manifest bytes or digest do not match its content');
  }
  const manifest = normalizeReviewSliceManifest(value.manifest);
  if (canonicalBytes(manifest) !== bytes) {
    throw new TypeError('Review Slice manifest is not in canonical normalized order');
  }
  return { manifest, bytes, digest };
}

function manifestChangesByPath(manifest) {
  const byPath = new Map();
  const seen = new Set();
  for (const slice of manifest.review_slices) {
    for (const change of slice.actual_changes) {
      const key = manifestChangeKey(change);
      if (seen.has(key)) continue;
      seen.add(key);
      if (!byPath.has(change.path)) byPath.set(change.path, []);
      byPath.get(change.path).push(change);
    }
  }
  for (const change of manifest.unmapped_changes) {
    if (!byPath.has(change.path)) byPath.set(change.path, []);
    byPath.get(change.path).push({ ...change, claimed_by: [] });
  }
  return byPath;
}

function reconcilePatchSetManifest(patchSet, manifest) {
  const changesByPath = manifestChangesByPath(manifest);
  const patchPaths = patchSet.files.map(file => file.path);
  const manifestPaths = [...changesByPath.keys()].sort(compareText);
  if (!equalCanonical(patchPaths, manifestPaths)) {
    throw new TypeError('patch set files do not match the Review Slice manifest changed paths');
  }
  const slicesById = new Map(manifest.review_slices.map(slice => [slice.task_id, slice]));
  for (const file of patchSet.files) {
    const changes = changesByPath.get(file.path) || [];
    if (changes.length !== 1) {
      throw new TypeError(`patch file ${file.path} has inconsistent Review Slice manifest changes`);
    }
    const change = changes[0];
    if (change.hunk_id !== file.patch_digest) {
      throw new TypeError(`patch file ${file.path} digest does not match the Review Slice manifest`);
    }
    const claimedBy = change.claimed_by;
    const expectedAttribution = claimedBy.length === 0
      ? { kind: 'unmapped' }
      : {
        kind: claimedBy.length === 1 ? 'review_slice' : 'cross_slice',
        review_slice_ids: claimedBy,
      };
    if (!equalCanonical(file.attribution, expectedAttribution)) {
      throw new TypeError(`patch file ${file.path} attribution is inconsistent with the Review Slice manifest`);
    }
    const allowedCriteria = new Set(claimedBy.flatMap(id => {
      const slice = slicesById.get(id);
      if (!slice) throw new TypeError(`patch file ${file.path} claims unknown Review Slice ${id}`);
      return slice.acceptance_criteria;
    }));
    for (const criterion of file.acceptance_criteria) {
      if (!allowedCriteria.has(criterion)) {
        throw new TypeError(`patch file ${file.path} claims ${criterion} outside its Review Slices`);
      }
    }
  }
}

function ledgerRecords(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); } catch { throw new TypeError(`ledger line ${index + 1} is invalid JSON`); }
  });
}

function persistAttemptReviewEvidence(input) {
  assertObject(input, 'persistence input');
  rejectUnknown(input, [
    'repositoryRoot', 'dataDirectory', 'attempt', 'patchSet', 'manifest', 'review',
    'disposition', 'cause',
  ], 'persistence input');
  const repositoryRoot = realDirectory(input.repositoryRoot, 'repositoryRoot');
  assertObject(input.attempt, 'attempt');
  const attemptId = patternedText(input.attempt.attemptId, 'attempt.attemptId', STABLE_ID_PATTERN);
  const evidenceParent = resolveInside(repositoryRoot, '.pair', 'review-evidence');
  const evidenceDirectory = resolveInside(evidenceParent, attemptId);
  const existingEvidence = lstatIfPresent(evidenceDirectory);

  let patchSet;
  try {
    patchSet = normalizePatchSet(input.patchSet, true);
  } catch (error) {
    if (existingEvidence) throw new Error(`immutable review evidence already exists for ${attemptId}`);
    throw error;
  }
  const manifest = manifestEnvelope(input.manifest);
  const review = normalizeReviewForPersistence(input.review, patchSet);
  if (patchSet.attempt_id !== attemptId) {
    throw new TypeError('attempt, patch set, and review identities do not match');
  }
  const attemptDecisionRecordIds = sortedTextList(
    input.attempt.decisionRecordIds,
    'attempt.decisionRecordIds',
    { pattern: DECISION_RECORD_PATTERN },
  );
  const attemptCriteria = sortedTextList(
    input.attempt.acceptanceCriteria,
    'attempt.acceptanceCriteria',
    { minimum: 1, pattern: ACCEPTANCE_CRITERION_PATTERN },
  );
  const attemptPlanStateDigest = input.attempt.planStateDigest == null
    ? undefined
    : patternedText(input.attempt.planStateDigest, 'attempt.planStateDigest', SHA256_PATTERN);
  if (input.attempt.workId !== patchSet.work_id
    || input.attempt.specDigest !== patchSet.spec_digest
    || input.attempt.planDigest !== patchSet.plan_digest
    || attemptPlanStateDigest !== patchSet.plan_state_digest
    || input.attempt.baseline !== patchSet.base_tree
    || JSON.stringify(attemptDecisionRecordIds) !== JSON.stringify(patchSet.decision_record_ids || [])
    || JSON.stringify(attemptCriteria) !== JSON.stringify(acceptanceCriteriaForPatchSet(patchSet))) {
    throw new TypeError('attempt and patch set Work lineage do not match');
  }
  if (manifest.manifest.work_id !== patchSet.work_id
    || manifest.manifest.base_tree !== patchSet.base_tree
    || manifest.manifest.head_tree !== patchSet.head_tree
    || manifest.manifest.plan_digest !== patchSet.plan_digest) {
    throw new TypeError('Review Slice manifest and patch set lineage do not match');
  }

  const planPath = resolveInside(repositoryRoot, '.pair', 'plan.md');
  const plan = fs.readFileSync(planPath, 'utf8');
  const expectedManifest = buildReviewSliceManifest({
    workId: patchSet.work_id,
    repositoryRoot,
    plan,
    baseTree: patchSet.base_tree,
    headTree: patchSet.head_tree,
    planDigest: patchSet.plan_digest,
    indexerVersion: manifest.manifest.indexer_version,
  });
  if (expectedManifest.bytes !== manifest.bytes || expectedManifest.digest !== manifest.digest) {
    throw new TypeError('Review Slice manifest does not match repository Git evidence and Pair plan');
  }
  reconcilePatchSetManifest(patchSet, manifest.manifest);

  exactFileDigest(
    resolveInside(repositoryRoot, 'docs', 'work', patchSet.work_id, 'spec.md'),
    patchSet.spec_digest,
    'canonical Work spec',
  );
  exactFileDigest(
    planPath,
    patchSet.plan_state_digest || patchSet.plan_digest,
    'Pair plan state',
  );
  for (const recordId of patchSet.decision_record_ids || []) {
    const file = resolveInside(
      repositoryRoot,
      'docs',
      'work',
      patchSet.work_id,
      'decisions',
      `${recordId}.md`,
    );
    if (!lstatIfPresent(file)?.isFile()) throw new Error(`Decision Record ${recordId} does not exist`);
  }

  fs.mkdirSync(evidenceParent, { recursive: true, mode: 0o700 });
  resolveInside(repositoryRoot, '.pair', 'review-evidence');
  if (!existingEvidence) fs.mkdirSync(evidenceDirectory, { mode: 0o700 });
  else if (!existingEvidence.isDirectory() || existingEvidence.isSymbolicLink()) {
    throw new Error(`immutable review evidence already exists for ${attemptId}`);
  }
  const patchSetPath = resolveInside(evidenceDirectory, 'patch-set.json');
  const manifestPath = resolveInside(evidenceDirectory, 'review-slice-manifest.json');
  const reviewPath = resolveInside(evidenceDirectory, 'patch-set-review.json');
  writeImmutable(patchSetPath, `${JSON.stringify(patchSet, null, 2)}\n`);
  writeImmutable(manifestPath, `${JSON.stringify({ digest: manifest.digest, manifest: manifest.manifest }, null, 2)}\n`);
  writeImmutable(reviewPath, `${JSON.stringify(review, null, 2)}\n`);

  const dataDirectory = realDirectory(input.dataDirectory, 'dataDirectory', true);
  const ledgerPath = resolveInside(dataDirectory, 'attempts.jsonl');
  const ledgerRecord = {
    event: 'attempt.review-evidence.persisted',
    attemptId,
    workId: patchSet.work_id,
    patchSetId: patchSet.patch_set_id,
    manifestDigest: manifest.digest,
    disposition: requiredText(input.disposition, 'disposition', 100),
    cause: requiredText(input.cause, 'cause', 200),
  };
  const prior = ledgerRecords(ledgerPath).filter(record => (
    record.event === ledgerRecord.event && record.attemptId === attemptId
  ));
  if (prior.length > 0) {
    if (prior.length !== 1 || canonicalBytes(prior[0]) !== canonicalBytes(ledgerRecord)) {
      throw new Error(`immutable review evidence ledger entry already exists for ${attemptId}`);
    }
  } else {
    fs.appendFileSync(ledgerPath, `${JSON.stringify(ledgerRecord)}\n`, { mode: 0o600 });
  }

  return deepFreeze({
    evidenceDirectory,
    patchSetPath,
    manifestPath,
    reviewPath,
    ledgerPath,
  });
}

module.exports = {
  buildPatchSet,
  buildReviewSliceManifest,
  createPatchSetReview,
  persistAttemptReviewEvidence,
  updatePatchSetReview,
};
