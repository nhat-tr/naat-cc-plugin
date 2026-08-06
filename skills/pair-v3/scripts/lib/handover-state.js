const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { loadPairState, pairStatePaths, redactString } = require('./pair-state');
const {
  engineOwner, engineVerificationOwner, engineWork, engineWorkId, livePairWorkId, pairProjectionPath,
} = require('./pair-authority');
const { takeoverWork } = require('./handover-takeover');
const { deriveBrainstormingCheckpoint } = require('./brainstorm-checkpoint');
const { recoverAgentConversationCheckpoint } = require('./conversation-checkpoint-recovery');

const HANDOVER_SCHEMA = 1;
const MAX_CHECKPOINT_BYTES = 32 * 1024;
const FRESHNESS_WINDOW_MS = 60 * 60 * 1000;
// Stop is the only turn boundary a runtime reports, so a long autonomous turn produces no Stop
// for as long as it keeps working. Observed activity (a Pair dispatch) may carry liveness across
// that gap, but only for a bounded stretch past the last Stop-confirmed boundary — otherwise a
// wedged dispatch loop would hold the Freshness Gate open indefinitely.
const MAX_UNSTOPPED_ACTIVITY_MS = 4 * FRESHNESS_WINDOW_MS;
const LOCK_WAIT_MS = 5;
const LOCK_TIMEOUT_MS = 10_000;
const HANDOVER_ID = /^handover-[a-f0-9-]{36}$/u;
const RUNTIMES = new Set(['codex', 'claude']);
const KINDS = new Set(['pair', 'brainstorming', 'general']);
const CHECKPOINT_ORIGINS = new Set(['bootstrap', 'derived', 'manual', 'manual-recovered', 'recovered']);
const CONVERSATION_KEYS = new Set([
  'source_key', 'runtime', 'kind', 'status', 'registered_at', 'last_active_at',
  'activity_anchor_at', 'checkpoint', 'checkpoint_revision', 'sealed_handover_id',
  'adopted_handover_id', 'override', 'checkpoint_origin', 'checkpoint_source_digest',
  'checkpoint_updated_at',
]);
const HANDOVER_CLAIM_KEYS = new Set([
  'handover_id', 'source_key', 'status', 'created_at', 'override_used',
  'runtime', 'kind', 'checkpoint_revision', 'checkpoint_sha256',
  'checkpoint_origin', 'checkpoint_source_digest', 'checkpoint_updated_at',
  'manifest_sha256', 'stage_directory', 'override_authorized_at',
  'override_completed_at', 'refreshed_handover_id', 'adopting_by',
  'adopting_at', 'adopted_by', 'adopted_at', 'adoption_transfer_status',
]);
const CHECKPOINT_INPUT_KEYS = new Set([
  'schema', 'coreAnchor', 'core_anchor', 'findings', 'confirmedChoices', 'confirmed_choices',
  'rejectedAlternatives', 'rejected_alternatives', 'currentDirection', 'current_direction',
  'unresolvedDecisions', 'unresolved_decisions', 'nextAction', 'next_action', 'artifacts',
]);
const CHECKPOINT_FINDING_INPUT_KEYS = new Set(['finding', 'statement', 'reference', 'digest']);
const CHECKPOINT_ARTIFACT_INPUT_KEYS = new Set(['path', 'sha256']);
const CHECKPOINT_TEXT_KEYS = [
  'coreAnchor', 'core_anchor', 'currentDirection', 'current_direction', 'nextAction', 'next_action',
];
const CHECKPOINT_STRING_LIST_KEYS = [
  'confirmedChoices', 'confirmed_choices', 'rejectedAlternatives', 'rejected_alternatives',
  'unresolvedDecisions', 'unresolved_decisions',
];
const CHECKPOINT_ALIAS_PAIRS = [
  ['coreAnchor', 'core_anchor'],
  ['confirmedChoices', 'confirmed_choices'],
  ['rejectedAlternatives', 'rejected_alternatives'],
  ['currentDirection', 'current_direction'],
  ['unresolvedDecisions', 'unresolved_decisions'],
  ['nextAction', 'next_action'],
];
const SHA256_DIGEST = /^[a-f0-9]{64}$/u;

function handoverPaths(root) {
  const pairDirectory = path.join(root, '.pair');
  const directory = path.join(pairDirectory, 'handovers');
  return {
    pairDirectory,
    directory,
    registrations: path.join(directory, 'registrations'),
    registrationIndex: path.join(directory, 'registrations', '.index-v1-complete.json'),
    policy: path.join(directory, 'policy.json'),
    registry: path.join(directory, 'registry.json'),
    lock: path.join(directory, '.handover.lock'),
  };
}

function setGeneralHandoverPolicy(root, enabled) {
  const paths = validateHandoverRoot(root, true);
  const policy = {
    schema: HANDOVER_SCHEMA,
    general_agent_conversations: enabled ? 'auto' : 'off',
  };
  atomicWrite(paths.policy, `${JSON.stringify(policy, null, 2)}\n`);
  return policy;
}

function generalHandoverEnabled(root, env = process.env) {
  const configured = String(env.AGENT_CONVERSATION_HANDOVER || '').trim().toLowerCase();
  if (['1', 'auto', 'on', 'true'].includes(configured)) return true;
  if (['0', 'off', 'false'].includes(configured)) return false;
  const candidate = handoverPaths(root).policy;
  const candidateStat = fs.lstatSync(candidate, { throwIfNoEntry: false });
  if (!candidateStat) return false;
  const file = validateHandoverRoot(root).policy;
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) throw new Error('invalid Agent Conversation Handover policy');
  const policy = readJson(file);
  if (
    !isPlainObject(policy) ||
    Object.keys(policy).sort().join(',') !== 'general_agent_conversations,schema' ||
    policy.schema !== HANDOVER_SCHEMA ||
    !['auto', 'off'].includes(policy.general_agent_conversations)
  ) throw new Error('invalid Agent Conversation Handover policy');
  return policy.general_agent_conversations === 'auto';
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('invalid Agent Conversation Handover directory symlink');
  try {
    fs.chmodSync(directory, 0o700);
  } catch {
    // Permission hardening is best-effort on filesystems without POSIX modes.
  }
}

function validateHandoverRoot(root, create = false) {
  const paths = handoverPaths(root);
  if (create) {
    ensurePrivateDirectory(paths.pairDirectory);
    ensurePrivateDirectory(paths.directory);
    ensurePrivateDirectory(paths.registrations);
    return paths;
  }
  for (const directory of [paths.pairDirectory, paths.directory, paths.registrations]) {
    const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) throw new Error('invalid Agent Conversation Handover directory');
  }
  return paths;
}

function atomicWrite(file, content) {
  ensurePrivateDirectory(path.dirname(file));
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temporary, content, { mode: 0o600 });
  fs.renameSync(temporary, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // See ensurePrivateDirectory.
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every(key => allowed.has(key));
}

function validConversationOverride(value) {
  if (!isPlainObject(value)) return false;
  const base = ['handover_id', 'status'];
  const allowedByStatus = {
    'allowed-once': [...base, 'authorized_at', 'authorized_checkpoint_revision'],
    'in-flight': [...base, 'authorized_at', 'authorized_checkpoint_revision', 'consumed_at', 'refreshed_at', 'refreshed_checkpoint_revision'],
    'failed-no-refresh': [...base, 'authorized_at', 'authorized_checkpoint_revision', 'consumed_at', 'failed_at'],
    completed: [...base, 'completed_at', 'refreshed_handover_id', 'authorized_checkpoint_revision', 'refreshed_at', 'refreshed_checkpoint_revision'],
  };
  const allowed = allowedByStatus[value.status];
  if (!allowed || Object.keys(value).some(key => !allowed.includes(key))) return false;
  if (!HANDOVER_ID.test(value.handover_id || '')) return false;
  if (!Number.isInteger(value.authorized_checkpoint_revision) || value.authorized_checkpoint_revision < 1) return false;
  for (const field of ['authorized_at', 'consumed_at', 'failed_at', 'completed_at', 'refreshed_at']) {
    if (value[field] !== undefined && !validEventTimestamp(value[field])) return false;
  }
  if (value.refreshed_checkpoint_revision !== undefined && (
    !Number.isInteger(value.refreshed_checkpoint_revision) ||
    value.refreshed_checkpoint_revision <= value.authorized_checkpoint_revision
  )) return false;
  if (value.status === 'completed' && !HANDOVER_ID.test(value.refreshed_handover_id || '')) return false;
  return true;
}

function readRegistryFile(file) {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) return null;
  return readJson(file);
}

function validRegistry(registry) {
  if (
    !isPlainObject(registry) ||
    Object.keys(registry).sort().join(',') !== 'conversations,handovers,schema' ||
    registry.schema !== HANDOVER_SCHEMA ||
    !isPlainObject(registry.conversations) ||
    !isPlainObject(registry.handovers)
  ) return false;
  for (const [sourceKey, conversation] of Object.entries(registry.conversations)) {
    if (!/^[a-f0-9]{64}$/u.test(sourceKey) || !isPlainObject(conversation)) return false;
    if (!hasOnlyKeys(conversation, CONVERSATION_KEYS)) return false;
    if (conversation.source_key !== sourceKey || !RUNTIMES.has(conversation.runtime) || !KINDS.has(conversation.kind)) return false;
    if (!['warm', 'sealed', 'override-active', 'retired'].includes(conversation.status)) return false;
    if (!Number.isInteger(conversation.checkpoint_revision) || conversation.checkpoint_revision < 0) return false;
    if (!validEventTimestamp(conversation.registered_at) || typeof conversation.last_active_at !== 'string') return false;
    if (
      conversation.activity_anchor_at !== undefined &&
      conversation.activity_anchor_at !== null &&
      !validEventTimestamp(conversation.activity_anchor_at)
    ) return false;
    if (conversation.checkpoint === null) {
      if (conversation.checkpoint_revision !== 0 || conversation.status !== 'warm') return false;
      if (
        (conversation.checkpoint_origin !== undefined && conversation.checkpoint_origin !== null) ||
        (conversation.checkpoint_source_digest !== undefined && conversation.checkpoint_source_digest !== null) ||
        (conversation.checkpoint_updated_at !== undefined && conversation.checkpoint_updated_at !== null)
      ) return false;
    } else {
      if (
        conversation.checkpoint_revision < 1 ||
        !isPlainObject(conversation.checkpoint) ||
        Buffer.byteLength(JSON.stringify(conversation.checkpoint), 'utf8') > MAX_CHECKPOINT_BYTES ||
        JSON.stringify(conversation.checkpoint) !== JSON.stringify(normalizeCheckpoint(conversation.checkpoint))
      ) return false;
      if (
        conversation.checkpoint_origin !== undefined &&
        conversation.checkpoint_origin !== null &&
        !CHECKPOINT_ORIGINS.has(conversation.checkpoint_origin)
      ) return false;
      if (
        conversation.checkpoint_source_digest !== undefined &&
        conversation.checkpoint_source_digest !== null &&
        !/^[a-f0-9]{64}$/u.test(conversation.checkpoint_source_digest)
      ) return false;
      if (
        conversation.checkpoint_updated_at !== undefined &&
        conversation.checkpoint_updated_at !== null &&
        !validEventTimestamp(conversation.checkpoint_updated_at)
      ) return false;
    }
    if (conversation.adopted_handover_id !== undefined && !HANDOVER_ID.test(conversation.adopted_handover_id || '')) return false;
    if (conversation.override !== null && conversation.override !== undefined && !validConversationOverride(conversation.override)) return false;
    const handoverId = conversation.sealed_handover_id;
    if (handoverId === null || handoverId === undefined) {
      if (conversation.status === 'sealed' || conversation.status === 'override-active') return false;
      if (conversation.override && conversation.status !== 'warm') return false;
      continue;
    }
    const handover = registry.handovers[handoverId];
    if (!HANDOVER_ID.test(handoverId) || !isPlainObject(handover) || handover.handover_id !== handoverId || handover.source_key !== sourceKey) return false;
    if (!['sealed', 'adopting', 'adopted', 'refreshed'].includes(handover.status)) return false;
    if (conversation.status === 'warm') return false;
    if (conversation.status === 'sealed' || conversation.status === 'override-active') {
      if (!['sealed', 'adopting'].includes(handover.status)) return false;
    }
    if (conversation.status === 'override-active' && !['allowed-once', 'in-flight'].includes(conversation.override?.status)) return false;
    if (conversation.status === 'sealed' && conversation.override && conversation.override.status !== 'failed-no-refresh') return false;
    if (conversation.status === 'retired' && conversation.override && !['completed', 'failed-no-refresh'].includes(conversation.override.status)) return false;
  }
  for (const [handoverId, handover] of Object.entries(registry.handovers)) {
    if (!HANDOVER_ID.test(handoverId) || !isPlainObject(handover) || handover.handover_id !== handoverId || !isPlainObject(registry.conversations[handover.source_key])) return false;
    if (!hasOnlyKeys(handover, HANDOVER_CLAIM_KEYS)) return false;
    if (!['sealed', 'adopting', 'adopted', 'refreshed'].includes(handover.status)) return false;
    if (handover.status === 'adopting' && !/^[a-f0-9]{64}$/u.test(handover.adopting_by || '')) return false;
    if (!validEventTimestamp(handover.created_at)) return false;
    if (typeof handover.override_used !== 'boolean') return false;
    if (handover.override_used && !validEventTimestamp(handover.override_authorized_at)) return false;
    if (!handover.override_used && handover.override_authorized_at !== undefined) return false;
    if (
      handover.status === 'refreshed' &&
      (
        !HANDOVER_ID.test(handover.refreshed_handover_id || '') ||
        !isPlainObject(registry.handovers[handover.refreshed_handover_id])
      )
    ) return false;
    if (handover.status === 'refreshed' && (!handover.override_used || !validEventTimestamp(handover.override_completed_at))) return false;
    if (
      handover.status === 'adopted' &&
      (
        !/^[a-f0-9]{64}$/u.test(handover.adopted_by || '') ||
        !validEventTimestamp(handover.adopted_at)
      )
    ) return false;
    if (handover.manifest_sha256 !== undefined && !/^[a-f0-9]{64}$/u.test(handover.manifest_sha256)) return false;
    if (handover.runtime !== undefined && !RUNTIMES.has(handover.runtime)) return false;
    if (handover.kind !== undefined && !KINDS.has(handover.kind)) return false;
    if (handover.checkpoint_revision !== undefined && (!Number.isInteger(handover.checkpoint_revision) || handover.checkpoint_revision < 0)) return false;
    if (handover.checkpoint_sha256 !== undefined && !/^[a-f0-9]{64}$/u.test(handover.checkpoint_sha256)) return false;
    if (handover.checkpoint_origin !== undefined && handover.checkpoint_origin !== null && !CHECKPOINT_ORIGINS.has(handover.checkpoint_origin)) return false;
    if (handover.checkpoint_source_digest !== undefined && handover.checkpoint_source_digest !== null && !/^[a-f0-9]{64}$/u.test(handover.checkpoint_source_digest)) return false;
    if (handover.checkpoint_updated_at !== undefined && handover.checkpoint_updated_at !== null && !validEventTimestamp(handover.checkpoint_updated_at)) return false;
    if (
      handover.adoption_transfer_status !== undefined &&
      !['pending', 'completed', 'not-applicable'].includes(handover.adoption_transfer_status)
    ) return false;
    if (handover.stage_directory !== undefined && handover.stage_directory !== `.staging-${handoverId}`) return false;
    if (handover.status === 'adopting') {
      if (!validEventTimestamp(handover.adopting_at) || !handover.adoption_transfer_status) return false;
    } else if (handover.adopting_by !== undefined || handover.adopting_at !== undefined) return false;
    if (handover.status !== 'adopted' && (handover.adopted_by !== undefined || handover.adopted_at !== undefined)) return false;
    if (!['adopting', 'adopted'].includes(handover.status) && handover.adoption_transfer_status !== undefined) return false;
    if (handover.status !== 'refreshed' && (
      handover.refreshed_handover_id !== undefined || handover.override_completed_at !== undefined
    )) return false;
  }
  return true;
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleepSync(milliseconds) {
  const view = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(view, 0, 0, milliseconds);
}

function acquireLock(paths) {
  ensurePrivateDirectory(paths.directory);
  const nonce = crypto.randomUUID();
  const started = Date.now();
  while (Date.now() - started < LOCK_TIMEOUT_MS) {
    try {
      fs.mkdirSync(paths.lock, { mode: 0o700 });
      fs.writeFileSync(path.join(paths.lock, 'owner.json'), JSON.stringify({ pid: process.pid, nonce }), { mode: 0o600 });
      return { nonce };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = readJson(path.join(paths.lock, 'owner.json'));
      let age = 0;
      try {
        age = Date.now() - fs.statSync(paths.lock).mtimeMs;
      } catch {
        continue;
      }
      if ((owner?.pid && !processAlive(owner.pid)) || (!owner && age > 1_000) || age > 30_000) {
        fs.rmSync(paths.lock, { recursive: true, force: true });
        continue;
      }
      sleepSync(LOCK_WAIT_MS);
    }
  }
  throw new Error('timed out acquiring Agent Conversation Handover lock');
}

function releaseLock(paths, lock) {
  if (readJson(path.join(paths.lock, 'owner.json'))?.nonce === lock.nonce) {
    fs.rmSync(paths.lock, { recursive: true, force: true });
  }
}

function withRegistry(root, callback) {
  const paths = validateHandoverRoot(root, true);
  const lock = acquireLock(paths);
  try {
    const registryExists = fs.existsSync(paths.registry);
    if (!registryExists && registrationArtifactsPresent(paths)) {
      throw new Error('invalid Agent Conversation Handover registry');
    }
    const registry = registryExists ? readRegistryFile(paths.registry) : { schema: HANDOVER_SCHEMA, conversations: {}, handovers: {} };
    if (!validRegistry(registry)) {
      throw new Error('invalid Agent Conversation Handover registry');
    }
    if (registryExists) reconcileRegistrationMarkersLocked(paths, registry);
    recoverSealedHandoverTransactions(paths, registry);
    const result = callback(registry, paths);
    atomicWrite(paths.registry, `${JSON.stringify(registry, null, 2)}\n`);
    reconcileRegistrationMarkersLocked(paths, registry);
    return result;
  } finally {
    releaseLock(paths, lock);
  }
}

function readAgentConversationRegistry(root) {
  const paths = handoverPaths(root);
  if (!fs.existsSync(paths.registry)) {
    if (registrationArtifactsPresent(paths)) throw new Error('invalid Agent Conversation Handover registry');
    return { schema: HANDOVER_SCHEMA, conversations: {}, handovers: {} };
  }
  return withRegistry(root, registry => registry);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function timestamp(value) {
  const milliseconds = value === undefined ? Date.now() : Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new Error('Agent Conversation timestamp must be a non-negative finite millisecond value');
  return new Date(milliseconds).toISOString();
}

function conversationIdentity(input) {
  const runtime = String(input?.runtime || '').toLowerCase();
  const agentConversationId = String(input?.agentConversationId || '').trim();
  const kind = String(input?.kind || '').toLowerCase();
  if (!RUNTIMES.has(runtime)) throw new Error('Agent Conversation runtime must be codex or claude');
  if (!agentConversationId || agentConversationId.length > 256) throw new Error('Agent Conversation requires an identity');
  if (kind && !KINDS.has(kind)) throw new Error('Agent Conversation kind must be pair, brainstorming, or general');
  return { runtime, kind: kind || null, sourceKey: sha256(`${runtime}\0${agentConversationId}`) };
}

function registrationMarkerPath(root, sourceKey) {
  return path.join(handoverPaths(root).registrations, `${sourceKey}.json`);
}

function readRegistrationMarker(marker, identity, kind = null) {
  const stat = fs.lstatSync(marker, { throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('invalid Agent Conversation registration marker');
  }
  const existing = readJson(marker);
  if (
    !existing ||
    existing.schema !== HANDOVER_SCHEMA ||
    existing.source_key !== identity.sourceKey ||
    existing.runtime !== identity.runtime ||
    !KINDS.has(existing.kind) ||
    (kind !== null && existing.kind !== kind)
  ) throw new Error('invalid Agent Conversation registration marker');
  return existing;
}

function writeRegistrationMarkerLocked(paths, identity, kind, registeredAt) {
  const marker = path.join(paths.registrations, `${identity.sourceKey}.json`);
  const existing = readRegistrationMarker(marker, identity, kind);
  if (!existing) {
    atomicWrite(marker, `${JSON.stringify({
      schema: HANDOVER_SCHEMA,
      source_key: identity.sourceKey,
      runtime: identity.runtime,
      kind,
      registered_at: registeredAt,
    }, null, 2)}\n`);
  }
}

function registrationIndexComplete(paths) {
  const stat = fs.lstatSync(paths.registrationIndex, { throwIfNoEntry: false });
  if (!stat) return false;
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('invalid Agent Conversation registration index');
  }
  const index = readJson(paths.registrationIndex);
  if (index?.schema !== HANDOVER_SCHEMA || index.status !== 'complete') {
    throw new Error('invalid Agent Conversation registration index');
  }
  return true;
}

function writeRegistrationIndexLocked(paths) {
  if (registrationIndexComplete(paths)) return;
  atomicWrite(paths.registrationIndex, `${JSON.stringify({
    schema: HANDOVER_SCHEMA,
    status: 'complete',
  }, null, 2)}\n`);
}

function registrationArtifactsPresent(paths) {
  const registrations = fs.lstatSync(paths.registrations, { throwIfNoEntry: false });
  if (!registrations) return false;
  if (!registrations.isDirectory() || registrations.isSymbolicLink()) {
    throw new Error('invalid Agent Conversation registration directory');
  }
  return fs.readdirSync(paths.registrations).length > 0;
}

function reconcileRegistrationMarkersLocked(paths, registry) {
  const registrations = fs.lstatSync(paths.registrations, { throwIfNoEntry: false });
  if (!registrations) return;
  if (!registrations.isDirectory() || registrations.isSymbolicLink()) {
    throw new Error('invalid Agent Conversation registration directory');
  }
  const indexComplete = registrationIndexComplete(paths);
  for (const entry of fs.readdirSync(paths.registrations, { withFileTypes: true })) {
    if (entry.name === path.basename(paths.registrationIndex)) continue;
    const match = entry.name.match(/^([a-f0-9]{64})\.json$/u);
    if (!match || !entry.isFile() || entry.isSymbolicLink()) {
      throw new Error('invalid Agent Conversation registration marker');
    }
    const sourceKey = match[1];
    const conversation = registry.conversations[sourceKey];
    const markerFile = path.join(paths.registrations, entry.name);
    const marker = readRegistrationMarker(markerFile, {
      sourceKey,
      runtime: conversation?.runtime || readJson(markerFile)?.runtime,
    }, conversation?.kind || null);
    if (!conversation) {
      if (!RUNTIMES.has(marker.runtime) || !KINDS.has(marker.kind)) {
        throw new Error('invalid Agent Conversation registration marker');
      }
      fs.rmSync(markerFile);
    }
  }
  for (const conversation of Object.values(registry.conversations)) {
    writeRegistrationMarkerLocked(paths, {
      sourceKey: conversation.source_key,
      runtime: conversation.runtime,
    }, conversation.kind, conversation.registered_at);
  }
  if (!indexComplete) writeRegistrationIndexLocked(paths);
}

function migrateLegacyRegistrationMarkers(root) {
  const paths = handoverPaths(root);
  const registryStat = fs.lstatSync(paths.registry, { throwIfNoEntry: false });
  if (!registryStat) return false;
  if (!registryStat.isFile() || registryStat.isSymbolicLink()) {
    throw new Error('invalid Agent Conversation Handover registry');
  }
  ensurePrivateDirectory(paths.registrations);
  const lock = acquireLock(paths);
  try {
    const registry = readRegistryFile(paths.registry);
    if (!validRegistry(registry)) throw new Error('invalid Agent Conversation Handover registry');
    reconcileRegistrationMarkersLocked(paths, registry);
    return true;
  } finally {
    releaseLock(paths, lock);
  }
}

function hasAgentConversationRegistration(root, input) {
  const identity = conversationIdentity(input);
  const paths = handoverPaths(root);
  for (const directory of [paths.pairDirectory, paths.directory]) {
    const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (!stat) return false;
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('invalid Agent Conversation registration directory');
    }
  }
  const registrations = fs.lstatSync(paths.registrations, { throwIfNoEntry: false });
  if (registrations && (!registrations.isDirectory() || registrations.isSymbolicLink())) {
    throw new Error('invalid Agent Conversation registration directory');
  }
  const marker = registrationMarkerPath(root, identity.sourceKey);
  if (registrations) {
    const existing = readRegistrationMarker(marker, identity);
    if (existing) return true;
  }
  const registryStat = fs.lstatSync(paths.registry, { throwIfNoEntry: false });
  if (!registryStat || !registryStat.isFile() || registryStat.isSymbolicLink()) return false;
  const registryBytes = fs.readFileSync(paths.registry, 'utf8');
  if (!registryBytes.includes(identity.sourceKey)) return false;
  if (registrations && registrationIndexComplete(paths)) {
    if (!migrateLegacyRegistrationMarkers(root)) return false;
    return Boolean(readRegistrationMarker(marker, identity));
  }
  if (!migrateLegacyRegistrationMarkers(root)) return false;
  return Boolean(readRegistrationMarker(marker, identity));
}

function truncateUtf8(value, maximum) {
  let result = '';
  let bytes = 0;
  for (const character of String(value || '')) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > maximum) break;
    result += character;
    bytes += size;
  }
  return result;
}

function safeText(value, maximum = 4096) {
  if (value === null || value === undefined) return '';
  return truncateUtf8(redactString(value), maximum).trim();
}

function safeList(values, maximumItems = 32, itemBytes = 512) {
  return [...new Set((Array.isArray(values) ? values : []).map(value => safeText(value, itemBytes)).filter(Boolean))].slice(0, maximumItems);
}

function safeArtifact(value) {
  const artifactPath = String(value?.path || '').split('\\').join('/');
  if (!artifactPath || artifactPath.startsWith('/') || artifactPath.split('/').includes('..')) return null;
  if (redactString(artifactPath) !== artifactPath) return null;
  if (!/^[a-f0-9]{64}$/u.test(value?.sha256 || '')) return null;
  return { path: artifactPath, sha256: value.sha256 };
}

function unsupportedCheckpointFields(value, allowed) {
  return Object.keys(value).filter(key => !allowed.has(key));
}

function validateAgentConversationCheckpointInput(input) {
  if (!isPlainObject(input)) throw new Error('Agent Conversation Checkpoint must be one JSON object');
  const unsupported = unsupportedCheckpointFields(input, CHECKPOINT_INPUT_KEYS);
  if (unsupported.length) {
    throw new Error(`Agent Conversation Checkpoint has unsupported field(s): ${unsupported.join(', ')}`);
  }
  if (input.schema !== undefined && input.schema !== HANDOVER_SCHEMA) {
    throw new Error(`Agent Conversation Checkpoint schema must be ${HANDOVER_SCHEMA}`);
  }
  for (const [camelCase, snakeCase] of CHECKPOINT_ALIAS_PAIRS) {
    if (input[camelCase] !== undefined && input[snakeCase] !== undefined) {
      throw new Error(`Agent Conversation Checkpoint must not include both ${camelCase} and ${snakeCase}`);
    }
  }
  for (const key of CHECKPOINT_TEXT_KEYS) {
    if (input[key] !== undefined && typeof input[key] !== 'string') {
      throw new Error(`Agent Conversation Checkpoint ${key} must be a string`);
    }
  }
  for (const key of CHECKPOINT_STRING_LIST_KEYS) {
    if (input[key] !== undefined && (!Array.isArray(input[key]) || input[key].some(value => typeof value !== 'string'))) {
      throw new Error(`Agent Conversation Checkpoint ${key} must contain only strings`);
    }
  }
  if (input.findings !== undefined && !Array.isArray(input.findings)) {
    throw new Error('Agent Conversation Checkpoint findings must be an array');
  }
  for (const finding of input.findings || []) {
    if (!isPlainObject(finding)) throw new Error('Agent Conversation Checkpoint findings must contain objects');
    const findingUnsupported = unsupportedCheckpointFields(finding, CHECKPOINT_FINDING_INPUT_KEYS);
    if (findingUnsupported.length) {
      throw new Error(`Agent Conversation Checkpoint finding has unsupported field(s): ${findingUnsupported.join(', ')}`);
    }
    if (finding.finding !== undefined && finding.statement !== undefined) {
      throw new Error('Agent Conversation Checkpoint finding must not include both finding and statement');
    }
    for (const key of ['finding', 'statement', 'reference']) {
      if (finding[key] !== undefined && typeof finding[key] !== 'string') {
        throw new Error(`Agent Conversation Checkpoint finding ${key} must be a string`);
      }
    }
    if (finding.finding === undefined && finding.statement === undefined && finding.reference === undefined) {
      throw new Error('Agent Conversation Checkpoint finding must include finding, statement, or reference');
    }
    if (finding.digest !== undefined && finding.digest !== null && !SHA256_DIGEST.test(finding.digest)) {
      throw new Error('Agent Conversation Checkpoint finding digest must be null or 64 lowercase hexadecimal characters');
    }
  }
  if (input.artifacts !== undefined && !Array.isArray(input.artifacts)) {
    throw new Error('Agent Conversation Checkpoint artifacts must be an array');
  }
  for (const artifact of input.artifacts || []) {
    if (!isPlainObject(artifact)) throw new Error('Agent Conversation Checkpoint artifacts must contain objects');
    const artifactUnsupported = unsupportedCheckpointFields(artifact, CHECKPOINT_ARTIFACT_INPUT_KEYS);
    if (artifactUnsupported.length) {
      throw new Error(`Agent Conversation Checkpoint artifact has unsupported field(s): ${artifactUnsupported.join(', ')}`);
    }
    if (
      typeof artifact.path !== 'string' ||
      !artifact.path ||
      artifact.path.includes('\\') ||
      artifact.path.startsWith('/') ||
      artifact.path.split('/').includes('..') ||
      redactString(artifact.path) !== artifact.path
    ) {
      throw new Error('Agent Conversation Checkpoint artifact path must be a repository-relative string');
    }
    if (!SHA256_DIGEST.test(artifact.sha256 || '')) {
      throw new Error('Agent Conversation Checkpoint artifact sha256 must be 64 lowercase hexadecimal characters');
    }
  }
  return input;
}

function normalizeCheckpoint(input) {
  const checkpoint = {
    schema: HANDOVER_SCHEMA,
    core_anchor: safeText(input?.coreAnchor ?? input?.core_anchor, 4096),
    findings: (Array.isArray(input?.findings) ? input.findings : []).map(finding => {
      const findingText = safeText(finding?.finding ?? finding?.statement, 2048);
      const reference = safeText(finding?.reference, 1024);
      const digest = /^[a-f0-9]{64}$/u.test(finding?.digest || '') ? finding.digest : null;
      if (!findingText && !reference) return null;
      return {
        ...(findingText ? { finding: findingText } : {}),
        ...(reference ? { reference } : {}),
        digest,
      };
    }).filter(Boolean).slice(0, 64),
    confirmed_choices: safeList(input?.confirmedChoices ?? input?.confirmed_choices),
    rejected_alternatives: safeList(input?.rejectedAlternatives ?? input?.rejected_alternatives),
    current_direction: safeText(input?.currentDirection ?? input?.current_direction, 4096),
    unresolved_decisions: safeList(input?.unresolvedDecisions ?? input?.unresolved_decisions),
    next_action: safeText(input?.nextAction ?? input?.next_action, 1024),
    artifacts: (Array.isArray(input?.artifacts) ? input.artifacts : []).map(safeArtifact).filter(Boolean).slice(0, 64),
  };
  while (Buffer.byteLength(JSON.stringify(checkpoint), 'utf8') > MAX_CHECKPOINT_BYTES) {
    if (checkpoint.findings.length) checkpoint.findings.pop();
    else if (checkpoint.artifacts.length) checkpoint.artifacts.pop();
    else if (checkpoint.rejected_alternatives.length) checkpoint.rejected_alternatives.pop();
    else if (checkpoint.unresolved_decisions.length) checkpoint.unresolved_decisions.pop();
    else if (checkpoint.confirmed_choices.length) checkpoint.confirmed_choices.pop();
    else if (checkpoint.next_action) checkpoint.next_action = truncateUtf8(checkpoint.next_action, Math.max(0, Buffer.byteLength(checkpoint.next_action, 'utf8') - 128));
    else throw new Error('Agent Conversation Checkpoint identity exceeds 32 KiB');
  }
  return checkpoint;
}

// A brainstorming checkpoint refresh is a delta, not a restatement: stable fields (Core Anchor,
// findings, confirmed choices, rejected alternatives, artifacts) merge cumulatively engine-side so
// the coordinator never re-types earlier state, while volatile fields (current direction,
// unresolved decisions, next action) are replaced when the delta provides them. An explicitly
// provided empty unresolved-decisions list therefore resolves the decisions; an omitted one keeps
// the previous list.
function mergeBrainstormCheckpointDelta(existing, input) {
  if (!existing || typeof existing !== 'object') return input;
  const raw = input && typeof input === 'object' ? input : {};
  const providedUnresolved = Object.prototype.hasOwnProperty.call(raw, 'unresolvedDecisions')
    || Object.prototype.hasOwnProperty.call(raw, 'unresolved_decisions');
  const base = normalizeCheckpoint(existing);
  const delta = normalizeCheckpoint(raw);
  const mergeList = (previous, next) => {
    const merged = [...previous];
    for (const value of next) if (!merged.includes(value)) merged.push(value);
    return merged;
  };
  const findingKey = finding => JSON.stringify([finding.finding || '', finding.reference || '']);
  const findings = [...base.findings];
  const seenFindings = new Set(findings.map(findingKey));
  for (const finding of delta.findings) {
    if (seenFindings.has(findingKey(finding))) continue;
    findings.push(finding);
    seenFindings.add(findingKey(finding));
  }
  const artifacts = new Map(base.artifacts.map(artifact => [artifact.path, artifact]));
  for (const artifact of delta.artifacts) artifacts.set(artifact.path, artifact);
  return normalizeCheckpoint({
    core_anchor: delta.core_anchor || base.core_anchor,
    findings,
    confirmed_choices: mergeList(base.confirmed_choices, delta.confirmed_choices),
    rejected_alternatives: mergeList(base.rejected_alternatives, delta.rejected_alternatives),
    current_direction: delta.current_direction || base.current_direction,
    unresolved_decisions: providedUnresolved ? delta.unresolved_decisions : base.unresolved_decisions,
    next_action: delta.next_action || base.next_action,
    artifacts: [...artifacts.values()],
  });
}

function registerAgentConversation(root, input) {
  const identity = conversationIdentity(input);
  if (!identity.kind) throw new Error('Agent Conversation registration requires a kind');
  const at = timestamp(input.now);
  return withRegistry(root, (registry, paths) => {
    const existing = registry.conversations[identity.sourceKey];
    if (existing && existing.kind !== identity.kind) throw new Error('Agent Conversation registration kind cannot change');
    registry.conversations[identity.sourceKey] = {
      source_key: identity.sourceKey,
      runtime: identity.runtime,
      kind: identity.kind,
      status: existing?.status || 'warm',
      registered_at: existing?.registered_at || at,
      last_active_at: existing?.last_active_at || at,
      activity_anchor_at: existing?.activity_anchor_at || existing?.last_active_at || at,
      checkpoint: existing?.checkpoint || null,
      checkpoint_revision: existing?.checkpoint_revision || 0,
      sealed_handover_id: existing?.sealed_handover_id || null,
      override: existing?.override || null,
      checkpoint_origin: existing?.checkpoint_origin || null,
      checkpoint_source_digest: existing?.checkpoint_source_digest || null,
      checkpoint_updated_at: existing?.checkpoint_updated_at || null,
    };
    return { sourceKey: identity.sourceKey, ...registry.conversations[identity.sourceKey] };
  });
}

function updateAgentConversationCheckpoint(root, input) {
  const identity = conversationIdentity(input);
  validateAgentConversationCheckpointInput(input.checkpoint);
  const checkpoint = normalizeCheckpoint(input.checkpoint);
  const at = timestamp(input.now);
  if (!hasAgentConversationRegistration(root, input)) {
    throw new Error('Agent Conversation is not registered');
  }
  return withRegistry(root, registry => {
    const conversation = registry.conversations[identity.sourceKey];
    const overrideRefresh = conversation?.status === 'override-active'
      && conversation.override?.status === 'in-flight';
    if (!conversation || (conversation.status !== 'warm' && !overrideRefresh)) {
      throw new Error('Agent Conversation is not warm and registered');
    }
    const origin = input.origin || (conversation.kind === 'pair' ? 'derived' : 'manual');
    if (!CHECKPOINT_ORIGINS.has(origin)) throw new Error('invalid Agent Conversation Checkpoint origin');
    const sourceDigest = input.sourceDigest === undefined ? null : input.sourceDigest;
    if (sourceDigest !== null && !/^[a-f0-9]{64}$/u.test(sourceDigest)) {
      throw new Error('invalid Agent Conversation Checkpoint source digest');
    }
    const unchanged = JSON.stringify(conversation.checkpoint) === JSON.stringify(checkpoint);
    const metadataUnchanged = conversation.checkpoint_origin === origin
      && (conversation.checkpoint_source_digest || null) === sourceDigest;
    if (unchanged && metadataUnchanged && !overrideRefresh && !input.acknowledgeUnchanged) {
      return { sourceKey: identity.sourceKey, revision: conversation.checkpoint_revision, checkpoint, unchanged: true };
    }
    if (!unchanged) conversation.checkpoint = checkpoint;
    conversation.checkpoint_origin = origin;
    conversation.checkpoint_source_digest = sourceDigest;
    conversation.checkpoint_updated_at = at;
    conversation.checkpoint_revision += 1;
    if (overrideRefresh) {
      conversation.override.refreshed_at = at;
      conversation.override.refreshed_checkpoint_revision = conversation.checkpoint_revision;
    }
    return {
      sourceKey: identity.sourceKey,
      revision: conversation.checkpoint_revision,
      checkpoint,
      ...(unchanged ? { unchanged: true, auditableRefresh: true } : {}),
    };
  });
}

function brainstormBootstrapCheckpoint() {
  return {
    currentDirection: 'Brainstorming in progress; the semantic Agent Conversation Checkpoint is pending an explicit refresh.',
    nextAction: 'Refresh the Agent Conversation Checkpoint with the confirmed Core Anchor at the next material boundary.',
  };
}

function ensureBrainstormingRegistration(root, input) {
  const identity = { runtime: input.runtime, agentConversationId: input.agentConversationId, kind: 'brainstorming' };
  if (hasAgentConversationRegistration(root, identity)) {
    return { sourceKey: conversationIdentity(identity).sourceKey, alreadyRegistered: true };
  }
  registerAgentConversation(root, { ...identity, now: input.now });
  const recorded = updateAgentConversationCheckpoint(root, {
    ...identity,
    now: input.now,
    checkpoint: input.checkpoint || brainstormBootstrapCheckpoint(),
    origin: input.checkpoint ? 'manual' : 'bootstrap',
  });
  return { sourceKey: recorded.sourceKey, alreadyRegistered: false, revision: recorded.revision };
}

function mergeFindings(existing, recovered) {
  const merged = new Map();
  for (const finding of [...(existing || []), ...(recovered || [])]) {
    const key = finding?.digest || JSON.stringify(finding);
    if (key) merged.set(key, finding);
  }
  return [...merged.values()];
}

function mergeArtifacts(existing, recovered) {
  const merged = new Map();
  for (const artifact of [...(existing || []), ...(recovered || [])]) {
    if (artifact?.path) merged.set(artifact.path, artifact);
  }
  return [...merged.values()];
}

// A Pair checkpoint has two layers with different authorities. The lifecycle layer (Core Anchor,
// direction, next action, Work projection) is re-derived from the Pair reducer on every Stop and
// must always win. The conversation layer (findings, choices, open decisions) cannot be re-derived
// from `.pair/` at all, so it survives every re-derivation instead of being overwritten by
// derivePairCheckpoint's placeholders.
function mergePairCheckpoint(derived, existing) {
  if (!existing) return derived;
  const preserved = normalizeCheckpoint(existing);
  const conversationLayer = key => (preserved[key].length ? preserved[key] : derived[key]);
  return normalizeCheckpoint({
    core_anchor: derived.core_anchor,
    findings: mergeFindings(preserved.findings, derived.findings),
    confirmed_choices: conversationLayer('confirmed_choices'),
    rejected_alternatives: conversationLayer('rejected_alternatives'),
    current_direction: derived.current_direction,
    unresolved_decisions: preserved.unresolved_decisions,
    next_action: derived.next_action,
    // Derived last so the freshly hashed Work projection always wins over a stale copy of itself;
    // validatePairWorkManifestBinding rejects a handover whose artifact digest has drifted.
    artifacts: mergeArtifacts(preserved.artifacts, derived.artifacts),
  });
}

function mergeRecoveredCheckpoint(conversation, recovered) {
  const existing = conversation.checkpoint || normalizeCheckpoint({});
  const automatic = normalizeCheckpoint(recovered.checkpoint);
  const preservesManualCheckpoint = ['manual', 'manual-recovered'].includes(conversation.checkpoint_origin);
  if (conversation.kind === 'general' && !preservesManualCheckpoint) {
    return { checkpoint: automatic, origin: 'recovered' };
  }
  const latestDirection = safeText(recovered.latestUserDirection, 2048);
  const latestDirectionFinding = latestDirection ? {
    finding: `Latest explicit user direction: ${latestDirection}`,
    reference: 'Recovered from the exact provider transcript as user intent, not external evidence.',
    digest: sha256(latestDirection),
  } : null;
  const recoveredMessageAt = Date.parse(recovered.lastMessageAt);
  const checkpointUpdatedAt = Date.parse(conversation.checkpoint_updated_at);
  const transcriptAdvanced = Number.isFinite(recoveredMessageAt) && (
    !Number.isFinite(checkpointUpdatedAt) || recoveredMessageAt > checkpointUpdatedAt
  );
  const refreshVolatileFields = conversation.kind === 'general' || !preservesManualCheckpoint || transcriptAdvanced;
  return {
    checkpoint: normalizeCheckpoint({
      core_anchor: existing.core_anchor || automatic.core_anchor,
      findings: mergeFindings(existing.findings, [
        ...automatic.findings,
        // A Pair checkpoint keeps repository-derived direction and next action, so the user's own
        // steering would be dropped entirely unless it is preserved as a finding.
        ...(['general', 'pair'].includes(conversation.kind) && latestDirectionFinding ? [latestDirectionFinding] : []),
      ]),
      confirmed_choices: existing.confirmed_choices,
      rejected_alternatives: existing.rejected_alternatives,
      current_direction: refreshVolatileFields
        ? automatic.current_direction || existing.current_direction
        : existing.current_direction || automatic.current_direction,
      unresolved_decisions: refreshVolatileFields
        ? automatic.unresolved_decisions
        : existing.unresolved_decisions,
      next_action: refreshVolatileFields
        ? automatic.next_action || existing.next_action
        : existing.next_action || automatic.next_action,
      artifacts: mergeArtifacts(existing.artifacts, automatic.artifacts),
    }),
    origin: preservesManualCheckpoint ? 'manual-recovered' : 'recovered',
  };
}

function freshStartInstruction(conversation) {
  const handoverId = conversation.sealed_handover_id || null;
  if (!handoverId) return null;
  return `From a plain terminal outside any agent conversation, run pair-loop --fresh-from ${handoverId} --runtime ${conversation.runtime}; or open a fresh ${conversation.runtime} agent conversation manually, then inside it run pair-loop --adopt-handover ${handoverId} --runtime ${conversation.runtime}.`;
}

function repairInstruction(conversation) {
  return `Sealing has not produced an Agent Conversation Handover yet; it retries automatically at the next freshness assessment (any pair-orient or gate run). Check pair-loop --freshness-status --runtime ${conversation.runtime} afterwards; if it still reports no handover, the checkpoint itself is incomplete — refresh it from the source conversation or seal explicitly there with pair-loop --handover-now.`;
}

// `general` is what a conversation gets when nothing declared a kind, so resolving it to `pair`
// once the repository owns a live Pair Work completes an undetermined registration rather than
// changing a declared one. Only this direction is allowed: a declared `brainstorming` conversation
// keeps its kind, and a `pair` conversation never demotes. Without it, a session that started as an
// ordinary conversation and then opened Pair Work could never seal a handover that names the Work.
function promoteGeneralConversationToPairLocked(root, registry, paths, sourceKey) {
  const target = registry.conversations[sourceKey];
  if (target?.kind !== 'general' || !livePairWorkId(root)) return false;
  target.kind = 'pair';
  // The marker carries the kind too, and every withRegistry entry and exit cross-checks the two.
  const marker = path.join(paths.registrations, `${sourceKey}.json`);
  const existing = readJson(marker);
  if (existing) atomicWrite(marker, `${JSON.stringify({ ...existing, kind: 'pair' }, null, 2)}\n`);
  return true;
}

function promoteGeneralConversationToPair(root, conversation) {
  if (conversation?.kind !== 'general' || !livePairWorkId(root)) return false;
  const promoted = withRegistry(root, (registry, paths) => (
    promoteGeneralConversationToPairLocked(root, registry, paths, conversation.source_key)
  ));
  if (promoted) conversation.kind = 'pair';
  return promoted;
}

function prepareAgentConversationStop(root, input) {
  const identity = conversationIdentity(input);
  const registered = hasAgentConversationRegistration(root, input);
  if (!registered && !generalHandoverEnabled(root, input.env || process.env)) {
    return { status: 'unregistered', sourceKey: identity.sourceKey };
  }
  const registry = registered ? readAgentConversationRegistry(root) : null;
  const conversation = registry?.conversations[identity.sourceKey] || null;
  // Sealing is terminal: the checkpoint is already frozen into the Handover, so a later Stop has
  // nothing left to refresh. Refreshing it anyway throws deep in the writer, and the gate then
  // reports a normal sealed conversation as invalid state with no remedy. Report the seal instead.
  if (conversation && !['warm', 'override-active'].includes(conversation.status)) {
    return {
      status: 'terminal',
      sourceKey: identity.sourceKey,
      conversationStatus: conversation.status,
      handoverId: conversation.sealed_handover_id || null,
      nextSafeAction: freshStartInstruction(conversation) || repairInstruction(conversation),
    };
  }
  if (!input.transcriptPath) {
    const completeCheckpoint = conversation?.checkpoint?.core_anchor
      && conversation.checkpoint.current_direction
      && conversation.checkpoint.next_action;
    const manualRefreshAfterLastStop = conversation
      && ['manual', 'manual-recovered'].includes(conversation.checkpoint_origin)
      && completeCheckpoint
      && Date.parse(conversation.checkpoint_updated_at) > Date.parse(conversation.last_active_at);
    const completeBrainstormingCheckpoint = conversation?.kind === 'brainstorming'
      && completeCheckpoint;
    // A Pair conversation loses nothing without a transcript: recordAgentConversationStop
    // re-derives a complete checkpoint from repository authority, so only the recovered
    // conversation layer is missed. That holds for a conversation the repository has just made a
    // Pair one, which is why the resolution runs before the question is asked.
    const derivablePairCheckpoint = conversation?.kind === 'pair'
      || promoteGeneralConversationToPair(root, conversation);
    if (manualRefreshAfterLastStop || completeBrainstormingCheckpoint || derivablePairCheckpoint) {
      return { status: 'registered', sourceKey: identity.sourceKey };
    }
    return { status: 'recovery-unavailable', sourceKey: identity.sourceKey, registered };
  }
  let recovered;
  try {
    recovered = recoverAgentConversationCheckpoint({
      root,
      runtime: identity.runtime,
      agentConversationId: input.agentConversationId,
      transcriptPath: input.transcriptPath,
    });
  } catch (error) {
    // Pair authority never depended on the transcript, so an unreadable or identity-mismatched one
    // costs only the recovered conversation layer. Failing the Stop here would block a Pair turn
    // the repository can already checkpoint completely. Every other kind keeps failing visibly.
    if (conversation?.kind === 'pair') return { status: 'registered', sourceKey: identity.sourceKey };
    throw error;
  }
  if (!registered) {
    // `general` is the fallback for a conversation nothing declared, not a declaration of its own.
    // A repository holding a live Pair Work says what this conversation is doing, and saying it here
    // is what binds the Work projection into the seal and lets repository authority own the next
    // action instead of recovered transcript prose.
    const kind = livePairWorkId(root) ? 'pair' : 'general';
    registerAgentConversation(root, {
      runtime: identity.runtime,
      agentConversationId: input.agentConversationId,
      kind,
      now: input.now,
    });
    const recorded = updateAgentConversationCheckpoint(root, {
      runtime: identity.runtime,
      agentConversationId: input.agentConversationId,
      kind,
      checkpoint: kind === 'pair'
        ? mergePairCheckpoint(derivePairCheckpoint(root), normalizeCheckpoint(recovered.checkpoint))
        : recovered.checkpoint,
      origin: 'recovered',
      sourceDigest: recovered.sourceDigest,
      now: input.now,
    });
    return { status: 'registered', sourceKey: identity.sourceKey, revision: recorded.revision };
  }
  if (!conversation || !['pair', 'brainstorming', 'general'].includes(conversation.kind)) {
    return { status: 'registered', sourceKey: identity.sourceKey };
  }
  // The upgrade has to happen before the merge below, because it decides which layer owns the Core
  // Anchor, the direction and the next action for this very Stop.
  promoteGeneralConversationToPair(root, conversation);
  const merged = mergeRecoveredCheckpoint(conversation, recovered);
  const recorded = updateAgentConversationCheckpoint(root, {
    runtime: identity.runtime,
    agentConversationId: input.agentConversationId,
    kind: conversation.kind,
    checkpoint: conversation.kind === 'pair'
      ? mergePairCheckpoint(derivePairCheckpoint(root), merged.checkpoint)
      : merged.checkpoint,
    origin: merged.origin,
    sourceDigest: recovered.sourceDigest,
    now: input.now,
  });
  return { status: 'checkpointed', sourceKey: identity.sourceKey, revision: recorded.revision };
}

function recordAgentConversationStop(root, input) {
  const identity = conversationIdentity(input);
  if (!hasAgentConversationRegistration(root, input)) {
    return { status: 'unregistered', sourceKey: identity.sourceKey };
  }
  const at = timestamp(input.now);
  const recorded = withRegistry(root, (registry, paths) => {
    const conversation = registry.conversations[identity.sourceKey];
    if (!conversation) throw new Error('invalid Agent Conversation Handover registry');
    promoteGeneralConversationToPairLocked(root, registry, paths, identity.sourceKey);
    if (conversation.status === 'override-active') {
      if (conversation.override?.status !== 'in-flight') {
        return { status: 'override-not-consumed', sourceKey: identity.sourceKey };
      }
      if (conversation.kind === 'pair') {
        const checkpoint = mergePairCheckpoint(derivePairCheckpoint(root), conversation.checkpoint);
        if (JSON.stringify(conversation.checkpoint) !== JSON.stringify(checkpoint)) {
          conversation.checkpoint = checkpoint;
          conversation.checkpoint_revision += 1;
          conversation.checkpoint_updated_at = at;
        }
        if (conversation.checkpoint_revision <= conversation.override.authorized_checkpoint_revision) {
          conversation.checkpoint_revision += 1;
        }
        conversation.override.refreshed_at = at;
        conversation.override.refreshed_checkpoint_revision = conversation.checkpoint_revision;
      }
      if (conversation.checkpoint_revision <= conversation.override.authorized_checkpoint_revision) {
        conversation.status = 'sealed';
        conversation.override = {
          ...conversation.override,
          status: 'failed-no-refresh',
          failed_at: at,
        };
        return {
          status: 'override-failed',
          sourceKey: identity.sourceKey,
          handoverId: conversation.sealed_handover_id,
        };
      }
      return {
        status: 'override-ready',
        sourceKey: identity.sourceKey,
        handoverId: conversation.sealed_handover_id,
      };
    }
    if (conversation.status !== 'warm') return {
      status: conversation.status,
      sourceKey: identity.sourceKey,
      handoverId: conversation.sealed_handover_id || null,
    };
    if (conversation.kind === 'pair') {
      const checkpoint = mergePairCheckpoint(derivePairCheckpoint(root), conversation.checkpoint);
      if (JSON.stringify(conversation.checkpoint) !== JSON.stringify(checkpoint)) {
        conversation.checkpoint = checkpoint;
        conversation.checkpoint_revision += 1;
        conversation.checkpoint_updated_at = at;
      }
    } else if (conversation.kind === 'brainstorming') {
      const checkpoint = deriveBrainstormingCheckpoint(root, conversation.checkpoint);
      if (JSON.stringify(conversation.checkpoint) !== JSON.stringify(checkpoint)) {
        conversation.checkpoint = checkpoint;
        conversation.checkpoint_revision += 1;
        conversation.checkpoint_updated_at = at;
      }
    }
    conversation.last_active_at = at;
    // Stop is the only confirmed turn boundary, so it also re-anchors how far observed activity
    // may carry liveness before the gate reclaims an unstopped turn.
    conversation.activity_anchor_at = at;
    return {
      status: 'warm',
      sourceKey: identity.sourceKey,
      lastActiveAt: at,
      checkpointRevision: conversation.checkpoint_revision,
    };
  });
  if (recorded.status === 'override-not-consumed') {
    throw new Error('cold resume turn was not consumed before Stop');
  }
  if (recorded.status === 'override-failed') {
    throw new Error('cold resume Stop requires a refreshed Agent Conversation Checkpoint');
  }
  if (recorded.status !== 'override-ready') return recorded;
  return completeColdResume(root, {
    ...input,
    runtime: identity.runtime,
    kind: identity.kind || input.kind,
    handoverId: recorded.handoverId,
    now: input.now,
  });
}

// Observed liveness reported by a hook that saw the conversation act (a Pair dispatch) rather than
// finish a turn. It only ever moves activity forward, never resurrects a conversation the gate has
// already sealed, and refuses once the unstopped turn has run past MAX_UNSTOPPED_ACTIVITY_MS from
// its last Stop-confirmed boundary.
function recordAgentConversationActivity(root, input) {
  const identity = conversationIdentity(input);
  if (!hasAgentConversationRegistration(root, input)) {
    return { status: 'unregistered', sourceKey: identity.sourceKey };
  }
  const at = timestamp(input.now);
  return withRegistry(root, registry => {
    const conversation = registry.conversations[identity.sourceKey];
    if (!conversation) throw new Error('invalid Agent Conversation Handover registry');
    if (conversation.status !== 'warm') {
      return {
        status: conversation.status,
        sourceKey: identity.sourceKey,
        handoverId: conversation.sealed_handover_id || null,
      };
    }
    // A registry written before the anchor existed adopts its last Stop as the anchor, and
    // persists it: falling back to last_active_at on every touch would let the ceiling slide
    // forward with the activity it is supposed to bound.
    if (!conversation.activity_anchor_at) conversation.activity_anchor_at = conversation.last_active_at;
    const anchorAt = Date.parse(conversation.activity_anchor_at);
    const lastActiveAt = Date.parse(conversation.last_active_at);
    const observedAt = Date.parse(at);
    if (!Number.isFinite(anchorAt) || !Number.isFinite(lastActiveAt)) {
      return { status: 'invalid-activity', sourceKey: identity.sourceKey };
    }
    if (observedAt - anchorAt > MAX_UNSTOPPED_ACTIVITY_MS) {
      return { status: 'unstopped-ceiling', sourceKey: identity.sourceKey, ageMs: observedAt - anchorAt };
    }
    if (observedAt <= lastActiveAt) {
      return { status: 'warm', sourceKey: identity.sourceKey, lastActiveAt: conversation.last_active_at };
    }
    conversation.last_active_at = at;
    return { status: 'warm', sourceKey: identity.sourceKey, lastActiveAt: at };
  });
}

function activityAge(lastActiveAt, now) {
  const activeAt = Date.parse(lastActiveAt);
  if (!Number.isFinite(activeAt)) return { invalid: 'malformed activity time' };
  if (activeAt > now) return { invalid: 'future activity time' };
  return { ageMs: now - activeAt };
}

function assessAgentConversationFreshness(root, input) {
  const identity = conversationIdentity(input);
  if (!hasAgentConversationRegistration(root, input)) {
    return { status: 'unregistered', sourceKey: identity.sourceKey };
  }
  const now = Number(input.now === undefined ? Date.now() : input.now);
  if (!Number.isFinite(now) || now < 0) throw new Error('Agent Conversation timestamp must be a non-negative finite millisecond value');
  const at = timestamp(now);
  const assessment = withRegistry(root, (registry, paths) => {
    const conversation = registry.conversations[identity.sourceKey];
    if (!conversation) throw new Error('invalid Agent Conversation Handover registry');
    if (conversation.status !== 'warm' && conversation.sealed_handover_id) {
      readAgentConversationHandoverUnchecked(root, conversation.sealed_handover_id, {
        registry,
        skipPairWorkValidation: true,
      });
    }
    if (conversation.status === 'override-active') {
      if (conversation.override?.status === 'allowed-once') {
        conversation.override.status = 'in-flight';
        conversation.override.consumed_at = at;
        return {
          status: 'override-allowed',
          sourceKey: identity.sourceKey,
          handoverId: conversation.sealed_handover_id,
        };
      }
      return {
        status: 'override-consumed',
        sourceKey: identity.sourceKey,
        handoverId: conversation.sealed_handover_id,
      };
    }
    if (conversation.status !== 'warm') {
      const handoverId = conversation.sealed_handover_id || null;
      const claim = handoverId ? registry.handovers[handoverId] : null;
      return {
        status: conversation.status,
        sourceKey: identity.sourceKey,
        handoverId,
        handoverStatus: claim?.status || null,
        retirementReason: conversation.status === 'retired'
          ? claim?.status === 'adopted' ? 'adopted' : claim?.status === 'sealed' ? 'refreshed' : 'invalid'
          : null,
        refreshedHandoverId: conversation.override?.refreshed_handover_id || null,
      };
    }
    const activity = activityAge(conversation.last_active_at, now);
    if (activity.invalid) return { status: 'invalid-activity', sourceKey: identity.sourceKey, diagnostic: activity.invalid };
    if (activity.ageMs < FRESHNESS_WINDOW_MS) return { status: 'warm', sourceKey: identity.sourceKey, ageMs: activity.ageMs };
    const sealed = sealConversation(root, registry, paths, identity, at);
    return { status: 'cold', sourceKey: identity.sourceKey, ageMs: activity.ageMs, ...sealed };
  });
  if (assessment.status === 'cold') withRegistry(root, () => null);
  return assessment;
}

function sealColdAgentConversations(root, input = {}) {
  const now = Number(input.now === undefined ? Date.now() : input.now);
  if (!Number.isFinite(now) || now < 0) throw new Error('Agent Conversation timestamp must be a non-negative finite millisecond value');
  const at = timestamp(now);
  const swept = withRegistry(root, (registry, paths) => {
    const results = [];
    const failures = [];
    for (const conversation of Object.values(registry.conversations)) {
      if (conversation.status !== 'warm' || !conversation.checkpoint) continue;
      const activity = activityAge(conversation.last_active_at, now);
      if (activity.invalid || activity.ageMs < FRESHNESS_WINDOW_MS) continue;
      try {
        const identity = { sourceKey: conversation.source_key, runtime: conversation.runtime };
        const result = sealConversation(root, registry, paths, identity, at);
        results.push({ sourceKey: conversation.source_key, handoverId: result.handoverId });
      } catch (error) {
        // A single conversation's failure to seal must not abort the others, but a swallowed
        // failure left conversations cold and handoverless with nothing naming the reason.
        failures.push({ sourceKey: conversation.source_key, error: error.message });
      }
    }
    return { results, failures };
  });
  if (swept.results.length) withRegistry(root, () => null);
  return { sealed: swept.results, failures: swept.failures };
}

function freshnessProjection(root, now = Date.now()) {
  const observedAt = timestamp(now);
  let registry;
  try {
    registry = readAgentConversationRegistry(root);
  } catch {
    return {
      observed_at: observedAt,
      conversations: [],
      unavailable: true,
      warning: 'Freshness Gate state is unavailable; registered Agent Conversations fail closed at UserPromptSubmit.',
    };
  }
  const conversations = Object.values(registry.conversations).map(conversation => {
    const activeAt = Date.parse(conversation.last_active_at);
    const invalidActivity = !Number.isFinite(activeAt) || activeAt > now;
    const ageMs = invalidActivity ? null : now - activeAt;
    const projectedStatus = conversation.status === 'warm'
      ? invalidActivity ? 'invalid-activity' : ageMs >= FRESHNESS_WINDOW_MS ? 'cold' : 'warm'
      : conversation.status;
    const handoverId = conversation.sealed_handover_id || null;
    const freshStart = freshStartInstruction(conversation);
    const repairFallback = repairInstruction(conversation);
    const nextSafeAction = ['cold', 'sealed'].includes(projectedStatus)
      ? freshStart || repairFallback
      : projectedStatus === 'retired'
        ? handoverId && registry.handovers[handoverId]?.status === 'sealed'
          ? freshStart
          : 'Use the adopted fresh Agent Conversation.'
        : projectedStatus === 'warm'
          ? `Continue in this ${conversation.runtime} Agent Conversation before the freshness deadline.`
          : projectedStatus === 'override-active'
            ? 'Finish the one authorized turn, refresh its Agent Conversation Checkpoint, and stop.'
            : repairFallback;
    return {
      runtime: conversation.runtime,
      kind: conversation.kind,
      source_key: conversation.source_key,
      status: projectedStatus,
      age_ms: ageMs,
      remaining_ms: invalidActivity ? null : Math.max(0, FRESHNESS_WINDOW_MS - ageMs),
      deadline_at: invalidActivity ? null : new Date(activeAt + FRESHNESS_WINDOW_MS).toISOString(),
      checkpoint_revision: conversation.checkpoint_revision,
      checkpoint_sha256: conversation.checkpoint ? sha256(JSON.stringify(conversation.checkpoint)) : null,
      handover_id: handoverId,
      retirement_reason: projectedStatus === 'retired'
        ? registry.handovers[handoverId]?.status === 'sealed' ? 'refreshed' : 'adopted'
        : null,
      next_safe_action: nextSafeAction,
    };
  });
  // The one-line warning recommends the most recently active stale conversation — registration
  // order would surface a days-old handover ahead of the one the user actually needs next.
  // invalid-activity rows carry a null age and rank last. A retired conversation's next safe action
  // is "use the adopted one" — advice, not an action — so it never shadows a real pending handover.
  const byAge = (a, b) => (a.age_ms ?? Number.POSITIVE_INFINITY) - (b.age_ms ?? Number.POSITIVE_INFINITY);
  const pending = conversations
    .filter(conversation => ['cold', 'sealed', 'invalid-activity'].includes(conversation.status))
    .sort(byAge);
  const requiringHandover = pending[0]
    || conversations.filter(conversation => conversation.status === 'retired').sort(byAge)[0];
  return {
    observed_at: observedAt,
    conversations,
    warning: requiringHandover
      ? requiringHandover.next_safe_action
        ? `Freshness Gate: ${requiringHandover.status}; ${requiringHandover.next_safe_action}`
        : `Freshness Gate: ${requiringHandover.status}.`
      : null,
  };
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds)) return 'unknown';
  const absolute = Math.max(0, Math.floor(milliseconds));
  const hours = Math.floor(absolute / 3_600_000);
  const minutes = Math.floor((absolute % 3_600_000) / 60_000);
  const seconds = Math.floor((absolute % 60_000) / 1_000);
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function freshnessConversationFields(conversation) {
  return [
    `age ${formatDuration(conversation.age_ms)}`,
    `remaining ${formatDuration(conversation.remaining_ms)}`,
    `deadline ${conversation.deadline_at || 'invalid'}`,
    `checkpoint r${conversation.checkpoint_revision} sha256:${conversation.checkpoint_sha256 || 'none'}`,
    `handover ${conversation.handover_id || 'none'}`,
    `next safe action: ${conversation.next_safe_action || 'none'}`,
  ];
}

function formatFreshnessProjection(projection, options = {}) {
  const conversations = projection?.conversations || [];
  if (conversations.length === 0) {
    return projection?.warning || 'Freshness Gate: no registered Agent Conversations.';
  }
  if (options.currentSourceKey === undefined) {
    const lines = conversations.map(conversation => [
      `Freshness Gate ${conversation.runtime}/${conversation.kind}: ${conversation.status}`,
      ...freshnessConversationFields(conversation),
    ].join(options.compact ? ' | ' : '\n  '));
    if (projection.warning) lines.push(projection.warning);
    return lines.join(options.compact ? ' || ' : '\n');
  }
  const current = conversations.find(conversation => conversation.source_key === options.currentSourceKey);
  const others = conversations.filter(conversation => conversation !== current);
  // The scoped banner opens every session, and a registry accumulates settled conversations forever:
  // nine terminal rows drowned the one line that named an action. Live conversations and the most
  // recently active stale one render; the rest collapse to a count, with the full list one command away.
  const live = others.filter(conversation => ['warm', 'override-active'].includes(conversation.status));
  const actionable = others
    .filter(conversation => ['cold', 'sealed', 'invalid-activity'].includes(conversation.status))
    .sort((a, b) => (a.age_ms ?? Number.POSITIVE_INFINITY) - (b.age_ms ?? Number.POSITIVE_INFINITY))
    .slice(0, 1);
  const settled = others.filter(conversation => !live.includes(conversation) && !actionable.includes(conversation));
  const lines = [current
    ? [
      `Freshness Gate (this Agent Conversation) ${current.runtime}/${current.kind}: ${current.status}`,
      ...freshnessConversationFields(current),
    ].join('\n  ')
    : 'Freshness Gate (this Agent Conversation): this Agent Conversation is not registered; the Freshness Gate does not gate it.'];
  for (const conversation of [...live, ...actionable]) {
    lines.push([
      `Freshness Gate (other) ${conversation.runtime}/${conversation.kind}: ${conversation.status}`,
      ...freshnessConversationFields(conversation),
    ].join(' | '));
  }
  if (settled.length > 0) {
    const counts = settled.reduce((sum, conversation) => sum.set(conversation.status, (sum.get(conversation.status) || 0) + 1), new Map());
    const detail = [...counts.entries()].map(([status, count]) => `${count} ${status}`).join(', ');
    lines.push(`Freshness Gate: ${settled.length} settled Agent Conversation(s) omitted (${detail}); pair-loop --freshness-status lists them.`);
  }
  if (projection.warning) lines.push(projection.warning);
  return lines.join('\n');
}

function assertHandoverId(handoverId) {
  if (!HANDOVER_ID.test(String(handoverId || ''))) throw new Error('invalid handover ID');
  return handoverId;
}

function safeHandoverDirectory(root, handoverId) {
  assertHandoverId(handoverId);
  const paths = validateHandoverRoot(root);
  const directory = path.join(paths.directory, handoverId);
  const rootDirectory = path.resolve(paths.directory);
  if (!path.resolve(directory).startsWith(`${rootDirectory}${path.sep}`)) throw new Error('invalid handover ID');
  const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) throw new Error('invalid handover');
  return directory;
}

function stagingDirectory(paths, handoverId) {
  assertHandoverId(handoverId);
  return path.join(paths.directory, `.staging-${handoverId}`);
}

function recoverSealedHandoverTransactions(paths, registry) {
  const stagedClaims = new Map();
  for (const handover of Object.values(registry.handovers)) {
    if (!handover?.stage_directory) continue;
    const expected = `.staging-${handover.handover_id}`;
    if (handover.stage_directory !== expected || !HANDOVER_ID.test(handover.handover_id || '')) {
      throw new Error('invalid Agent Conversation Handover staging claim');
    }
    stagedClaims.set(handover.stage_directory, handover);
  }
  for (const entry of fs.readdirSync(paths.directory, { withFileTypes: true })) {
    if (!entry.name.startsWith('.staging-')) continue;
    const directory = path.join(paths.directory, entry.name);
    const claim = stagedClaims.get(entry.name);
    if (!claim) {
      fs.rmSync(directory, { recursive: true, force: true });
      continue;
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error('invalid Agent Conversation Handover staging directory');
    }
    const finalDirectory = path.join(paths.directory, claim.handover_id);
    const finalStat = fs.lstatSync(finalDirectory, { throwIfNoEntry: false });
    if (finalStat) throw new Error('invalid Agent Conversation Handover staging conflict');
    fs.renameSync(directory, finalDirectory);
    delete claim.stage_directory;
  }
  for (const handover of Object.values(registry.handovers)) {
    if (!handover?.stage_directory) continue;
    const finalDirectory = path.join(paths.directory, handover.handover_id);
    const finalStat = fs.lstatSync(finalDirectory, { throwIfNoEntry: false });
    if (!finalStat || !finalStat.isDirectory() || finalStat.isSymbolicLink()) {
      throw new Error('incomplete Agent Conversation Handover staging claim');
    }
    delete handover.stage_directory;
  }
}

function readSafeFile(directory, name) {
  const file = path.join(directory, name);
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) throw new Error('invalid handover');
  return fs.readFileSync(file, 'utf8');
}

function validEventTimestamp(value) {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function validateHandoverEventShape(event) {
  if (!isPlainObject(event) || !validEventTimestamp(event.at)) throw new Error('invalid handover');
  const keys = Object.keys(event).sort().join(',');
  if (event.event === 'handover.sealed') {
    if (
      keys !== 'at,checkpoint_sha256,event,source_key' ||
      !/^[a-f0-9]{64}$/u.test(event.source_key || '') ||
      !/^[a-f0-9]{64}$/u.test(event.checkpoint_sha256 || '')
    ) throw new Error('invalid handover');
    return;
  }
  if (event.event === 'handover.adopted') {
    if (keys !== 'adopter_key,at,event' || !/^[a-f0-9]{64}$/u.test(event.adopter_key || '')) {
      throw new Error('invalid handover');
    }
    return;
  }
  if (event.event === 'cold-resume.authorized' || event.event === 'cold-resume.completed') {
    if (keys !== 'at,event,source_key' || !/^[a-f0-9]{64}$/u.test(event.source_key || '')) {
      throw new Error('invalid handover');
    }
    return;
  }
  throw new Error('invalid handover');
}

function readRawHandoverEvents(directory) {
  const bytes = readSafeFile(directory, 'events.jsonl');
  if (!bytes || !bytes.endsWith('\n')) throw new Error('invalid handover');
  return bytes.slice(0, -1).split('\n').map(line => {
    if (!line.trim()) throw new Error('invalid handover');
    try {
      const event = JSON.parse(line);
      validateHandoverEventShape(event);
      return event;
    } catch {
      throw new Error('invalid handover');
    }
  });
}

function appendHandoverEvent(directory, event) {
  validateHandoverEventShape(event);
  const file = path.join(directory, 'events.jsonl');
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error('invalid handover');
  fs.appendFileSync(file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // See ensurePrivateDirectory.
  }
}

function pairWorkReference(root) {
  const engine = engineWork(root);
  const workId = engine ? engine.workId : loadPairState(root).work_id || null;
  const projectionPath = engine ? engine.paths.state : pairStatePaths(root, workId).state;
  return {
    work_id: workId,
    projection_path: path.relative(root, projectionPath).split(path.sep).join('/'),
    projection_sha256: sha256(fs.readFileSync(projectionPath)),
  };
}

// The engine records the next action itself — "run Review Slice S-01", "human review corrected
// checkpoint 687c292a" — so the checkpoint quotes it rather than paraphrasing a phase name. The
// Core Anchor carries the lifecycle for the same reason a stale one is dangerous: an adopting
// conversation that reads "correction UNSPENT" long after the correction was spent will act on it.
function deriveEngineCheckpoint(root, engine) {
  const { state } = engine;
  const active = (state.slices || []).find(slice => slice.status && slice.status !== 'accepted') || null;
  return normalizeCheckpoint({
    coreAnchor: `Continue Pair Work ${engine.workId} from repository authority at lifecycle ${state.lifecycle}${active ? `, Review Slice ${active.id} (${active.status})` : ''}.`,
    findings: [],
    confirmedChoices: ['Pair Work lifecycle remains authoritative in the Pair engine.'],
    rejectedAlternatives: ['Copy Pair Work lifecycle into Agent Conversation Handover state.'],
    currentDirection: active
      ? `Continue Review Slice ${active.id} at ${active.status}.`
      : `Continue Pair at ${state.lifecycle}.`,
    unresolvedDecisions: [],
    nextAction: state.next_action || `Inspect Pair status at ${state.lifecycle} and advance it.`,
    artifacts: [{
      path: path.relative(root, engine.paths.state).split(path.sep).join('/'),
      sha256: sha256(fs.readFileSync(engine.paths.state)),
    }],
  });
}

function derivePairCheckpoint(root) {
  const engine = engineWork(root);
  if (engine) return deriveEngineCheckpoint(root, engine);
  const state = loadPairState(root);
  const pairWork = pairWorkReference(root);
  return normalizeCheckpoint({
    coreAnchor: state.work_id ? `Continue Pair Work ${state.work_id} from repository authority.` : 'Continue the active Pair Work from repository authority.',
    findings: [],
    confirmedChoices: ['Pair Work lifecycle remains authoritative in the Pair reducer.'],
    rejectedAlternatives: ['Copy Pair Work lifecycle into Agent Conversation Handover state.'],
    currentDirection: state.active?.task_id ? `Continue Review Slice ${state.active.task_id} at ${state.active.phase || state.lifecycle}.` : `Continue Pair at ${state.lifecycle}.`,
    unresolvedDecisions: [],
    nextAction: state.continuation?.resume_target || state.active?.phase || 'Inspect Pair status and advance the saved phase.',
    artifacts: pairWork ? [{ path: pairWork.projection_path, sha256: pairWork.projection_sha256 }] : [],
  });
}

function validatePairWorkReference(root, reference, kind) {
  if (reference === null && kind !== 'pair') return;
  if (!reference || typeof reference !== 'object') throw new Error('invalid handover');
  if (reference.work_id !== null && !String(reference.work_id || '').trim()) throw new Error('invalid handover');
  const engine = engineWork(root);
  const currentWorkId = engine ? engine.workId : loadPairState(root).work_id;
  if (currentWorkId !== reference.work_id) throw new Error('invalid handover');
  if (!/^[a-f0-9]{64}$/u.test(reference.projection_sha256 || '')) throw new Error('invalid handover');
  const projectionFile = engine ? engine.paths.state : pairStatePaths(root, reference.work_id).state;
  if (reference.projection_path !== path.relative(root, projectionFile).split(path.sep).join('/')) throw new Error('invalid handover');
  const projection = fs.lstatSync(projectionFile, { throwIfNoEntry: false });
  if (!projection || !projection.isFile() || projection.isSymbolicLink()) throw new Error('invalid handover');
  if (sha256(fs.readFileSync(projectionFile)) !== reference.projection_sha256) throw new Error('invalid handover');
}

function validatePairWorkManifestBinding(root, reference, kind, checkpoint) {
  if (kind !== 'pair') {
    if (reference !== null) throw new Error('invalid handover');
    return;
  }
  if (!isPlainObject(reference)) throw new Error('invalid handover');
  if (reference.work_id !== null && !String(reference.work_id || '').trim()) throw new Error('invalid handover');
  if (Object.keys(reference).sort().join(',') !== 'projection_path,projection_sha256,work_id') throw new Error('invalid handover');
  if (!/^[a-f0-9]{64}$/u.test(reference.projection_sha256 || '')) throw new Error('invalid handover');
  if (reference.projection_path !== pairProjectionPath(root, reference.work_id)) throw new Error('invalid handover');
  const artifact = checkpoint.artifacts?.find(candidate => (
    candidate.path === reference.projection_path && candidate.sha256 === reference.projection_sha256
  ));
  if (!artifact) throw new Error('invalid handover');
}

function nonPairArtifactMatchesDisk(root, rootReal, artifact) {
  const absolute = path.resolve(root, artifact.path);
  const relative = path.relative(root, absolute).split(path.sep).join('/');
  const stat = fs.lstatSync(absolute, { throwIfNoEntry: false });
  if (
    relative !== artifact.path ||
    relative === '..' ||
    relative.startsWith('../') ||
    !stat ||
    !stat.isFile() ||
    stat.isSymbolicLink()
  ) {
    return false;
  }
  const real = fs.realpathSync(absolute);
  if (real !== rootReal && !real.startsWith(`${rootReal}${path.sep}`)) return false;
  return sha256(fs.readFileSync(real)) === artifact.sha256;
}

function validateNonPairArtifactDigests(root, checkpoint, kind) {
  if (kind === 'pair') return;
  const rootReal = fs.realpathSync(root);
  for (const artifact of checkpoint.artifacts || []) {
    if (!nonPairArtifactMatchesDisk(root, rootReal, artifact)) {
      throw new Error(`Agent Conversation Checkpoint artifact is missing or changed: ${artifact.path}`);
    }
  }
}

// A brainstorming or general checkpoint pins evidence digests at checkpoint time, but sealing runs
// later — often after the designed work was implemented and those very files changed. Refusing the
// seal would trade the entire handover for a stale digest, so drift demotes the artifact to a
// bounded finding instead and the seal proceeds with the artifacts that still match.
function settleNonPairArtifactDrift(root, checkpoint) {
  const rootReal = fs.realpathSync(root);
  const kept = [];
  const dropped = [];
  for (const artifact of checkpoint.artifacts || []) {
    (nonPairArtifactMatchesDisk(root, rootReal, artifact) ? kept : dropped).push(artifact);
  }
  if (!dropped.length) return { checkpoint, dropped: [] };
  const driftFinding = {
    finding: `Artifacts changed or disappeared after this checkpoint and were dropped from the handover: ${dropped.map(artifact => artifact.path).join(', ')}`,
    digest: null,
  };
  return {
    checkpoint: normalizeCheckpoint({
      ...checkpoint,
      findings: [...(checkpoint.findings || []), driftFinding],
      artifacts: kept,
    }),
    dropped: dropped.map(artifact => artifact.path),
  };
}

function expectedPairOwnershipExists(root, identity, agentConversationId, expectedWorkId) {
  if (engineWorkId(root) === expectedWorkId) {
    const owner = engineOwner(root, expectedWorkId);
    return owner?.owner_session_id === String(agentConversationId) && owner?.owner_runtime === identity.runtime;
  }
  const current = loadPairState(root);
  if (current.work_id !== expectedWorkId) return false;
  const state = loadPairState(root, expectedWorkId);
  return state.continuation?.owner_session_id === String(agentConversationId)
    && state.continuation?.owner_runtime === identity.runtime;
}

function assertPairWorkIdleForAdoption(root, reference) {
  if (!reference) return null;
  const engine = engineWork(root);
  if (engine) {
    if (engine.workId !== reference.work_id) {
      throw new Error('Pair Work changed before Agent Conversation Handover adoption');
    }
    const lease = engineVerificationOwner(root, reference.work_id);
    if (lease) {
      throw new Error(`cannot adopt Agent Conversation Handover while a verification of ${reference.work_id} is running (pid ${lease.pid}, since ${lease.at})`);
    }
    return engine.state;
  }
  const current = loadPairState(root);
  if (current.work_id !== reference.work_id) {
    throw new Error('Pair Work changed before Agent Conversation Handover adoption');
  }
  const state = loadPairState(root, reference.work_id);
  if (state.in_flight_request) {
    throw new Error(`cannot adopt Agent Conversation Handover while Pair request ${state.in_flight_request.request_id || 'unknown'} is in flight`);
  }
  return state;
}

function assertCheckpointQuality(checkpoint, kind) {
  if (!checkpoint?.current_direction || !checkpoint?.next_action) {
    throw new Error('Agent Conversation Checkpoint requires current direction and next action before sealing');
  }
  if (kind !== 'pair' && !checkpoint.core_anchor) {
    throw new Error('Agent Conversation Checkpoint requires a Core Anchor before sealing');
  }
}

function sealConversation(root, registry, paths, identity, at) {
    const conversation = registry.conversations[identity.sourceKey];
    if (!conversation || conversation.status !== 'warm' || !conversation.checkpoint) throw new Error('Agent Conversation requires a warm checkpoint before sealing');
    if (conversation.sealed_handover_id) return { handoverId: conversation.sealed_handover_id, sourceKey: identity.sourceKey, alreadySealed: true };
    if (conversation.kind === 'pair') {
      // The same two-layer merge every other Pair refresh uses. Assigning the bare derivation here
      // dropped the entire conversation layer at the last possible moment — findings, confirmed
      // choices, rejected alternatives — leaving the adopting conversation a lifecycle pointer and
      // nothing that was learned. The layer cannot be re-derived from the repository, so a seal is
      // the one place it must not be discarded.
      const checkpoint = mergePairCheckpoint(derivePairCheckpoint(root), conversation.checkpoint);
      if (JSON.stringify(conversation.checkpoint) !== JSON.stringify(checkpoint)) {
        conversation.checkpoint = checkpoint;
        conversation.checkpoint_revision += 1;
      }
    } else if (conversation.kind === 'brainstorming') {
      const checkpoint = deriveBrainstormingCheckpoint(root, conversation.checkpoint);
      if (JSON.stringify(conversation.checkpoint) !== JSON.stringify(checkpoint)) {
        conversation.checkpoint = checkpoint;
        conversation.checkpoint_revision += 1;
      }
    }
    if (conversation.kind !== 'pair') {
      const settled = settleNonPairArtifactDrift(root, conversation.checkpoint);
      if (settled.dropped.length) {
        conversation.checkpoint = settled.checkpoint;
        conversation.checkpoint_revision += 1;
      }
    }
    assertCheckpointQuality(conversation.checkpoint, conversation.kind);
    validateNonPairArtifactDigests(root, conversation.checkpoint, conversation.kind);
    const handoverId = `handover-${crypto.randomUUID()}`;
    const directory = stagingDirectory(paths, handoverId);
    ensurePrivateDirectory(directory);
    const checkpointBytes = JSON.stringify(conversation.checkpoint);
    const pairWork = conversation.kind === 'pair' ? pairWorkReference(root) : null;
    validatePairWorkManifestBinding(root, pairWork, conversation.kind, conversation.checkpoint);
    const manifest = {
      schema: HANDOVER_SCHEMA,
      handover_id: handoverId,
      source_key: identity.sourceKey,
      runtime: identity.runtime,
      kind: conversation.kind,
      created_at: at,
      checkpoint_revision: conversation.checkpoint_revision,
      checkpoint_sha256: sha256(checkpointBytes),
      checkpoint_bytes: Buffer.byteLength(checkpointBytes, 'utf8'),
      checkpoint_origin: conversation.checkpoint_origin || null,
      checkpoint_source_digest: conversation.checkpoint_source_digest || null,
      checkpoint_updated_at: conversation.checkpoint_updated_at || null,
      pair_work: pairWork,
    };
    const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
    atomicWrite(path.join(directory, 'checkpoint.md'), checkpointBytes);
    atomicWrite(path.join(directory, 'manifest.json'), manifestBytes);
    appendHandoverEvent(directory, { event: 'handover.sealed', at, source_key: identity.sourceKey, checkpoint_sha256: manifest.checkpoint_sha256 });
    conversation.status = 'sealed';
    conversation.sealed_handover_id = handoverId;
    registry.handovers[handoverId] = {
      handover_id: handoverId,
      source_key: identity.sourceKey,
      status: 'sealed',
      created_at: at,
      override_used: false,
      runtime: identity.runtime,
      kind: conversation.kind,
      checkpoint_revision: conversation.checkpoint_revision,
      checkpoint_sha256: manifest.checkpoint_sha256,
      checkpoint_origin: manifest.checkpoint_origin,
      checkpoint_source_digest: manifest.checkpoint_source_digest,
      checkpoint_updated_at: manifest.checkpoint_updated_at,
      manifest_sha256: sha256(manifestBytes),
      stage_directory: path.basename(directory),
    };
    return { handoverId, sourceKey: identity.sourceKey, checkpointSha256: manifest.checkpoint_sha256 };
}

function sealAgentConversationHandover(root, input) {
  const identity = conversationIdentity(input);
  const at = timestamp(input.now);
  const sealed = withRegistry(root, (registry, paths) => {
    return sealConversation(root, registry, paths, identity, at);
  });
  withRegistry(root, () => null);
  return sealed;
}

function expectedHandoverEvents(manifest, claim) {
  const expected = [{
    event: 'handover.sealed',
    at: manifest.created_at,
    source_key: manifest.source_key,
    checkpoint_sha256: manifest.checkpoint_sha256,
  }];
  if (claim.override_used) {
    if (!validEventTimestamp(claim.override_authorized_at)) throw new Error('invalid handover');
    expected.push({
      event: 'cold-resume.authorized',
      at: claim.override_authorized_at,
      source_key: manifest.source_key,
    });
  }
  if (claim.status === 'refreshed') {
    if (!validEventTimestamp(claim.override_completed_at)) throw new Error('invalid handover');
    expected.push({
      event: 'cold-resume.completed',
      at: claim.override_completed_at,
      source_key: manifest.source_key,
    });
  }
  if (claim.status === 'adopted') {
    if (!validEventTimestamp(claim.adopted_at) || !/^[a-f0-9]{64}$/u.test(claim.adopted_by || '')) {
      throw new Error('invalid handover');
    }
    expected.push({
      event: 'handover.adopted',
      at: claim.adopted_at,
      adopter_key: claim.adopted_by,
    });
  }
  return expected;
}

function readHandoverEvents(directory, manifest, claim) {
  const expected = expectedHandoverEvents(manifest, claim);
  let events = readRawHandoverEvents(directory);
  if (
    events.length > expected.length ||
    events.some((event, index) => JSON.stringify(event) !== JSON.stringify(expected[index]))
  ) throw new Error('invalid handover');
  for (const event of expected.slice(events.length)) {
    appendHandoverEvent(directory, event);
  }
  events = readRawHandoverEvents(directory);
  if (
    events.length !== expected.length ||
    events.some((event, index) => JSON.stringify(event) !== JSON.stringify(expected[index]))
  ) throw new Error('invalid handover');
  return events;
}

function assertCurrentLaunchableHandover(registry, handoverId) {
  const handover = registry.handovers[handoverId];
  if (!handover) throw new Error('invalid handover');
  if (handover.status === 'refreshed' && HANDOVER_ID.test(handover.refreshed_handover_id || '')) {
    throw new Error(`Agent Conversation Handover ${handoverId} was refreshed; use ${handover.refreshed_handover_id}`);
  }
  if (handover.status === 'adopted') throw new Error('Agent Conversation Handover was already adopted');
  if (handover.status !== 'sealed') throw new Error('invalid handover');
  const source = registry.conversations[handover.source_key];
  if (!source || source.sealed_handover_id !== handoverId || !['sealed', 'retired'].includes(source.status)) {
    throw new Error('invalid handover');
  }
}

function readAgentConversationHandoverUnchecked(root, handoverId, options = {}) {
  const registry = options.registry;
  if (!validRegistry(registry)) throw new Error('invalid handover');
  const claim = registry.handovers[handoverId];
  const source = claim && registry.conversations[claim.source_key];
  if (!claim || !source) throw new Error('invalid handover');
  if (options.requireCurrent) assertCurrentLaunchableHandover(registry, handoverId);
  const directory = safeHandoverDirectory(root, handoverId);
  let manifest;
  let manifestBytes;
  try {
    manifestBytes = readSafeFile(directory, 'manifest.json');
    manifest = JSON.parse(manifestBytes);
  } catch {
    throw new Error('invalid handover');
  }
  const checkpointBytes = readSafeFile(directory, 'checkpoint.md');
  const baseManifestKeys = [
    'checkpoint_bytes', 'checkpoint_revision', 'checkpoint_sha256', 'created_at', 'handover_id',
    'kind', 'pair_work', 'runtime', 'schema', 'source_key',
  ];
  const checkpointMetadataKeys = ['checkpoint_origin', 'checkpoint_source_digest', 'checkpoint_updated_at'];
  const manifestKeys = Object.keys(manifest || {});
  const hasCheckpointMetadata = checkpointMetadataKeys.some(key => manifestKeys.includes(key));
  const expectedManifestKeys = hasCheckpointMetadata
    ? [...baseManifestKeys, ...checkpointMetadataKeys]
    : baseManifestKeys;
  if (
    !isPlainObject(manifest) ||
    manifestKeys.sort().join(',') !== expectedManifestKeys.sort().join(',') ||
    manifest?.schema !== HANDOVER_SCHEMA ||
    manifest.handover_id !== handoverId ||
    manifest.source_key !== claim.source_key ||
    manifest.runtime !== source.runtime ||
    !RUNTIMES.has(manifest.runtime) ||
    !KINDS.has(manifest.kind) ||
    manifest.kind !== source.kind ||
    manifest.created_at !== claim.created_at ||
    !Number.isInteger(manifest.checkpoint_revision) ||
    manifest.checkpoint_revision < 0 ||
    !/^[a-f0-9]{64}$/u.test(manifest.checkpoint_sha256 || '') ||
    manifest.checkpoint_sha256 !== sha256(checkpointBytes) ||
    manifest.checkpoint_bytes !== Buffer.byteLength(checkpointBytes, 'utf8') ||
    Buffer.byteLength(checkpointBytes, 'utf8') > MAX_CHECKPOINT_BYTES
  ) throw new Error('invalid handover');
  if (hasCheckpointMetadata && (
    (manifest.checkpoint_origin !== null && !CHECKPOINT_ORIGINS.has(manifest.checkpoint_origin)) ||
    (manifest.checkpoint_source_digest !== null && !/^[a-f0-9]{64}$/u.test(manifest.checkpoint_source_digest || '')) ||
    (manifest.checkpoint_updated_at !== null && !validEventTimestamp(manifest.checkpoint_updated_at))
  )) throw new Error('invalid handover');
  let checkpoint;
  try {
    checkpoint = JSON.parse(checkpointBytes);
  } catch {
    throw new Error('invalid handover');
  }
  if (!isPlainObject(checkpoint) || checkpointBytes !== JSON.stringify(checkpoint)) throw new Error('invalid handover');
  if (checkpointBytes !== JSON.stringify(normalizeCheckpoint(checkpoint))) throw new Error('invalid handover');
  validatePairWorkManifestBinding(root, manifest.pair_work, manifest.kind, checkpoint);
  // Artifact digests are deliberately not re-validated against the worktree here: this read path
  // serves freshness assessment and adoption long after sealing, when the repository has usually
  // moved on. Repo evolution is not corruption — handover integrity is already bound by
  // checkpoint_sha256/manifest_sha256 above, and adoption settles drift into findings instead.
  const modernClaim = claim.runtime !== undefined || claim.kind !== undefined ||
    claim.checkpoint_revision !== undefined || claim.checkpoint_sha256 !== undefined;
  if (modernClaim) {
    if (
      claim.runtime !== manifest.runtime ||
      claim.kind !== manifest.kind ||
      claim.checkpoint_revision !== manifest.checkpoint_revision ||
      claim.checkpoint_sha256 !== manifest.checkpoint_sha256 ||
      (hasCheckpointMetadata && (
        claim.checkpoint_origin !== manifest.checkpoint_origin ||
        claim.checkpoint_source_digest !== manifest.checkpoint_source_digest ||
        claim.checkpoint_updated_at !== manifest.checkpoint_updated_at
      ))
    ) throw new Error('invalid handover');
  } else {
    const sourceCheckpointBytes = source.checkpoint ? JSON.stringify(source.checkpoint) : null;
    if (
      source.checkpoint_revision !== manifest.checkpoint_revision ||
      sourceCheckpointBytes !== checkpointBytes
    ) throw new Error('invalid handover');
    claim.runtime = manifest.runtime;
    claim.kind = manifest.kind;
    claim.checkpoint_revision = manifest.checkpoint_revision;
    claim.checkpoint_sha256 = manifest.checkpoint_sha256;
  }
  if (
    source.sealed_handover_id === handoverId &&
    ['sealed', 'retired'].includes(source.status) &&
    (
      source.checkpoint_revision !== manifest.checkpoint_revision ||
      JSON.stringify(source.checkpoint) !== checkpointBytes ||
      (hasCheckpointMetadata && (
        (source.checkpoint_origin || null) !== manifest.checkpoint_origin ||
        (source.checkpoint_source_digest || null) !== manifest.checkpoint_source_digest ||
        (source.checkpoint_updated_at || null) !== manifest.checkpoint_updated_at
      ))
    )
  ) throw new Error('invalid handover');
  const manifestDigest = sha256(manifestBytes);
  if (claim.manifest_sha256 === undefined) claim.manifest_sha256 = manifestDigest;
  else if (claim.manifest_sha256 !== manifestDigest) throw new Error('invalid handover');
  const events = readHandoverEvents(directory, manifest, claim);
  if (!options.skipPairWorkValidation) {
    validatePairWorkReference(root, manifest.pair_work, manifest.kind);
  }
  return { manifest, checkpoint, directory, events };
}

function readAgentConversationHandover(root, handoverId) {
  assertHandoverId(handoverId);
  return withRegistry(root, registry => readAgentConversationHandoverUnchecked(root, handoverId, {
    registry,
    requireCurrent: true,
  }));
}

function readAgentConversationHandoverForAdoption(root, handoverId, input) {
  assertHandoverId(handoverId);
  const identity = conversationIdentity(input);
  return withRegistry(root, registry => {
    const claim = registry.handovers[handoverId];
    const source = claim && registry.conversations[claim.source_key];
    if (!claim || !source || source.sealed_handover_id !== handoverId) throw new Error('invalid handover');
    if (claim.status === 'adopting' && claim.adopting_by !== identity.sourceKey) throw new Error('invalid handover or adoption already claimed');
    if (claim.status === 'adopted' && claim.adopted_by !== identity.sourceKey) throw new Error('invalid handover or already adopted');
    if (!['sealed', 'adopting', 'adopted'].includes(claim.status)) throw new Error('invalid handover');
    return readAgentConversationHandoverUnchecked(root, handoverId, {
      registry,
      skipPairWorkValidation: true,
    });
  });
}

function adoptAgentConversationHandover(root, input) {
  const handoverId = assertHandoverId(input.handoverId);
  const identity = conversationIdentity({ ...input, kind: input.kind || 'pair' });
  const at = timestamp(input.now);
  const prepared = withRegistry(root, registry => {
    const handover = registry.handovers[handoverId];
    if (!handover) throw new Error('invalid handover');
    const bundle = readAgentConversationHandoverUnchecked(root, handoverId, {
      registry,
      skipPairWorkValidation: true,
    });
    if (handover.status === 'adopted') {
      if (handover.adopted_by !== identity.sourceKey) {
        throw new Error('invalid handover or already adopted');
      }
      const target = registry.conversations[identity.sourceKey];
      if (!target || target.adopted_handover_id !== handoverId) {
        throw new Error('invalid Agent Conversation adoption transaction');
      }
      return {
        alreadyAdopted: true,
        sourceKey: handover.source_key,
        checkpoint: target.checkpoint,
      };
    }
    const retry = handover.status === 'adopting';
    if (retry && handover.adopting_by !== identity.sourceKey) {
      throw new Error('invalid handover or adoption already claimed');
    }
    if (!retry && handover.status !== 'sealed') throw new Error('invalid handover');
    const { manifest, checkpoint } = bundle;
    assertPairWorkIdleForAdoption(root, manifest.pair_work);
    const transferComplete = Boolean(
      retry && manifest.pair_work && expectedPairOwnershipExists(
        root, identity, input.agentConversationId, manifest.pair_work.work_id,
      ),
    );
    if (!retry || !transferComplete) {
      validatePairWorkReference(root, manifest.pair_work, manifest.kind);
    }
    if (manifest.source_key !== handover.source_key || manifest.source_key === identity.sourceKey) throw new Error('invalid handover');
    const source = registry.conversations[handover.source_key];
    if (!source || !['sealed', 'retired'].includes(source.status) || source.sealed_handover_id !== handoverId) throw new Error('invalid handover');
    if (registry.conversations[identity.sourceKey]) throw new Error('fresh Agent Conversation is already registered');
    if (!retry) {
      handover.status = 'adopting';
      handover.adopting_by = identity.sourceKey;
      handover.adopting_at = at;
      handover.adoption_transfer_status = manifest.pair_work ? 'pending' : 'not-applicable';
    } else if (transferComplete) {
      handover.adoption_transfer_status = 'completed';
    }
    return {
      alreadyAdopted: false,
      sourceKey: handover.source_key,
      checkpoint,
      kind: source.kind,
      pairWork: manifest.pair_work,
      transferComplete,
    };
  });

  if (prepared.alreadyAdopted) {
    return {
      status: 'adopted',
      handoverId,
      sourceKey: prepared.sourceKey,
      adopterKey: identity.sourceKey,
      checkpoint: prepared.checkpoint,
      recovered: true,
    };
  }

  if (prepared.pairWork && !prepared.transferComplete) {
    assertPairWorkIdleForAdoption(root, prepared.pairWork);
    const transfer = input.transferContinuation || takeoverWork;
    transfer(root, input.agentConversationId, identity.runtime, {
      expectedWorkId: prepared.pairWork.work_id,
    });
  }

  const adopted = withRegistry(root, registry => {
    const handover = registry.handovers[handoverId];
    if (!handover || handover.status !== 'adopting' || handover.adopting_by !== identity.sourceKey) {
      throw new Error('invalid Agent Conversation adoption transaction');
    }
    const { manifest, checkpoint, directory } = readAgentConversationHandoverUnchecked(root, handoverId, {
      registry,
      skipPairWorkValidation: true,
    });
    assertPairWorkIdleForAdoption(root, manifest.pair_work);
    if (manifest.pair_work && !expectedPairOwnershipExists(
      root, identity, input.agentConversationId, manifest.pair_work.work_id,
    )) {
      throw new Error('invalid Agent Conversation adoption transaction');
    }
    const source = registry.conversations[handover.source_key];
    if (!source || !['sealed', 'retired'].includes(source.status) || source.sealed_handover_id !== handoverId) {
      throw new Error('invalid Agent Conversation adoption transaction');
    }
    // The sealed handover files stay immutable; only the adopting conversation's live checkpoint
    // settles post-seal artifact drift, so the adopter continues from truthful pointers.
    const settled = source.kind === 'pair'
      ? { checkpoint, dropped: [] }
      : settleNonPairArtifactDrift(root, checkpoint);
    registry.conversations[identity.sourceKey] = {
      source_key: identity.sourceKey,
      runtime: identity.runtime,
      kind: source.kind,
      status: 'warm',
      registered_at: at,
      last_active_at: at,
      checkpoint: settled.checkpoint,
      checkpoint_revision: manifest.checkpoint_revision,
      sealed_handover_id: null,
      adopted_handover_id: handoverId,
      override: null,
      checkpoint_origin: source.checkpoint_origin || null,
      checkpoint_source_digest: source.checkpoint_source_digest || null,
      checkpoint_updated_at: source.checkpoint_updated_at || null,
    };
    source.status = 'retired';
    handover.status = 'adopted';
    handover.adopted_by = identity.sourceKey;
    handover.adopted_at = at;
    handover.adoption_transfer_status = manifest.pair_work ? 'completed' : 'not-applicable';
    delete handover.adopting_by;
    delete handover.adopting_at;
    return {
      status: 'adopted', handoverId, sourceKey: handover.source_key,
      adopterKey: identity.sourceKey, checkpoint: settled.checkpoint, directory,
      ...(settled.dropped.length ? { driftedArtifacts: settled.dropped } : {}),
    };
  });
  withRegistry(root, registry => readAgentConversationHandoverUnchecked(root, handoverId, {
    registry,
    skipPairWorkValidation: true,
  }));
  delete adopted.directory;
  return adopted;
}

function authorizeColdResume(root, input) {
  const handoverId = assertHandoverId(input.handoverId);
  const identity = conversationIdentity(input);
  const at = timestamp(input.now);
  if (input.confirmCostRisk !== true) throw new Error('cold resume requires explicit confirmCostRisk');
  const authorized = withRegistry(root, registry => {
    const handover = registry.handovers[handoverId];
    const source = handover && registry.conversations[handover.source_key];
    if (!handover || !source || handover.source_key !== identity.sourceKey) throw new Error('invalid handover');
    readAgentConversationHandoverUnchecked(root, handoverId, { registry });
    if (handover.override_used) throw new Error('cold resume override already used');
    if (handover.status !== 'sealed' || source.status !== 'sealed' || source.sealed_handover_id !== handoverId) throw new Error('invalid handover');
    handover.override_used = true;
    handover.override_authorized_at = at;
    source.status = 'override-active';
    source.override = {
      handover_id: handoverId,
      status: 'allowed-once',
      authorized_at: at,
      authorized_checkpoint_revision: source.checkpoint_revision,
    };
    return { status: 'allowed-once', handoverId };
  });
  withRegistry(root, registry => readAgentConversationHandoverUnchecked(root, handoverId, { registry }));
  return authorized;
}

function completeColdResume(root, input) {
  const handoverId = assertHandoverId(input.handoverId);
  const identity = conversationIdentity(input);
  const at = timestamp(input.now);
  const completed = withRegistry(root, registry => {
    const handover = registry.handovers[handoverId];
    const source = handover && registry.conversations[handover.source_key];
    if (!handover || handover.status !== 'sealed' || !source || source.status !== 'override-active' || source.sealed_handover_id !== handoverId || handover.source_key !== identity.sourceKey || source.override?.status !== 'in-flight') throw new Error('cold resume is not authorized');
    readAgentConversationHandoverUnchecked(root, handoverId, {
      registry,
      skipPairWorkValidation: true,
    });
    if (source.checkpoint_revision <= source.override.authorized_checkpoint_revision) {
      throw new Error('cold resume completion requires a refreshed Agent Conversation Checkpoint');
    }
    source.status = 'warm';
    source.last_active_at = at;
    source.sealed_handover_id = null;
    const refreshed = sealConversation(root, registry, handoverPaths(root), identity, at);
    source.status = 'retired';
    handover.status = 'refreshed';
    handover.refreshed_handover_id = refreshed.handoverId;
    handover.override_completed_at = at;
    source.override = {
      handover_id: handoverId,
      status: 'completed',
      completed_at: at,
      refreshed_handover_id: refreshed.handoverId,
      authorized_checkpoint_revision: source.override.authorized_checkpoint_revision,
      refreshed_at: source.override.refreshed_at,
      refreshed_checkpoint_revision: source.override.refreshed_checkpoint_revision,
    };
    return { status: 'retired', handoverId, refreshedHandoverId: refreshed.handoverId };
  });
  withRegistry(root, registry => readAgentConversationHandoverUnchecked(root, handoverId, {
    registry,
    skipPairWorkValidation: true,
  }));
  return completed;
}

module.exports = {
  HANDOVER_SCHEMA,
  FRESHNESS_WINDOW_MS,
  MAX_UNSTOPPED_ACTIVITY_MS,
  MAX_CHECKPOINT_BYTES,
  assessAgentConversationFreshness,
  adoptAgentConversationHandover,
  authorizeColdResume,
  brainstormBootstrapCheckpoint,
  completeColdResume,
  conversationIdentity,
  derivePairCheckpoint,
  ensureBrainstormingRegistration,
  formatFreshnessProjection,
  freshnessProjection,
  generalHandoverEnabled,
  hasAgentConversationRegistration,
  handoverPaths,
  mergeBrainstormCheckpointDelta,
  normalizeCheckpoint,
  validateAgentConversationCheckpointInput,
  readAgentConversationHandover,
  readAgentConversationHandoverForAdoption,
  readAgentConversationRegistry,
  prepareAgentConversationStop,
  recordAgentConversationActivity,
  recordAgentConversationStop,
  registerAgentConversation,
  sealAgentConversationHandover,
  sealColdAgentConversations,
  setGeneralHandoverPolicy,
  updateAgentConversationCheckpoint,
};
