const crypto = require('node:crypto');
const fs = require('node:fs');

const MANIFEST_SCHEMA = 1;
const MAX_MANIFEST_BYTES = 16 * 1024;
const MAX_SLICE_BYTES = 1400;
const MANIFEST_KEYS = new Set(['schema', 'work_id', 'slices']);
const SLICE_KEYS = new Set(['id', 'acceptance_criteria', 'outcome', 'depends_on', 'verify']);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertOnlyKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${label} has unsupported fields: ${unknown.join(', ')}`);
}

function acceptanceCriteriaFromSpec(spec) {
  const criteria = new Map();
  for (const match of String(spec).matchAll(/^\s*-\s+\[[ xX-]\]\s+(AC-[A-Za-z0-9._-]+)\s*:\s*(.+)$/gmu)) {
    if (criteria.has(match[1])) throw new Error(`canonical specification repeats ${match[1]}`);
    criteria.set(match[1], match[2].trim());
  }
  if (criteria.size === 0) throw new Error('canonical specification has no Acceptance Criteria');
  return criteria;
}

function validateIdentifier(value, label) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(String(value || ''))) {
    throw new Error(`${label} must use 1-80 letters, digits, dot, underscore, or hyphen characters`);
  }
  return String(value);
}

function validateManifest(manifest, spec, expectedWorkId = null) {
  if (!plainObject(manifest)) throw new Error('Review Slice Manifest must be one JSON object');
  assertOnlyKeys(manifest, MANIFEST_KEYS, 'Review Slice Manifest');
  if (manifest.schema !== MANIFEST_SCHEMA) throw new Error(`Review Slice Manifest schema must be ${MANIFEST_SCHEMA}`);
  const workId = validateIdentifier(manifest.work_id, 'Work ID');
  if (expectedWorkId && workId !== expectedWorkId) {
    throw new Error(`Review Slice Manifest Work ID ${workId} does not match ${expectedWorkId}`);
  }
  if (!Array.isArray(manifest.slices) || manifest.slices.length === 0 || manifest.slices.length > 40) {
    throw new Error('Review Slice Manifest requires 1-40 slices');
  }
  const criteria = acceptanceCriteriaFromSpec(spec);
  const seenSlices = new Set();
  const coveredCriteria = new Set();
  const slices = manifest.slices.map((slice, index) => {
    if (!plainObject(slice)) throw new Error(`Review Slice ${index + 1} must be one object`);
    assertOnlyKeys(slice, SLICE_KEYS, `Review Slice ${index + 1}`);
    const id = validateIdentifier(slice.id, `Review Slice ${index + 1} ID`);
    if (seenSlices.has(id)) throw new Error(`duplicate Review Slice ${id}`);
    if (!Array.isArray(slice.acceptance_criteria) || slice.acceptance_criteria.length === 0 || slice.acceptance_criteria.length > 12) {
      throw new Error(`Review Slice ${id} requires 1-12 Acceptance Criteria IDs`);
    }
    const mappedCriteria = [...new Set(slice.acceptance_criteria.map(value => String(value)))];
    for (const criterion of mappedCriteria) {
      if (!criteria.has(criterion)) throw new Error(`Review Slice ${id} maps unknown ${criterion}`);
      coveredCriteria.add(criterion);
    }
    const outcome = String(slice.outcome || '').trim();
    if (!outcome || outcome.length > 400) throw new Error(`Review Slice ${id} outcome must use 1-400 characters`);
    const dependsOn = slice.depends_on === undefined ? [] : slice.depends_on;
    if (!Array.isArray(dependsOn) || dependsOn.length > 20) throw new Error(`Review Slice ${id} depends_on must be an array of at most 20 IDs`);
    const dependencies = [...new Set(dependsOn.map(value => validateIdentifier(value, `Review Slice ${id} dependency`)))];
    for (const dependency of dependencies) {
      if (!seenSlices.has(dependency)) throw new Error(`Review Slice ${id} dependency ${dependency} must appear earlier`);
    }
    const verify = String(slice.verify || '').trim();
    if (!verify || verify.length > 1000 || /[\r\n\0]/u.test(verify)) {
      throw new Error(`Review Slice ${id} verify must be one command using 1-1000 characters`);
    }
    const normalized = {
      id,
      acceptance_criteria: mappedCriteria,
      outcome,
      depends_on: dependencies,
      verify,
    };
    if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > MAX_SLICE_BYTES) {
      throw new Error(`Review Slice ${id} exceeds ${MAX_SLICE_BYTES} UTF-8 bytes`);
    }
    seenSlices.add(id);
    return normalized;
  });
  const uncovered = [...criteria.keys()].filter(id => !coveredCriteria.has(id));
  if (uncovered.length > 0) throw new Error(`Review Slice Manifest does not cover: ${uncovered.join(', ')}`);
  const normalized = { schema: MANIFEST_SCHEMA, work_id: workId, slices };
  const serialized = `${JSON.stringify(normalized, null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_MANIFEST_BYTES) {
    throw new Error(`Review Slice Manifest exceeds ${MAX_MANIFEST_BYTES} UTF-8 bytes`);
  }
  return {
    manifest: normalized,
    criteria,
    bytes: Buffer.byteLength(serialized, 'utf8'),
    digest: sha256(serialized),
    serialized,
  };
}

function loadManifest(manifestPath, specPath, expectedWorkId = null) {
  const spec = fs.readFileSync(specPath, 'utf8');
  const raw = fs.readFileSync(manifestPath, 'utf8');
  let manifest;
  try { manifest = JSON.parse(raw); } catch { throw new Error('Review Slice Manifest is not valid JSON'); }
  return { spec, ...validateManifest(manifest, spec, expectedWorkId) };
}

function relevantAcceptanceCriteria(criteria, slice) {
  return slice.acceptance_criteria.map(id => ({ id, text: criteria.get(id) }));
}

module.exports = {
  MANIFEST_SCHEMA,
  MAX_MANIFEST_BYTES,
  acceptanceCriteriaFromSpec,
  loadManifest,
  relevantAcceptanceCriteria,
  sha256,
  validateManifest,
};
