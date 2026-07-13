#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const WORK_SCHEMA = require('../schemas/work.schema.json');
const DECISION_SCHEMA = require('../schemas/decision-record.schema.json');
const QUALITY_SCHEMA = require('../schemas/quality-contract.schema.json');
const EVIDENCE_SCHEMA = require('../schemas/evidence-record.schema.json');

const WORK_ID_PATTERN = new RegExp(WORK_SCHEMA.$defs.work_id.pattern);
const DECISION_ID_PATTERN = new RegExp(DECISION_SCHEMA.$defs.decision_record_id.pattern);
const ACCEPTANCE_CRITERION_PATTERN = new RegExp(DECISION_SCHEMA.$defs.acceptance_criterion_id.pattern);
const OUTCOME_ID_PATTERN = /^OUT-\d{3}-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EVIDENCE_ID_PATTERN = new RegExp(EVIDENCE_SCHEMA.$defs.evidence_record_id.pattern);
const CHANGE_ID_PATTERN = /^CHG-\d{3}-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const OBLIGATION_ID_PATTERN = new RegExp(QUALITY_SCHEMA.$defs.obligation_id.pattern);
const APPROVAL_PROVENANCE_ID_PATTERN = new RegExp(QUALITY_SCHEMA.$defs.approval_provenance_id.pattern);
const FACT_PATTERN = new RegExp(QUALITY_SCHEMA.$defs.fact.pattern);
const SHA256_PATTERN = new RegExp(WORK_SCHEMA.$defs.sha256.pattern);
const RFC3339_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/;
const PROTECTED_DOMAINS = new Set(['security', 'privacy', 'accessibility', 'safety', 'compliance']);
const APPROVAL_AUTHORITIES = new Set(['user', 'automation', 'CODEOWNER', 'domain_owner']);
const LOCK_WAIT_MILLISECONDS = 5_000;
const STALE_LOCK_MILLISECONDS = 60_000;
const sleepCell = new Int32Array(new SharedArrayBuffer(4));

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function rejectUnknown(value, allowed, label) {
  const unknown = Object.keys(value).find(key => !allowed.includes(key));
  if (unknown !== undefined) throw new TypeError(`unsupported field ${label}.${unknown}`);
}

function assertSchemaObject(value, schema, label) {
  assertObject(value, label);
  rejectUnknown(value, Object.keys(schema.properties || {}), label);
  for (const field of schema.required || []) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) {
      throw new TypeError(`${label}.${field} is required`);
    }
  }
}

function requiredText(value, label, maximum = 500, exact = false) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} is required`);
  const normalized = value.trim();
  if (exact && normalized !== value) throw new TypeError(`${label} must not have surrounding whitespace`);
  if (normalized.length > maximum) throw new RangeError(`${label} must be at most ${maximum} characters`);
  return normalized;
}

function optionalText(value, label, maximum = 500) {
  if (value == null) return null;
  return requiredText(value, label, maximum);
}

function textList(value, label, options = {}) {
  const minimum = options.minimum ?? 0;
  const maximum = options.maximum ?? 100;
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new TypeError(`${label} must contain ${minimum}-${maximum} items`);
  }
  const normalized = value.map((item, index) => {
    const text = requiredText(item, `${label}[${index}]`, options.itemLength ?? 500, options.exact);
    if (options.pattern && !options.pattern.test(text)) {
      throw new TypeError(`${label}[${index}] has an invalid identifier`);
    }
    return text;
  });
  if (new Set(normalized).size !== normalized.length) throw new TypeError(`${label} contains duplicate items`);
  return normalized;
}

function identifier(value, label, pattern, exact = false) {
  const normalized = requiredText(value, label, 200, exact);
  if (!pattern.test(normalized)) throw new TypeError(`${label} has an invalid identifier`);
  return normalized;
}

function identifierList(value, label, pattern, options = {}) {
  return textList(value, label, { ...options, pattern });
}

function timestamp(value, label, exact = false) {
  const normalized = requiredText(value, label, 80, exact);
  const match = normalized.match(RFC3339_PATTERN);
  if (!match) throw new TypeError(`${label} must be an RFC 3339 date-time`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const offsetHour = match[10] == null ? 0 : Number(match[10]);
  const offsetMinute = match[11] == null ? 0 : Number(match[11]);
  const valid = month >= 1 && month <= 12
    && day >= 1 && day <= daysInMonth[month - 1]
    && hour <= 23 && minute <= 59 && second <= 59
    && offsetHour <= 23 && offsetMinute <= 59
    && !Number.isNaN(Date.parse(normalized));
  if (!valid) {
    throw new TypeError(`${label} must be an RFC 3339 date-time`);
  }
  return normalized;
}

function workIdentifier(value, label = 'Work ID', exact = false) {
  return identifier(value, label, WORK_ID_PATTERN, exact);
}

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function lstatIfPresent(file) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

function repositoryRootPath(value) {
  const requested = path.resolve(requiredText(value, 'repositoryRoot', 2_000));
  const stat = lstatIfPresent(requested);
  if (!stat) throw new Error(`repository root ${requested} does not exist`);
  const real = fs.realpathSync(requested);
  if (!fs.statSync(real).isDirectory()) throw new TypeError('repositoryRoot must be a directory');
  return real;
}

function assertNoSymlinkComponents(root, target) {
  const relative = path.relative(root, target);
  if (relative === '') return;
  let current = root;
  const parts = relative.split(path.sep);
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    const stat = lstatIfPresent(current);
    if (!stat) continue;
    if (stat.isSymbolicLink()) {
      throw new TypeError(`lineage path contains a symbolic link: ${current}`);
    }
    if (index < parts.length - 1 && !stat.isDirectory()) {
      throw new TypeError(`lineage path component must be a directory: ${current}`);
    }
  }
}

function resolveInside(root, ...segments) {
  const resolvedRoot = fs.realpathSync(path.resolve(root));
  const resolved = path.resolve(resolvedRoot, ...segments);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new TypeError('lineage path must stay inside the repository root');
  }
  assertNoSymlinkComponents(resolvedRoot, resolved);
  return resolved;
}

function assertSafeExistingFile(file, label) {
  const resolved = path.resolve(file);
  const stat = lstatIfPresent(resolved);
  if (!stat) throw new Error(`${label} does not exist: ${resolved}`);
  if (stat.isSymbolicLink()) throw new TypeError(`${label} must not be a symbolic link`);
  if (!stat.isFile()) throw new TypeError(`${label} must be a file`);
  const realParent = fs.realpathSync(path.dirname(resolved));
  if (path.join(realParent, path.basename(resolved)) !== resolved) {
    throw new TypeError(`${label} path must not contain a symbolic link`);
  }
  return resolved;
}

function workRoot(repositoryRoot, workId) {
  return resolveInside(repositoryRoot, 'docs', 'work', workIdentifier(workId));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function atomicWrite(repositoryRoot, file, contents) {
  const root = repositoryRootPath(repositoryRoot);
  const target = resolveInside(root, path.relative(root, path.resolve(file)));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  resolveInside(root, path.relative(root, target));
  const temporary = resolveInside(root, path.relative(root, `${target}.${process.pid}.${crypto.randomUUID()}.tmp`));
  try {
    fs.writeFileSync(temporary, contents, { mode: 0o644, flag: 'wx' });
    fs.renameSync(temporary, target);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function atomicJson(repositoryRoot, file, value) {
  atomicWrite(repositoryRoot, file, `${JSON.stringify(value, null, 2)}\n`);
}

function parseJsonFile(file, label) {
  assertSafeExistingFile(file, label);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new TypeError(`${label} is not valid JSON: ${error.message}`);
  }
}

function parseSpecWorkId(spec) {
  return spec.match(/^- \*\*Work ID:\*\* `([^`]+)`\s*$/m)?.[1] || null;
}

function canonicalSpecWithWorkId(spec, workId) {
  let replaced = false;
  const updated = spec.replace(
    /^(- \*\*Work ID:\*\* `)[^`]+(`(?:[ \t]*))$/m,
    (line, prefix, suffix) => {
      replaced = true;
      return `${prefix}${workId}${suffix}`;
    },
  );
  if (!replaced) throw new TypeError('canonical spec Work ID declaration is missing');
  return updated;
}

function specTitle(spec, workId) {
  const heading = spec.match(/^# (?:Spec:\s*)?(.+)\s*$/m)?.[1]?.trim();
  return heading || workId;
}

function markdownSectionBody(contents, heading) {
  const match = new RegExp(`^## ${escapeRegularExpression(heading)}\\s*$`, 'm').exec(contents);
  if (!match) return null;
  const remainder = contents.slice(match.index + match[0].length);
  const nextHeading = remainder.search(/^## /m);
  return (nextHeading >= 0 ? remainder.slice(0, nextHeading) : remainder).trim();
}

function assertEngineeringQualityContractContent(spec) {
  const body = markdownSectionBody(spec, 'Engineering Quality Contract');
  if (!body) {
    throw new TypeError('Engineering Quality Contract must contain approved obligation content');
  }
  return body;
}

function validateReferenceList(value, label, pattern) {
  return textList(value, label, { exact: true, pattern, itemLength: 1_000 });
}

function validatePersistedWork(value, expectedWorkId = null) {
  assertSchemaObject(value, WORK_SCHEMA, 'Work');
  if (value.schema !== 1) throw new TypeError('Work schema must be 1');
  const workId = workIdentifier(value.work_id, 'Work.work_id', true);
  if (expectedWorkId && workId !== expectedWorkId) throw new Error('Work ID mismatch');
  requiredText(value.title, 'Work.title', 500, true);
  requiredText(value.status, 'Work.status', 100, true);

  assertSchemaObject(value.spec, WORK_SCHEMA.$defs.digest_reference, 'Work.spec');
  const expectedSpec = `docs/work/${workId}/spec.md`;
  if (value.spec.path !== expectedSpec) throw new TypeError(`Work.spec.path must be ${expectedSpec}`);
  identifier(value.spec.sha256, 'Work.spec.sha256', SHA256_PATTERN, true);
  if (value.active_pair_mirror !== '.pair/spec.md') {
    throw new TypeError('Work.active_pair_mirror must be .pair/spec.md');
  }

  const qualitySchema = WORK_SCHEMA.properties.engineering_quality_contract;
  assertSchemaObject(value.engineering_quality_contract, qualitySchema, 'Work.engineering_quality_contract');
  if (value.engineering_quality_contract.path !== expectedSpec
      || value.engineering_quality_contract.section !== 'Engineering Quality Contract'
      || value.engineering_quality_contract.status !== 'approved') {
    throw new TypeError('Work.engineering_quality_contract must reference the approved canonical section');
  }

  if (value.plan !== undefined) {
    assertSchemaObject(value.plan, WORK_SCHEMA.properties.plan, 'Work.plan');
    if (value.plan.path !== '.pair/plan.md') throw new TypeError('Work.plan.path must be .pair/plan.md');
    identifier(value.plan.sha256, 'Work.plan.sha256', SHA256_PATTERN, true);
    requiredText(value.plan.status, 'Work.plan.status', 100, true);
    requiredText(value.plan.independent_review, 'Work.plan.independent_review', 100, true);
  }
  if (value.approved_visual_revision !== undefined) {
    identifier(value.approved_visual_revision, 'Work.approved_visual_revision', /^[a-f0-9]{8,64}$/, true);
  }

  const prefix = `docs/work/${workId}`;
  validateReferenceList(
    value.decision_records,
    'Work.decision_records',
    new RegExp(`^${prefix}/decisions/DR-[0-9]{3}-[a-z0-9]+(?:-[a-z0-9]+)*\\.md$`),
  );
  validateReferenceList(
    value.changes,
    'Work.changes',
    new RegExp(`^${prefix}/changes/CHG-[0-9]{3}-[a-z0-9]+(?:-[a-z0-9]+)*\\.json$`),
  );
  validateReferenceList(
    value.outcomes,
    'Work.outcomes',
    new RegExp(`^${prefix}/outcomes/OUT-[0-9]{3}-[a-z0-9]+(?:-[a-z0-9]+)*\\.md$`),
  );
  validateReferenceList(
    value.evidence_records,
    'Work.evidence_records',
    new RegExp(`^${prefix}/evidence/EVD-[0-9]{3}-[a-z0-9]+(?:-[a-z0-9]+)*\\.json$`),
  );

  if (!Array.isArray(value.decision_supersessions)) {
    throw new TypeError('Work.decision_supersessions must be an array');
  }
  const relationKeys = new Set();
  const supersededPredecessors = new Set();
  const supersedingSuccessors = new Set();
  const successorByPredecessor = new Map();
  for (const [index, relation] of value.decision_supersessions.entries()) {
    assertSchemaObject(relation, WORK_SCHEMA.$defs.decision_supersession, `Work.decision_supersessions[${index}]`);
    const predecessor = identifier(
      relation.predecessor,
      `Work.decision_supersessions[${index}].predecessor`,
      DECISION_ID_PATTERN,
      true,
    );
    const successor = identifier(
      relation.successor,
      `Work.decision_supersessions[${index}].successor`,
      DECISION_ID_PATTERN,
      true,
    );
    if (predecessor === successor) throw new TypeError('Decision Record cannot supersede itself');
    const key = `${predecessor}\0${successor}`;
    if (relationKeys.has(key)) throw new TypeError('Work.decision_supersessions contains duplicate items');
    if (supersededPredecessors.has(predecessor)) {
      throw new TypeError(`Decision Record predecessor ${predecessor} has multiple successors`);
    }
    if (supersedingSuccessors.has(successor)) {
      throw new TypeError(`Decision Record successor ${successor} supersedes multiple predecessors`);
    }
    relationKeys.add(key);
    supersededPredecessors.add(predecessor);
    supersedingSuccessors.add(successor);
    successorByPredecessor.set(predecessor, successor);
  }
  for (const start of successorByPredecessor.keys()) {
    const pathToSuccessor = new Set();
    let current = start;
    while (successorByPredecessor.has(current)) {
      if (pathToSuccessor.has(current)) {
        throw new TypeError(`Decision Record supersession contains a cycle at ${current}`);
      }
      pathToSuccessor.add(current);
      current = successorByPredecessor.get(current);
    }
  }
  return value;
}

function readWork(repositoryRoot, workId) {
  const repository = repositoryRootPath(repositoryRoot);
  const root = workRoot(repository, workId);
  const file = resolveInside(repository, 'docs', 'work', workId, 'work.json');
  const work = validatePersistedWork(parseJsonFile(file, `Work ${workId}`), workId);
  return { file, root, work, repositoryRoot: repository };
}

function lockIsStale(lockFile) {
  const stat = lstatIfPresent(lockFile);
  if (!stat) return false;
  try {
    const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    if (!Number.isInteger(lock.pid)) return Date.now() - stat.mtimeMs > STALE_LOCK_MILLISECONDS;
    process.kill(lock.pid, 0);
    return false;
  } catch (error) {
    if (error.code === 'ESRCH') return true;
    return error instanceof SyntaxError && Date.now() - stat.mtimeMs > STALE_LOCK_MILLISECONDS;
  }
}

function removeOwnedLock(lockFile, token) {
  try {
    const current = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    if (current.token === token) fs.rmSync(lockFile, { force: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function reclaimMarkerFiles(reclaimPrefix) {
  const directory = path.dirname(reclaimPrefix);
  const basename = path.basename(reclaimPrefix);
  return fs.readdirSync(directory)
    .filter(name => name === basename || name.startsWith(`${basename}.`))
    .map(name => path.join(directory, name));
}

function reclaimMarkerIsStale(file, reclaimPrefix) {
  if (lockIsStale(file)) return true;
  const suffix = path.basename(file).slice(path.basename(reclaimPrefix).length + 1);
  const pid = Number(suffix.split('.')[0]);
  if (!Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === 'ESRCH';
  }
}

function activeReclaimMarkers(reclaimPrefix) {
  const active = [];
  for (const marker of reclaimMarkerFiles(reclaimPrefix)) {
    const stat = lstatIfPresent(marker);
    if (!stat) continue;
    if (stat.isSymbolicLink()) throw new TypeError(`lineage lock reclaimer must not be a symbolic link: ${marker}`);
    if (reclaimMarkerIsStale(marker, reclaimPrefix)) fs.rmSync(marker, { force: true });
    else active.push(marker);
  }
  return active;
}

function reclaimStaleLock(lockFile, reclaimPrefix) {
  const reclaimToken = crypto.randomUUID();
  const reclaimFile = `${reclaimPrefix}.${process.pid}.${reclaimToken}`;
  let descriptor;
  try {
    descriptor = fs.openSync(reclaimFile, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, token: reclaimToken })}\n`);
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
  try {
    if (!lockIsStale(lockFile)) return false;
    fs.rmSync(lockFile, { force: true });
    return true;
  } finally {
    fs.closeSync(descriptor);
    removeOwnedLock(reclaimFile, reclaimToken);
  }
}

function withExclusiveLock(lockFile, reclaimFile, label, action) {
  const token = crypto.randomUUID();
  const started = Date.now();
  let descriptor;
  while (descriptor === undefined) {
    if (activeReclaimMarkers(reclaimFile).length > 0) {
      if (Date.now() - started >= LOCK_WAIT_MILLISECONDS) {
        throw new Error(`timed out waiting for ${label} lock reclaimer`);
      }
      Atomics.wait(sleepCell, 0, 0, 10);
      continue;
    }
    try {
      descriptor = fs.openSync(lockFile, 'wx', 0o600);
      try {
        fs.writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, token, started_at: new Date().toISOString() })}\n`);
      } catch (error) {
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.rmSync(lockFile, { force: true });
        throw error;
      }
      if (activeReclaimMarkers(reclaimFile).length > 0) {
        fs.closeSync(descriptor);
        descriptor = undefined;
        removeOwnedLock(lockFile, token);
        continue;
      }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (lockIsStale(lockFile) && reclaimStaleLock(lockFile, reclaimFile)) {
        continue;
      }
      if (Date.now() - started >= LOCK_WAIT_MILLISECONDS) {
        throw new Error(`timed out waiting for ${label} lock`);
      }
      Atomics.wait(sleepCell, 0, 0, 10);
    }
  }

  try {
    return action();
  } finally {
    fs.closeSync(descriptor);
    removeOwnedLock(lockFile, token);
  }
}

function withWorkLock(repositoryRoot, workId, action) {
  const repository = repositoryRootPath(repositoryRoot);
  const root = workRoot(repository, workId);
  const lockFile = resolveInside(repository, path.relative(repository, path.join(root, '.work-lineage.lock')));
  const reclaimFile = resolveInside(repository, path.relative(repository, path.join(root, '.work-lineage.lock.reclaim')));
  return withExclusiveLock(lockFile, reclaimFile, `Work ${workId} lineage`, () => action(readWork(repository, workId)));
}

function relativeArtifactPath(state, absolutePath) {
  const resolved = resolveInside(state.repositoryRoot, path.relative(state.repositoryRoot, absolutePath));
  return toPosix(path.relative(state.repositoryRoot, resolved));
}

function appendIndexReferenceLocked(state, field, absolutePath) {
  const relative = relativeArtifactPath(state, absolutePath);
  const references = [...state.work[field]];
  if (!references.includes(relative)) references.push(relative);
  state.work[field] = references.sort();
  return relative;
}

function persistWork(state) {
  validatePersistedWork(state.work, state.work.work_id);
  atomicJson(state.repositoryRoot, state.file, state.work);
}

function validateCreateJournal(value, workId, digest) {
  assertObject(value, 'Work creation journal');
  rejectUnknown(value, [
    'schema', 'work_id', 'spec_sha256', 'target_root', 'staging_root', 'mirror_staging', 'mirror_backup',
  ], 'Work creation journal');
  for (const field of [
    'schema', 'work_id', 'spec_sha256', 'target_root', 'staging_root', 'mirror_staging', 'mirror_backup',
  ]) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) {
      throw new TypeError(`Work creation journal.${field} is required`);
    }
  }
  if (value.schema !== 1 || value.work_id !== workId || value.spec_sha256 !== digest) {
    throw new Error(`incomplete Work ${workId} creation belongs to different approved content`);
  }
  for (const field of ['target_root', 'staging_root', 'mirror_staging', 'mirror_backup']) {
    requiredText(value[field], `Work creation journal.${field}`, 1_000, true);
  }
  const targetRoot = `docs/work/${workId}`;
  const stagingMatch = value.staging_root.match(
    new RegExp(`^docs/work/\\.${escapeRegularExpression(workId)}\\.([a-f0-9-]+)\\.staging$`),
  );
  const mirrorStagingMatch = value.mirror_staging.match(/^\.pair\/\.spec\.([a-f0-9-]+)\.staging$/);
  const mirrorBackupMatch = value.mirror_backup.match(/^\.pair\/\.spec\.([a-f0-9-]+)\.backup$/);
  if (value.target_root !== targetRoot
      || !stagingMatch
      || !mirrorStagingMatch
      || !mirrorBackupMatch
      || stagingMatch[1] !== mirrorStagingMatch[1]
      || stagingMatch[1] !== mirrorBackupMatch[1]) {
    throw new TypeError('Work creation journal contains invalid transaction paths');
  }
  return value;
}

function validateCreationRoot(root, canonicalSpec, workId, digest) {
  const stat = lstatIfPresent(root);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new TypeError(`incomplete Work ${workId} has an invalid staged root`);
  }
  const specFile = path.join(root, 'spec.md');
  const workFile = path.join(root, 'work.json');
  assertSafeExistingFile(specFile, 'staged canonical spec');
  assertSafeExistingFile(workFile, 'staged Work index');
  if (fs.readFileSync(specFile, 'utf8') !== canonicalSpec) {
    throw new Error(`incomplete Work ${workId} canonical bytes do not match retry input`);
  }
  const work = validatePersistedWork(parseJsonFile(workFile, 'staged Work index'), workId);
  if (work.spec.sha256 !== digest) throw new Error(`incomplete Work ${workId} digest does not match retry input`);
}

function restoreMirrorBackup(pairFile, mirrorBackup) {
  if (!lstatIfPresent(mirrorBackup)) return;
  if (lstatIfPresent(pairFile)) fs.rmSync(pairFile, { force: true });
  fs.renameSync(mirrorBackup, pairFile);
}

function recoverWorkCreation({
  repository,
  workId,
  canonicalSpec,
  digest,
  mirror,
  pairFile,
  targetRoot,
  journalFile,
}) {
  if (!lstatIfPresent(journalFile)) return false;
  const journal = validateCreateJournal(parseJsonFile(journalFile, 'Work creation journal'), workId, digest);
  const stagingRoot = resolveInside(repository, journal.staging_root);
  const mirrorStaging = resolveInside(repository, journal.mirror_staging);
  const mirrorBackup = resolveInside(repository, journal.mirror_backup);
  const targetPresent = Boolean(lstatIfPresent(targetRoot));
  const stagingPresent = Boolean(lstatIfPresent(stagingRoot));
  const mirrorStagingPresent = Boolean(lstatIfPresent(mirrorStaging));
  const stagingComplete = stagingPresent
    && Boolean(lstatIfPresent(path.join(stagingRoot, 'spec.md')))
    && Boolean(lstatIfPresent(path.join(stagingRoot, 'work.json')));

  if (targetPresent) validateCreationRoot(targetRoot, canonicalSpec, workId, digest);
  else if (stagingComplete) validateCreationRoot(stagingRoot, canonicalSpec, workId, digest);

  if (!targetPresent && (!stagingComplete || !mirrorStagingPresent)) {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    fs.rmSync(mirrorStaging, { force: true });
    restoreMirrorBackup(pairFile, mirrorBackup);
    fs.rmSync(journalFile, { force: true });
    return false;
  }
  if (!targetPresent) fs.renameSync(stagingRoot, targetRoot);

  if (lstatIfPresent(mirrorStaging)) {
    if (lstatIfPresent(pairFile) && fs.readFileSync(pairFile, 'utf8') !== mirror) {
      if (lstatIfPresent(mirrorBackup)) {
        throw new Error(`incomplete Work ${workId} has conflicting active and backup mirrors`);
      }
      fs.renameSync(pairFile, mirrorBackup);
    }
    if (!lstatIfPresent(pairFile)) fs.renameSync(mirrorStaging, pairFile);
    else fs.rmSync(mirrorStaging, { force: true });
  }

  if (!lstatIfPresent(pairFile) || fs.readFileSync(pairFile, 'utf8') !== mirror) {
    fs.rmSync(targetRoot, { recursive: true, force: true });
    restoreMirrorBackup(pairFile, mirrorBackup);
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    fs.rmSync(mirrorStaging, { force: true });
    fs.rmSync(journalFile, { force: true });
    return false;
  }

  fs.rmSync(stagingRoot, { recursive: true, force: true });
  fs.rmSync(mirrorBackup, { force: true });
  fs.rmSync(journalFile, { force: true });
  return true;
}

function prepareWorkCreation(repository, workId, canonicalSpec) {
  const relativeSpec = `docs/work/${workId}/spec.md`;
  const digest = sha256(canonicalSpec);
  const work = {
    schema: 1,
    work_id: workId,
    title: specTitle(canonicalSpec, workId),
    status: 'design-approved',
    spec: { path: relativeSpec, sha256: digest },
    active_pair_mirror: '.pair/spec.md',
    engineering_quality_contract: {
      path: relativeSpec,
      section: 'Engineering Quality Contract',
      status: 'approved',
    },
    decision_records: [],
    decision_supersessions: [],
    changes: [],
    outcomes: [],
    evidence_records: [],
  };
  validatePersistedWork(work, workId);
  return {
    workId,
    canonicalSpec,
    digest,
    work,
    mirror: [
      '<!-- GENERATED ACTIVE MIRROR',
      `Canonical: ${relativeSpec}`,
      `Canonical SHA-256: ${digest}`,
      '-->',
      canonicalSpec,
    ].join('\n'),
    targetRoot: workRoot(repository, workId),
    journalFile: resolveInside(repository, '.pair', `.work-lineage-${workId}.transaction.json`),
  };
}

function workCreationResult(creation) {
  return { workId: creation.workId, path: creation.targetRoot, spec: creation.work.spec };
}

function existingCanonicalSpec(root, workId) {
  const specFile = path.join(root, 'spec.md');
  assertSafeExistingFile(specFile, `Work ${workId} canonical spec`);
  const canonicalSpec = fs.readFileSync(specFile, 'utf8');
  validateCreationRoot(root, canonicalSpec, workId, sha256(canonicalSpec));
  return canonicalSpec;
}

function workIdCollisionSuffix(canonicalSpec) {
  const schema = WORK_SCHEMA.$defs.work_id_collision_suffix;
  const suffix = sha256(canonicalSpec).slice(0, schema.maxLength);
  if (schema.minLength !== schema.maxLength || !new RegExp(schema.pattern).test(suffix)) {
    throw new Error('Work ID collision suffix schema is inconsistent');
  }
  return suffix;
}

function createWorkRoot({ repositoryRoot, workId, canonicalSpec }) {
  const repository = repositoryRootPath(repositoryRoot);
  const normalizedWorkId = workIdentifier(workId);
  if (typeof canonicalSpec !== 'string' || !canonicalSpec.trim()) {
    throw new TypeError('canonicalSpec is required');
  }
  if (canonicalSpec.length > 2_000_000) {
    throw new RangeError('canonicalSpec must be at most 2000000 characters');
  }
  const declaredWorkId = parseSpecWorkId(canonicalSpec);
  if (declaredWorkId !== normalizedWorkId) {
    throw new TypeError(`Work ID ${normalizedWorkId} does not match canonical spec Work ID ${declaredWorkId || 'missing'}`);
  }
  assertEngineeringQualityContractContent(canonicalSpec);

  const workParent = resolveInside(repository, 'docs', 'work');
  const pairFile = resolveInside(repository, '.pair', 'spec.md');
  workRoot(repository, normalizedWorkId);
  fs.mkdirSync(workParent, { recursive: true });
  fs.mkdirSync(path.dirname(pairFile), { recursive: true });
  resolveInside(repository, 'docs', 'work');
  resolveInside(repository, '.pair', 'spec.md');
  const createLockFile = resolveInside(repository, '.pair', '.work-lineage-create.lock');
  const createReclaimFile = resolveInside(repository, '.pair', '.work-lineage-create.lock.reclaim');
  return withExclusiveLock(createLockFile, createReclaimFile, 'Work creation', () => {
    let creation = prepareWorkCreation(repository, normalizedWorkId, canonicalSpec);
    if (recoverWorkCreation({
      repository,
      workId: creation.workId,
      canonicalSpec: creation.canonicalSpec,
      digest: creation.digest,
      mirror: creation.mirror,
      pairFile,
      targetRoot: creation.targetRoot,
      journalFile: creation.journalFile,
    })) {
      return workCreationResult(creation);
    }
    if (lstatIfPresent(creation.targetRoot)) {
      const existingSpec = existingCanonicalSpec(creation.targetRoot, creation.workId);
      if (existingSpec === canonicalSpec) {
        throw new Error(`Work ${normalizedWorkId} already exists`);
      }
      const collisionWorkId = workIdentifier(
        `${normalizedWorkId}-${workIdCollisionSuffix(canonicalSpec)}`,
      );
      creation = prepareWorkCreation(
        repository,
        collisionWorkId,
        canonicalSpecWithWorkId(canonicalSpec, collisionWorkId),
      );
      if (recoverWorkCreation({
        repository,
        workId: creation.workId,
        canonicalSpec: creation.canonicalSpec,
        digest: creation.digest,
        mirror: creation.mirror,
        pairFile,
        targetRoot: creation.targetRoot,
        journalFile: creation.journalFile,
      })) {
        return workCreationResult(creation);
      }
      if (lstatIfPresent(creation.targetRoot)) {
        const existingCollisionSpec = existingCanonicalSpec(creation.targetRoot, creation.workId);
        const qualifier = existingCollisionSpec === creation.canonicalSpec
          ? 'already exists'
          : 'already exists with different approved content';
        throw new Error(`Work ${creation.workId} collision suffix ${qualifier}`);
      }
    }

    const transaction = crypto.randomUUID();
    const stagingRoot = resolveInside(repository, 'docs', 'work', `.${creation.workId}.${transaction}.staging`);
    const mirrorStaging = resolveInside(repository, '.pair', `.spec.${transaction}.staging`);
    const mirrorBackup = resolveInside(repository, '.pair', `.spec.${transaction}.backup`);
    let workPublished = false;
    let mirrorBackedUp = false;
    let mirrorPublished = false;
    try {
      atomicJson(repository, creation.journalFile, {
      schema: 1,
      work_id: creation.workId,
      spec_sha256: creation.digest,
      target_root: toPosix(path.relative(repository, creation.targetRoot)),
      staging_root: toPosix(path.relative(repository, stagingRoot)),
      mirror_staging: toPosix(path.relative(repository, mirrorStaging)),
      mirror_backup: toPosix(path.relative(repository, mirrorBackup)),
      });
      fs.mkdirSync(stagingRoot, { recursive: false, mode: 0o755 });
      atomicWrite(repository, path.join(stagingRoot, 'spec.md'), creation.canonicalSpec);
      atomicJson(repository, path.join(stagingRoot, 'work.json'), creation.work);
      atomicWrite(repository, mirrorStaging, creation.mirror);

      if (lstatIfPresent(pairFile)) {
        resolveInside(repository, '.pair', 'spec.md');
        fs.renameSync(pairFile, mirrorBackup);
        mirrorBackedUp = true;
      }
      fs.renameSync(stagingRoot, creation.targetRoot);
      workPublished = true;
      fs.renameSync(mirrorStaging, pairFile);
      mirrorPublished = true;
      if (mirrorBackedUp) fs.rmSync(mirrorBackup, { force: true });
      fs.rmSync(creation.journalFile, { force: true });
    } catch (error) {
      if (workPublished) fs.rmSync(creation.targetRoot, { recursive: true, force: true });
      fs.rmSync(stagingRoot, { recursive: true, force: true });
      const stagedMirrorWasPublished = !lstatIfPresent(mirrorStaging)
        && lstatIfPresent(pairFile)
        && fs.readFileSync(pairFile, 'utf8') === creation.mirror;
      if (mirrorPublished || stagedMirrorWasPublished) fs.rmSync(pairFile, { force: true });
      fs.rmSync(mirrorStaging, { force: true });
      if ((mirrorBackedUp || lstatIfPresent(mirrorBackup)) && lstatIfPresent(mirrorBackup)) {
        fs.renameSync(mirrorBackup, pairFile);
      }
      fs.rmSync(creation.journalFile, { force: true });
      throw error;
    }
    return workCreationResult(creation);
  });
}

function normalizeDecisionRecord(value) {
  assertSchemaObject(value, DECISION_SCHEMA, 'Decision Record');
  if (value.schema !== 1) throw new TypeError('Decision Record schema must be 1');
  if (value.status !== 'accepted') throw new TypeError('Decision Record status must be accepted');
  if (value.supersededBy !== null) {
    throw new TypeError('Decision Record supersededBy must be null; a later successor derives the reverse link');
  }
  return {
    schema: 1,
    id: identifier(value.id, 'Decision Record id', DECISION_ID_PATTERN),
    status: 'accepted',
    workId: workIdentifier(value.workId, 'Decision Record Work ID'),
    title: requiredText(value.title, 'Decision Record title', 200),
    originSpec: requiredText(value.originSpec, 'Decision Record originSpec', 1_000),
    acceptanceCriteria: identifierList(
      value.acceptanceCriteria,
      'Decision Record acceptanceCriteria',
      ACCEPTANCE_CRITERION_PATTERN,
      { minimum: 1 },
    ),
    context: requiredText(value.context, 'Decision Record context', 20_000),
    decision: requiredText(value.decision, 'Decision Record decision', 20_000),
    rationale: requiredText(value.rationale, 'Decision Record rationale', 20_000),
    alternatives: textList(value.alternatives, 'Decision Record alternatives', { minimum: 1, itemLength: 10_000 }),
    consequences: textList(value.consequences, 'Decision Record consequences', { minimum: 1, itemLength: 10_000 }),
    evidence: textList(value.evidence, 'Decision Record evidence', { itemLength: 1_000 }),
    changes: textList(value.changes, 'Decision Record changes', { itemLength: 1_000 }),
    supersedes: value.supersedes == null
      ? null
      : identifier(value.supersedes, 'Decision Record supersedes', DECISION_ID_PATTERN),
    supersededBy: null,
  };
}

function markdownValues(values) {
  return values.length > 0 ? values.map(value => `\`${value}\``).join(', ') : 'none';
}

function markdownBullets(values) {
  return values.length > 0 ? values.map(value => `- ${value}`).join('\n') : 'None.';
}

function renderDecisionRecord(record) {
  const displayId = record.id.match(/^DR-\d{3}/)[0];
  return [
    `# ${displayId}: ${record.title}`,
    '',
    `- **Schema:** ${record.schema}`,
    `- **Status:** ${record.status}`,
    `- **Work ID:** \`${record.workId}\``,
    `- **Origin Spec:** \`${record.originSpec}\``,
    `- **Acceptance Criteria:** ${markdownValues(record.acceptanceCriteria)}`,
    `- **Supersedes:** ${record.supersedes ? `\`${record.supersedes}\`` : 'none'}`,
    '- **Superseded By:** none',
    '',
    '## Context',
    '',
    record.context,
    '',
    '## Decision',
    '',
    record.decision,
    '',
    '## Rationale',
    '',
    record.rationale,
    '',
    '## Alternatives Rejected',
    '',
    markdownBullets(record.alternatives),
    '',
    '## Consequences',
    '',
    markdownBullets(record.consequences),
    '',
    '## Evidence',
    '',
    markdownBullets(record.evidence),
    '',
    '## Implementation',
    '',
    markdownBullets(record.changes),
    '',
  ].join('\n');
}

function writeImmutableRecord(repositoryRoot, file, contents, label) {
  const target = resolveInside(repositoryRoot, path.relative(repositoryRoot, file));
  if (lstatIfPresent(target)) {
    assertSafeExistingFile(target, label);
    if (fs.readFileSync(target, 'utf8') === contents) return false;
    throw new Error(`${label} is accepted and immutable`);
  }
  atomicWrite(repositoryRoot, target, contents);
  return true;
}

function expectedDecisionReference(workId, decisionId) {
  return `docs/work/${workId}/decisions/${decisionId}.md`;
}

function assertDecisionReferencesExist(state, decisionRecordIds, label) {
  for (const decisionId of decisionRecordIds) {
    const reference = expectedDecisionReference(state.work.work_id, decisionId);
    if (!state.work.decision_records.includes(reference)) {
      throw new Error(`${label} references missing Decision Record ${decisionId}`);
    }
    assertSafeExistingFile(resolveInside(state.repositoryRoot, reference), `Decision Record ${decisionId}`);
  }
}

function writeDecisionRecord({ repositoryRoot, record }) {
  const normalized = normalizeDecisionRecord(record);
  return withWorkLock(repositoryRoot, normalized.workId, state => {
    if (normalized.originSpec !== state.work.spec.path) {
      throw new TypeError('Decision Record originSpec must match the canonical Work spec');
    }
    if (normalized.supersedes === normalized.id) throw new TypeError('Decision Record cannot supersede itself');
    if (normalized.supersedes) {
      assertDecisionReferencesExist(state, [normalized.supersedes], `Decision Record ${normalized.id}`);
      const existing = state.work.decision_supersessions.find(
        relation => relation.predecessor === normalized.supersedes && relation.successor !== normalized.id,
      );
      if (existing) {
        throw new Error(`Decision Record ${normalized.supersedes} is already superseded by ${existing.successor}`);
      }
    }

    const file = resolveInside(state.repositoryRoot, 'docs', 'work', normalized.workId, 'decisions', `${normalized.id}.md`);
    writeImmutableRecord(state.repositoryRoot, file, renderDecisionRecord(normalized), `Decision Record ${normalized.id}`);
    appendIndexReferenceLocked(state, 'decision_records', file);
    if (normalized.supersedes) {
      const relation = { predecessor: normalized.supersedes, successor: normalized.id };
      if (!state.work.decision_supersessions.some(item => (
        item.predecessor === relation.predecessor && item.successor === relation.successor
      ))) {
        state.work.decision_supersessions.push(relation);
        state.work.decision_supersessions.sort((left, right) => (
          `${left.predecessor}\0${left.successor}`.localeCompare(`${right.predecessor}\0${right.successor}`)
        ));
      }
    }
    persistWork(state);
    return { ...normalized, path: file };
  });
}

function normalizeOutcome(value) {
  assertObject(value, 'outcome record');
  rejectUnknown(value, [
    'schema', 'id', 'workId', 'decisionRecordIds', 'source', 'result', 'evidence', 'recordedAt',
  ], 'outcome record');
  for (const field of ['schema', 'id', 'workId', 'decisionRecordIds', 'source', 'result', 'evidence', 'recordedAt']) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) throw new TypeError(`outcome record.${field} is required`);
  }
  if (value.schema !== 1) throw new TypeError('outcome record schema must be 1');
  return {
    schema: 1,
    id: identifier(value.id, 'outcome record id', OUTCOME_ID_PATTERN),
    workId: workIdentifier(value.workId, 'outcome record Work ID'),
    decisionRecordIds: identifierList(
      value.decisionRecordIds,
      'outcome record decisionRecordIds',
      DECISION_ID_PATTERN,
      { minimum: 1 },
    ),
    source: requiredText(value.source, 'outcome record source', 80),
    result: requiredText(value.result, 'outcome record result', 200),
    evidence: textList(value.evidence, 'outcome record evidence', { itemLength: 1_000 }),
    recordedAt: timestamp(value.recordedAt, 'outcome record recordedAt'),
  };
}

function renderOutcomeRecord(record) {
  return [
    `# ${record.id}: ${record.result}`,
    '',
    `- **Schema:** ${record.schema}`,
    `- **Work ID:** \`${record.workId}\``,
    `- **Decision Records:** ${markdownValues(record.decisionRecordIds)}`,
    `- **Source:** ${record.source}`,
    `- **Result:** ${record.result}`,
    `- **Evidence:** ${markdownValues(record.evidence)}`,
    `- **Recorded At:** ${record.recordedAt}`,
    '',
  ].join('\n');
}

function appendOutcomeRecord({ repositoryRoot, outcome }) {
  const normalized = normalizeOutcome(outcome);
  return withWorkLock(repositoryRoot, normalized.workId, state => {
    assertDecisionReferencesExist(state, normalized.decisionRecordIds, `outcome record ${normalized.id}`);
    const file = resolveInside(state.repositoryRoot, 'docs', 'work', normalized.workId, 'outcomes', `${normalized.id}.md`);
    writeImmutableRecord(state.repositoryRoot, file, renderOutcomeRecord(normalized), `outcome record ${normalized.id}`);
    appendIndexReferenceLocked(state, 'outcomes', file);
    persistWork(state);
    return { ...normalized, path: file };
  });
}

function normalizeEvidence(value) {
  assertObject(value, 'evidence record');
  rejectUnknown(value, [
    'schema', 'id', 'workId', 'kind', 'acceptanceCriteria', 'decisionRecordIds', 'source',
    'recordedAt', 'result',
  ], 'evidence record');
  for (const field of [
    'schema', 'id', 'workId', 'kind', 'acceptanceCriteria', 'decisionRecordIds', 'source', 'recordedAt', 'result',
  ]) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) throw new TypeError(`evidence record.${field} is required`);
  }
  if (value.schema !== 1) throw new TypeError('evidence record schema must be 1');
  assertObject(value.result, 'evidence record result');
  return {
    schema: 1,
    id: identifier(value.id, 'evidence record id', EVIDENCE_ID_PATTERN),
    workId: workIdentifier(value.workId, 'evidence record Work ID'),
    kind: requiredText(value.kind, 'evidence record kind', 100),
    acceptanceCriteria: identifierList(
      value.acceptanceCriteria,
      'evidence record acceptanceCriteria',
      ACCEPTANCE_CRITERION_PATTERN,
      { minimum: 1 },
    ),
    decisionRecordIds: identifierList(
      value.decisionRecordIds,
      'evidence record decisionRecordIds',
      DECISION_ID_PATTERN,
    ),
    source: requiredText(value.source, 'evidence record source', 100),
    recordedAt: timestamp(value.recordedAt, 'evidence record recordedAt'),
    result: value.result,
  };
}

function persistedEvidence(record) {
  return {
    schema: record.schema,
    id: record.id,
    work_id: record.workId,
    kind: record.kind,
    acceptance_criteria: record.acceptanceCriteria,
    decision_record_ids: record.decisionRecordIds,
    source: record.source,
    recorded_at: record.recordedAt,
    result: record.result,
  };
}

function validatePersistedEvidence(value) {
  assertSchemaObject(value, EVIDENCE_SCHEMA, 'evidence file');
  if (value.schema !== 1) throw new TypeError('evidence file schema must be 1');
  identifier(value.id, 'evidence file id', EVIDENCE_ID_PATTERN, true);
  workIdentifier(value.work_id, 'evidence file Work ID', true);
  requiredText(value.kind, 'evidence file kind', 100, true);
  identifierList(
    value.acceptance_criteria,
    'evidence file acceptance_criteria',
    ACCEPTANCE_CRITERION_PATTERN,
    { minimum: 1, exact: true },
  );
  identifierList(
    value.decision_record_ids,
    'evidence file decision_record_ids',
    DECISION_ID_PATTERN,
    { exact: true },
  );
  requiredText(value.source, 'evidence file source', 100, true);
  timestamp(value.recorded_at, 'evidence file recorded_at', true);
  assertObject(value.result, 'evidence file result');
  return value;
}

function appendEvidenceRecord({ repositoryRoot, record }) {
  const normalized = normalizeEvidence(record);
  const persisted = persistedEvidence(normalized);
  validatePersistedEvidence(persisted);
  return withWorkLock(repositoryRoot, normalized.workId, state => {
    assertDecisionReferencesExist(state, normalized.decisionRecordIds, `evidence record ${normalized.id}`);
    const file = resolveInside(state.repositoryRoot, 'docs', 'work', normalized.workId, 'evidence', `${normalized.id}.json`);
    const contents = `${JSON.stringify(persisted, null, 2)}\n`;
    writeImmutableRecord(state.repositoryRoot, file, contents, `evidence record ${normalized.id}`);
    appendIndexReferenceLocked(state, 'evidence_records', file);
    persistWork(state);
    return { ...normalized, path: file };
  });
}

function normalizeChange(value) {
  assertObject(value, 'change record');
  rejectUnknown(value, [
    'schema', 'id', 'workId', 'acceptanceCriteria', 'decisionRecordIds', 'summary', 'files', 'recordedAt',
  ], 'change record');
  for (const field of [
    'schema', 'id', 'workId', 'acceptanceCriteria', 'decisionRecordIds', 'summary', 'files', 'recordedAt',
  ]) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) throw new TypeError(`change record.${field} is required`);
  }
  if (value.schema !== 1) throw new TypeError('change record schema must be 1');
  return {
    schema: 1,
    id: identifier(value.id, 'change record id', CHANGE_ID_PATTERN),
    workId: workIdentifier(value.workId, 'change record Work ID'),
    acceptanceCriteria: identifierList(
      value.acceptanceCriteria,
      'change record acceptanceCriteria',
      ACCEPTANCE_CRITERION_PATTERN,
      { minimum: 1 },
    ),
    decisionRecordIds: identifierList(value.decisionRecordIds, 'change record decisionRecordIds', DECISION_ID_PATTERN),
    summary: requiredText(value.summary, 'change record summary', 1_000),
    files: textList(value.files, 'change record files', { itemLength: 1_000 }),
    recordedAt: timestamp(value.recordedAt, 'change record recordedAt'),
  };
}

function persistedChange(record) {
  return {
    schema: record.schema,
    id: record.id,
    work_id: record.workId,
    acceptance_criteria: record.acceptanceCriteria,
    decision_record_ids: record.decisionRecordIds,
    summary: record.summary,
    files: record.files,
    recorded_at: record.recordedAt,
  };
}

function validatePersistedChange(value) {
  assertObject(value, 'change file');
  rejectUnknown(value, [
    'schema', 'id', 'work_id', 'acceptance_criteria', 'decision_record_ids', 'summary', 'files', 'recorded_at',
  ], 'change file');
  for (const field of [
    'schema', 'id', 'work_id', 'acceptance_criteria', 'decision_record_ids', 'summary', 'files', 'recorded_at',
  ]) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) throw new TypeError(`change file.${field} is required`);
  }
  if (value.schema !== 1) throw new TypeError('change file schema must be 1');
  identifier(value.id, 'change file id', CHANGE_ID_PATTERN, true);
  workIdentifier(value.work_id, 'change file Work ID', true);
  identifierList(value.acceptance_criteria, 'change file acceptance_criteria', ACCEPTANCE_CRITERION_PATTERN, {
    minimum: 1,
    exact: true,
  });
  identifierList(value.decision_record_ids, 'change file decision_record_ids', DECISION_ID_PATTERN, { exact: true });
  requiredText(value.summary, 'change file summary', 1_000, true);
  textList(value.files, 'change file files', { itemLength: 1_000, exact: true });
  timestamp(value.recorded_at, 'change file recorded_at', true);
  return value;
}

function appendChangeRecord({ repositoryRoot, record }) {
  const normalized = normalizeChange(record);
  const persisted = persistedChange(normalized);
  validatePersistedChange(persisted);
  return withWorkLock(repositoryRoot, normalized.workId, state => {
    assertDecisionReferencesExist(state, normalized.decisionRecordIds, `change record ${normalized.id}`);
    const file = resolveInside(state.repositoryRoot, 'docs', 'work', normalized.workId, 'changes', `${normalized.id}.json`);
    writeImmutableRecord(
      state.repositoryRoot,
      file,
      `${JSON.stringify(persisted, null, 2)}\n`,
      `change record ${normalized.id}`,
    );
    appendIndexReferenceLocked(state, 'changes', file);
    persistWork(state);
    return { ...normalized, path: file };
  });
}

function normalizeObligation(value, index) {
  const label = `obligations[${index}]`;
  assertSchemaObject(value, QUALITY_SCHEMA.$defs.obligation, label);
  const activation = requiredText(value.activation, `${label}.activation`, 20);
  if (!['always', 'fact'].includes(activation)) throw new TypeError(`${label}.activation is unsupported`);
  const activationFacts = identifierList(value.activationFacts, `${label}.activationFacts`, FACT_PATTERN);
  if (activation === 'always' && activationFacts.length !== 0) {
    throw new TypeError(`${label}.activationFacts must be empty for always activation`);
  }
  if (activation === 'fact' && activationFacts.length === 0) {
    throw new TypeError(`${label}.activationFacts must contain at least one fact`);
  }
  const impact = requiredText(value.impact, `${label}.impact`, 40);
  if (!['ordinary', 'high'].includes(impact)) throw new TypeError(`${label}.impact is unsupported`);
  const status = requiredText(value.status, `${label}.status`, 40);
  if (!['inactive', 'active', 'open', 'not_applicable'].includes(status)) {
    throw new TypeError(`${label}.status is unsupported`);
  }
  const quality = requiredText(value.quality, `${label}.quality`, 80).toLowerCase();
  return {
    id: identifier(value.id, `${label}.id`, OBLIGATION_ID_PATTERN),
    quality: identifier(quality, `${label}.quality`, FACT_PATTERN),
    activation,
    activationFacts,
    impact,
    owner: requiredText(value.owner, `${label}.owner`, 200),
    status,
  };
}

function normalizeExclusion(value, index) {
  const label = `exclusions[${index}]`;
  assertSchemaObject(value, QUALITY_SCHEMA.$defs.exclusion, label);
  const status = requiredText(value.status, `${label}.status`, 40);
  if (status !== 'not_applicable') throw new TypeError(`${label}.status must be not_applicable`);
  assertSchemaObject(value.approval, QUALITY_SCHEMA.$defs.approval, `${label}.approval`);
  const state = requiredText(value.approval.state, `${label}.approval.state`, 40);
  if (!['approved', 'pending', 'rejected'].includes(state)) {
    throw new TypeError(`${label}.approval.state is unsupported`);
  }
  return {
    obligationId: identifier(value.obligationId, `${label}.obligationId`, OBLIGATION_ID_PATTERN),
    status,
    evidence: textList(value.evidence, `${label}.evidence`, { minimum: 1, itemLength: 1_000 }),
    decider: requiredText(value.decider, `${label}.decider`, 200),
    reviewer: requiredText(value.reviewer, `${label}.reviewer`, 200),
    owner: requiredText(value.owner, `${label}.owner`, 200),
    residualRisk: requiredText(value.residualRisk, `${label}.residualRisk`, 1_000),
    approval: {
      state,
      approvedBy: requiredText(value.approval.approvedBy, `${label}.approval.approvedBy`, 200),
      provenanceId: identifier(
        value.approval.provenanceId,
        `${label}.approval.provenanceId`,
        APPROVAL_PROVENANCE_ID_PATTERN,
      ),
    },
  };
}

function pendingExclusion(exclusion, state) {
  return { ...exclusion, state };
}

function verifiedApproval(approval, verifyApproval) {
  if (typeof verifyApproval !== 'function') return { state: 'approval_provenance_required', value: null };
  const submitted = Object.freeze({ ...approval });
  const verified = verifyApproval(submitted);
  if (verified == null) return { state: 'approval_provenance_required', value: null };
  assertObject(verified, 'verified approval provenance');
  rejectUnknown(verified, ['approvedBy', 'authority', 'domain'], 'verified approval provenance');
  const approvedBy = requiredText(verified.approvedBy, 'verified approval provenance.approvedBy', 200);
  const authority = requiredText(verified.authority, 'verified approval provenance.authority', 80);
  if (!APPROVAL_AUTHORITIES.has(authority)) {
    throw new TypeError('verified approval provenance.authority is unsupported');
  }
  const domain = optionalText(verified.domain, 'verified approval provenance.domain', 80)?.toLowerCase() || null;
  if (domain && !PROTECTED_DOMAINS.has(domain)) {
    throw new TypeError('verified approval provenance.domain is unsupported');
  }
  if (approvedBy !== approval.approvedBy) return { state: 'approval_provenance_mismatch', value: null };
  return { state: 'verified', value: { approvedBy, authority, domain } };
}

function assertUniqueBy(items, selector, label) {
  const seen = new Set();
  for (const item of items) {
    const key = selector(item);
    if (seen.has(key)) throw new TypeError(`duplicate ${label} key ${key}`);
    seen.add(key);
  }
}

function evaluateQualityContract(input, options = {}) {
  assertSchemaObject(input, QUALITY_SCHEMA, 'Engineering Quality Contract');
  const normalizedWorkId = workIdentifier(input.workId, 'Engineering Quality Contract Work ID');
  const normalizedFacts = identifierList(input.facts, 'facts', FACT_PATTERN);
  if (!Array.isArray(input.obligations) || input.obligations.length === 0) {
    throw new TypeError('obligations must contain at least one item');
  }
  if (!Array.isArray(input.exclusions)) throw new TypeError('exclusions must be an array');
  const normalizedObligations = input.obligations.map(normalizeObligation);
  const normalizedExclusions = input.exclusions.map(normalizeExclusion);
  assertUniqueBy(normalizedObligations, item => item.id, 'obligations');
  assertUniqueBy(normalizedExclusions, item => item.obligationId, 'exclusions');
  const obligationIds = new Set(normalizedObligations.map(item => item.id));
  const unknown = normalizedExclusions.find(item => !obligationIds.has(item.obligationId));
  if (unknown) throw new TypeError(`exclusion targets unknown obligation ${unknown.obligationId}`);
  const exclusionsByObligation = new Map(normalizedExclusions.map(item => [item.obligationId, item]));

  const evaluated = normalizedObligations.map(obligation => {
    const activatedBy = obligation.activationFacts.filter(fact => normalizedFacts.includes(fact));
    const alreadyActive = obligation.status !== 'inactive';
    const active = obligation.activation === 'always' || alreadyActive || activatedBy.length > 0;
    if (!active) return { ...obligation, status: 'inactive', activatedBy: [] };

    const exclusion = exclusionsByObligation.get(obligation.id);
    if (!exclusion) return { ...obligation, status: 'open', activatedBy };
    if (exclusion.approval.state !== 'approved') {
      return {
        ...obligation,
        status: 'open',
        activatedBy,
        exclusion: pendingExclusion(exclusion, 'approval_required'),
      };
    }

    const provenance = verifiedApproval(exclusion.approval, options.verifyApproval);
    if (!provenance.value) {
      return {
        ...obligation,
        status: 'open',
        activatedBy,
        exclusion: pendingExclusion(exclusion, provenance.state),
      };
    }
    if (provenance.value.authority === 'automation') {
      return {
        ...obligation,
        status: 'open',
        activatedBy,
        exclusion: pendingExclusion(exclusion, 'human_approval_required'),
      };
    }

    const protectedHighImpact = obligation.impact === 'high' && PROTECTED_DOMAINS.has(obligation.quality);
    if (protectedHighImpact) {
      const matchingAuthority = ['CODEOWNER', 'domain_owner'].includes(provenance.value.authority)
        && provenance.value.domain === obligation.quality;
      if (!matchingAuthority) {
        return {
          ...obligation,
          status: 'open',
          activatedBy,
          exclusion: pendingExclusion(exclusion, 'domain_approval_required'),
        };
      }
    } else if (provenance.value.authority !== 'user') {
      return {
        ...obligation,
        status: 'open',
        activatedBy,
        exclusion: pendingExclusion(exclusion, 'user_approval_required'),
      };
    }

    return {
      ...obligation,
      status: 'not_applicable',
      activatedBy,
      exclusion: pendingExclusion(exclusion, 'approved'),
    };
  });

  return {
    workId: normalizedWorkId,
    facts: normalizedFacts,
    obligations: evaluated,
    canClose: evaluated.every(obligation => obligation.status !== 'open'),
  };
}

function validateEvidenceFile(file) {
  const resolved = assertSafeExistingFile(file, 'evidence file');
  return validatePersistedEvidence(parseJsonFile(resolved, 'evidence file'));
}

function parseMarkdownIdentifier(value, label, pattern) {
  const match = requiredText(value, label, 1_000).match(/^`([^`]+)`$|^([^`\s]+)$/);
  if (!match) throw new TypeError(`${label} has invalid Markdown identifier syntax`);
  return identifier(match[1] || match[2], label, pattern, true);
}

function parseMarkdownIdentifierList(value, label, pattern) {
  const tokens = requiredText(value, label, 10_000).split(',').map(token => token.trim());
  const identifiers = tokens.map(token => parseMarkdownIdentifier(token, label, pattern));
  if (new Set(identifiers).size !== identifiers.length) throw new TypeError(`${label} contains duplicate identifiers`);
  return identifiers;
}

function parseAcceptanceCriteria(value, label) {
  const normalized = requiredText(value, label, 10_000);
  const range = normalized.match(/^`?(AC-[1-9][0-9]*)`?\s+through\s+`?(AC-[1-9][0-9]*)`?$/);
  if (range) {
    if (range[1] === range[2]) throw new TypeError(`${label} contains duplicate identifiers`);
    return [range[1], range[2]];
  }
  return parseMarkdownIdentifierList(normalized, label, ACCEPTANCE_CRITERION_PATTERN);
}

function validateDecisionMarkdown(file, workId, decisionId, originSpec) {
  assertSafeExistingFile(file, `Decision Record ${decisionId}`);
  const contents = fs.readFileSync(file, 'utf8');
  const displayId = decisionId.match(/^DR-\d{3}/)?.[0] || decisionId;
  const semanticHeadings = [
    'Context',
    'Decision',
    'Rationale',
    'Alternatives Rejected',
    'Consequences',
    'Evidence',
  ];
  const required = [
    new RegExp(`^# (?:${escapeRegularExpression(decisionId)}|${escapeRegularExpression(displayId)}): .+$`, 'm'),
    new RegExp(`^- \\*\\*Work ID:\\*\\* \`${escapeRegularExpression(workId)}\`$`, 'm'),
    new RegExp(`^- \\*\\*Origin Spec:\\*\\* \`${escapeRegularExpression(originSpec)}\`$`, 'm'),
    ...semanticHeadings.map(heading => new RegExp(`^## ${escapeRegularExpression(heading)}$`, 'm')),
  ];
  if (required.some(pattern => !pattern.test(contents))) {
    throw new TypeError(`Decision Record ${decisionId} is missing required semantic sections`);
  }
  if (!/^- \*\*Schema:\*\* 1$/m.test(contents) || !/^- \*\*Status:\*\* accepted$/m.test(contents)) {
    throw new TypeError(`Decision Record ${decisionId} must be an accepted schema 1 record`);
  }
  for (const heading of semanticHeadings) {
    if (!markdownSectionBody(contents, heading)) {
      throw new TypeError(`Decision Record ${decisionId} ${heading} section must contain content`);
    }
  }
  const acceptanceLine = contents.match(/^- \*\*Acceptance Criteria:\*\* (.+)$/m)?.[1] || '';
  parseAcceptanceCriteria(acceptanceLine, `Decision Record ${decisionId} Acceptance Criteria`);
  const supersedesValue = contents.match(/^- \*\*Supersedes:\*\* (.+)$/m)?.[1];
  if (!supersedesValue) throw new TypeError(`Decision Record ${decisionId} Supersedes metadata is required`);
  const supersedes = supersedesValue === 'none'
    ? null
    : parseMarkdownIdentifier(supersedesValue, `Decision Record ${decisionId} Supersedes`, DECISION_ID_PATTERN);
  const supersededBy = contents.match(/^- \*\*Superseded By:\*\* (.+)$/m)?.[1];
  if (supersededBy !== 'none') {
    throw new TypeError(`Decision Record ${decisionId} must derive reverse supersession from its successor`);
  }
  return { contents, supersedes };
}

function validateOutcomeMarkdown(file, workId, outcomeId, decisionIds) {
  assertSafeExistingFile(file, `outcome record ${outcomeId}`);
  const contents = fs.readFileSync(file, 'utf8');
  const schema = contents.match(/^- \*\*Schema:\*\* (.+)$/m)?.[1];
  const decisionLine = contents.match(/^- \*\*Decision Records:\*\* (.+)$/m)?.[1] || '';
  const source = contents.match(/^- \*\*Source:\*\* (.+)$/m)?.[1];
  const result = contents.match(/^- \*\*Result:\*\* (.+)$/m)?.[1];
  const evidence = contents.match(/^- \*\*Evidence:\*\* (.+)$/m)?.[1];
  const recordedAt = contents.match(/^- \*\*Recorded At:\*\* (.+)$/m)?.[1] || '';
  if (!contents.startsWith(`# ${outcomeId}:`)
      || !contents.includes(`- **Work ID:** \`${workId}\``)
      || schema !== '1'
      || !source?.trim()
      || !result?.trim()
      || !evidence?.trim()) {
    throw new TypeError(`outcome record ${outcomeId} is malformed`);
  }
  const linkedDecisions = parseMarkdownIdentifierList(
    decisionLine,
    `outcome record ${outcomeId} Decision Records`,
    DECISION_ID_PATTERN,
  );
  timestamp(recordedAt, `outcome record ${outcomeId} recordedAt`, true);
  for (const decisionId of linkedDecisions) {
    identifier(decisionId, `outcome record ${outcomeId} Decision Record`, DECISION_ID_PATTERN, true);
    if (!decisionIds.has(decisionId)) {
      throw new Error(`outcome record ${outcomeId} references missing Decision Record ${decisionId}`);
    }
  }
  return contents;
}

function referenceId(reference) {
  return path.basename(reference, path.extname(reference));
}

function assertNoUnindexedArtifacts(repositoryRoot, work) {
  const artifactKinds = [
    { directory: 'decisions', field: 'decision_records', pattern: /^DR-\d{3}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/, label: 'Decision Record' },
    { directory: 'outcomes', field: 'outcomes', pattern: /^OUT-\d{3}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/, label: 'outcome' },
    { directory: 'evidence', field: 'evidence_records', pattern: /^EVD-\d{3}-[a-z0-9]+(?:-[a-z0-9]+)*\.json$/, label: 'evidence' },
    { directory: 'changes', field: 'changes', pattern: /^CHG-\d{3}-[a-z0-9]+(?:-[a-z0-9]+)*\.json$/, label: 'change' },
  ];
  for (const kind of artifactKinds) {
    const directory = resolveInside(repositoryRoot, 'docs', 'work', work.work_id, kind.directory);
    const stat = lstatIfPresent(directory);
    if (!stat) continue;
    if (!stat.isDirectory()) throw new TypeError(`${kind.label} artifact path must be a directory`);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new TypeError(`${kind.label} artifact must not be a symbolic link`);
      if (!entry.isFile() || !kind.pattern.test(entry.name)) continue;
      const reference = `docs/work/${work.work_id}/${kind.directory}/${entry.name}`;
      if (!work[kind.field].includes(reference)) {
        throw new Error(`unindexed ${kind.label} artifact ${reference}`);
      }
    }
  }
}

function validateWorkDirectory(directory, requiredEvidence = []) {
  const requestedDirectory = path.resolve(requiredText(directory, 'Work directory', 2_000));
  const directoryStat = lstatIfPresent(requestedDirectory);
  if (!directoryStat) throw new Error(`Work directory does not exist: ${requestedDirectory}`);
  if (directoryStat.isSymbolicLink()) throw new TypeError('Work directory must not be a symbolic link');
  if (!directoryStat.isDirectory()) throw new TypeError('Work directory must be a directory');

  const repositoryRoot = repositoryRootPath(path.resolve(requestedDirectory, '..', '..', '..'));
  const work = validatePersistedWork(
    parseJsonFile(resolveInside(repositoryRoot, path.relative(repositoryRoot, path.join(requestedDirectory, 'work.json'))), 'Work'),
  );
  const expectedDirectory = resolveInside(repositoryRoot, 'docs', 'work', work.work_id);
  if (requestedDirectory !== expectedDirectory) throw new TypeError('Work directory is not the canonical Work ID path');

  const specFile = resolveInside(repositoryRoot, work.spec.path);
  assertSafeExistingFile(specFile, 'canonical spec');
  const spec = fs.readFileSync(specFile);
  if (sha256(spec) !== work.spec.sha256) throw new Error('canonical spec digest mismatch');
  const specContents = spec.toString('utf8');
  if (parseSpecWorkId(specContents) !== work.work_id) throw new Error('canonical spec Work ID mismatch');
  assertEngineeringQualityContractContent(specContents);

  const mirrorFile = resolveInside(repositoryRoot, work.active_pair_mirror);
  assertSafeExistingFile(mirrorFile, 'active pair mirror');
  const expectedMirror = [
    '<!-- GENERATED ACTIVE MIRROR',
    `Canonical: ${work.spec.path}`,
    `Canonical SHA-256: ${work.spec.sha256}`,
    '-->',
    specContents,
  ].join('\n');
  if (fs.readFileSync(mirrorFile, 'utf8') !== expectedMirror) {
    throw new Error('active pair mirror does not match the canonical spec digest and bytes');
  }

  assertNoUnindexedArtifacts(repositoryRoot, work);

  const decisionIds = new Set();
  const derivedSupersessions = [];
  for (const reference of work.decision_records) {
    const id = referenceId(reference);
    const decision = validateDecisionMarkdown(resolveInside(repositoryRoot, reference), work.work_id, id, work.spec.path);
    decisionIds.add(id);
    if (decision.supersedes) derivedSupersessions.push({ predecessor: decision.supersedes, successor: id });
  }
  for (const relation of work.decision_supersessions) {
    if (!decisionIds.has(relation.predecessor) || !decisionIds.has(relation.successor)) {
      throw new Error('Decision Record supersession references a missing record');
    }
  }
  const relationKey = relation => `${relation.predecessor}\0${relation.successor}`;
  const indexedRelations = work.decision_supersessions.map(relationKey).sort();
  const actualRelations = derivedSupersessions.map(relationKey).sort();
  if (JSON.stringify(indexedRelations) !== JSON.stringify(actualRelations)) {
    throw new Error('Decision Record supersession index does not match immutable records');
  }

  for (const reference of work.outcomes) {
    validateOutcomeMarkdown(
      resolveInside(repositoryRoot, reference),
      work.work_id,
      referenceId(reference),
      decisionIds,
    );
  }
  for (const reference of work.changes) {
    const change = validatePersistedChange(parseJsonFile(resolveInside(repositoryRoot, reference), 'change file'));
    if (change.id !== referenceId(reference)) throw new Error('change file ID does not match its canonical path');
    if (change.work_id !== work.work_id) throw new Error('change file Work ID mismatch');
    for (const id of change.decision_record_ids) {
      if (!decisionIds.has(id)) throw new Error(`change file references missing Decision Record ${id}`);
    }
  }

  const evidenceRecords = [];
  for (const reference of work.evidence_records) {
    const evidence = validateEvidenceFile(resolveInside(repositoryRoot, reference));
    if (evidence.id !== referenceId(reference)) throw new Error('evidence file ID does not match its canonical path');
    if (evidence.work_id !== work.work_id) throw new Error('evidence file Work ID mismatch');
    for (const id of evidence.decision_record_ids) {
      if (!decisionIds.has(id)) throw new Error(`evidence file references missing Decision Record ${id}`);
    }
    evidenceRecords.push(evidence);
  }
  for (const kind of textList(requiredEvidence, 'required evidence', { itemLength: 100 })) {
    if (!evidenceRecords.some(record => record.kind === kind)) {
      throw new Error(`required evidence ${kind} is missing`);
    }
  }
  return work;
}

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'create') {
    const workId = option(args, '--work-id');
    const specFile = option(args, '--spec-file');
    const repositoryRoot = option(args, '--repository-root') || process.cwd();
    if (!workId) throw new Error('--work-id is required');
    if (!specFile) throw new Error('--spec-file is required');
    const candidate = assertSafeExistingFile(path.resolve(specFile), 'approved spec input');
    const created = createWorkRoot({
      repositoryRoot: path.resolve(repositoryRoot),
      workId,
      canonicalSpec: fs.readFileSync(candidate, 'utf8'),
    });
    console.log(JSON.stringify({ created: true, work_id: created.workId, spec: created.spec }));
    return;
  }
  if (command === 'validate-evidence') {
    const file = option(args, '--file');
    if (!file) throw new Error('--file is required');
    const evidence = validateEvidenceFile(path.resolve(file));
    console.log(JSON.stringify({ valid: true, id: evidence.id }));
    return;
  }
  if (command === 'validate') {
    const directory = option(args, '--work');
    if (!directory) throw new Error('--work is required');
    const required = (option(args, '--require-evidence') || '').split(',').filter(Boolean);
    const work = validateWorkDirectory(path.resolve(directory), required);
    console.log(JSON.stringify({ valid: true, work_id: work.work_id }));
    return;
  }
  console.error('Usage: work-lineage.cjs create --work-id ID --spec-file FILE [--repository-root DIR] | validate-evidence --file FILE | validate --work DIRECTORY [--require-evidence a,b]');
  process.exitCode = 1;
}

module.exports = {
  appendChangeRecord,
  appendEvidenceRecord,
  appendOutcomeRecord,
  createWorkRoot,
  evaluateQualityContract,
  validateEvidenceFile,
  validateWorkDirectory,
  writeDecisionRecord,
};

if (require.main === module) main();
