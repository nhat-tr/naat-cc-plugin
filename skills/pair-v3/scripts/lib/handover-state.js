const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { loadPairState, pairStatePaths, redactString } = require('./pair-state');
const { takeoverWork } = require('./pair-control');

const HANDOVER_SCHEMA = 1;
const MAX_CHECKPOINT_BYTES = 32 * 1024;
const FRESHNESS_WINDOW_MS = 60 * 60 * 1000;
const LOCK_WAIT_MS = 5;
const LOCK_TIMEOUT_MS = 10_000;
const HANDOVER_ID = /^handover-[a-f0-9-]{36}$/u;
const RUNTIMES = new Set(['codex', 'claude']);
const KINDS = new Set(['pair', 'brainstorming']);
const CONVERSATION_KEYS = new Set([
  'source_key', 'runtime', 'kind', 'status', 'registered_at', 'last_active_at',
  'checkpoint', 'checkpoint_revision', 'sealed_handover_id', 'adopted_handover_id',
  'override',
]);
const HANDOVER_CLAIM_KEYS = new Set([
  'handover_id', 'source_key', 'status', 'created_at', 'override_used',
  'runtime', 'kind', 'checkpoint_revision', 'checkpoint_sha256',
  'manifest_sha256', 'stage_directory', 'override_authorized_at',
  'override_completed_at', 'refreshed_handover_id', 'adopting_by',
  'adopting_at', 'adopted_by', 'adopted_at', 'adoption_transfer_status',
]);

function handoverPaths(root) {
  const pairDirectory = path.join(root, '.pair');
  const directory = path.join(pairDirectory, 'handovers');
  return {
    pairDirectory,
    directory,
    registrations: path.join(directory, 'registrations'),
    registrationIndex: path.join(directory, 'registrations', '.index-v1-complete.json'),
    registry: path.join(directory, 'registry.json'),
    lock: path.join(directory, '.handover.lock'),
  };
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
    if (conversation.checkpoint === null) {
      if (conversation.checkpoint_revision !== 0 || conversation.status !== 'warm') return false;
    } else {
      if (
        conversation.checkpoint_revision < 1 ||
        !isPlainObject(conversation.checkpoint) ||
        Buffer.byteLength(JSON.stringify(conversation.checkpoint), 'utf8') > MAX_CHECKPOINT_BYTES ||
        JSON.stringify(conversation.checkpoint) !== JSON.stringify(normalizeCheckpoint(conversation.checkpoint))
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
  if (kind && !KINDS.has(kind)) throw new Error('Agent Conversation kind must be pair or brainstorming');
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
      checkpoint: existing?.checkpoint || null,
      checkpoint_revision: existing?.checkpoint_revision || 0,
      sealed_handover_id: existing?.sealed_handover_id || null,
      override: existing?.override || null,
    };
    return { sourceKey: identity.sourceKey, ...registry.conversations[identity.sourceKey] };
  });
}

function updateAgentConversationCheckpoint(root, input) {
  const identity = conversationIdentity(input);
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
    const unchanged = JSON.stringify(conversation.checkpoint) === JSON.stringify(checkpoint);
    if (unchanged && !overrideRefresh) {
      return { sourceKey: identity.sourceKey, revision: conversation.checkpoint_revision, checkpoint, unchanged: true };
    }
    if (!unchanged) conversation.checkpoint = checkpoint;
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

function recordAgentConversationStop(root, input) {
  const identity = conversationIdentity(input);
  if (!hasAgentConversationRegistration(root, input)) {
    return { status: 'unregistered', sourceKey: identity.sourceKey };
  }
  const at = timestamp(input.now);
  const recorded = withRegistry(root, registry => {
    const conversation = registry.conversations[identity.sourceKey];
    if (!conversation) throw new Error('invalid Agent Conversation Handover registry');
    if (conversation.status === 'override-active') {
      if (conversation.override?.status !== 'in-flight') {
        return { status: 'override-not-consumed', sourceKey: identity.sourceKey };
      }
      if (conversation.kind === 'pair') {
        const checkpoint = derivePairCheckpoint(root);
        if (JSON.stringify(conversation.checkpoint) !== JSON.stringify(checkpoint)) {
          conversation.checkpoint = checkpoint;
          conversation.checkpoint_revision += 1;
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
      const checkpoint = derivePairCheckpoint(root);
      if (JSON.stringify(conversation.checkpoint) !== JSON.stringify(checkpoint)) {
        conversation.checkpoint = checkpoint;
        conversation.checkpoint_revision += 1;
      }
    }
    conversation.last_active_at = at;
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
    const freshStart = handoverId
      ? `From a plain terminal outside any agent conversation, run pair-loop --fresh-from ${handoverId} --runtime ${conversation.runtime}; or open a fresh ${conversation.runtime} agent conversation manually, then inside it run pair-loop --adopt-handover ${handoverId} --runtime ${conversation.runtime}.`
      : null;
    const nextSafeAction = ['cold', 'sealed'].includes(projectedStatus)
      ? freshStart || 'Submit no further prompt; repair the Agent Conversation Handover state.'
      : projectedStatus === 'retired'
        ? handoverId && registry.handovers[handoverId]?.status === 'sealed'
          ? freshStart
          : 'Use the adopted fresh Agent Conversation.'
        : projectedStatus === 'warm'
          ? `Continue in this ${conversation.runtime} Agent Conversation before the freshness deadline.`
          : projectedStatus === 'override-active'
            ? 'Finish the one authorized turn, refresh its Agent Conversation Checkpoint, and stop.'
            : 'Submit no further prompt; repair the Agent Conversation Handover state.';
    return {
      runtime: conversation.runtime,
      kind: conversation.kind,
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
  const requiringHandover = conversations.find(conversation => ['cold', 'sealed', 'invalid-activity', 'retired'].includes(conversation.status));
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

function formatFreshnessProjection(projection, options = {}) {
  const conversations = projection?.conversations || [];
  if (conversations.length === 0) {
    return projection?.warning || 'Freshness Gate: no registered Agent Conversations.';
  }
  const lines = conversations.map(conversation => [
    `Freshness Gate ${conversation.runtime}/${conversation.kind}: ${conversation.status}`,
    `age ${formatDuration(conversation.age_ms)}`,
    `remaining ${formatDuration(conversation.remaining_ms)}`,
    `deadline ${conversation.deadline_at || 'invalid'}`,
    `checkpoint r${conversation.checkpoint_revision} sha256:${conversation.checkpoint_sha256 || 'none'}`,
    `handover ${conversation.handover_id || 'none'}`,
    `next safe action: ${conversation.next_safe_action || 'none'}`,
  ].join(options.compact ? ' | ' : '\n  '));
  if (projection.warning) lines.push(projection.warning);
  return lines.join(options.compact ? ' || ' : '\n');
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
  const state = loadPairState(root);
  const workId = state.work_id || null;
  const paths = pairStatePaths(root, workId);
  const projection = fs.readFileSync(paths.state);
  return {
    work_id: workId,
    projection_path: path.relative(root, paths.state).split(path.sep).join('/'),
    projection_sha256: sha256(projection),
  };
}

function derivePairCheckpoint(root) {
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
  if (reference === null && kind === 'brainstorming') return;
  if (!reference || typeof reference !== 'object') throw new Error('invalid handover');
  if (reference.work_id !== null && !String(reference.work_id || '').trim()) throw new Error('invalid handover');
  if (loadPairState(root).work_id !== reference.work_id) throw new Error('invalid handover');
  if (!/^[a-f0-9]{64}$/u.test(reference.projection_sha256 || '')) throw new Error('invalid handover');
  const paths = pairStatePaths(root, reference.work_id);
  const expectedPath = path.relative(root, paths.state).split(path.sep).join('/');
  if (reference.projection_path !== expectedPath) throw new Error('invalid handover');
  const projection = fs.lstatSync(paths.state, { throwIfNoEntry: false });
  if (!projection || !projection.isFile() || projection.isSymbolicLink()) throw new Error('invalid handover');
  if (sha256(fs.readFileSync(paths.state)) !== reference.projection_sha256) throw new Error('invalid handover');
}

function validatePairWorkManifestBinding(root, reference, kind, checkpoint) {
  if (kind === 'brainstorming') {
    if (reference !== null) throw new Error('invalid handover');
    return;
  }
  if (!isPlainObject(reference)) throw new Error('invalid handover');
  if (reference.work_id !== null && !String(reference.work_id || '').trim()) throw new Error('invalid handover');
  if (Object.keys(reference).sort().join(',') !== 'projection_path,projection_sha256,work_id') throw new Error('invalid handover');
  if (!/^[a-f0-9]{64}$/u.test(reference.projection_sha256 || '')) throw new Error('invalid handover');
  const expectedPath = path.relative(root, pairStatePaths(root, reference.work_id).state).split(path.sep).join('/');
  if (reference.projection_path !== expectedPath) throw new Error('invalid handover');
  const artifact = checkpoint.artifacts?.find(candidate => (
    candidate.path === reference.projection_path && candidate.sha256 === reference.projection_sha256
  ));
  if (!artifact) throw new Error('invalid handover');
}

function expectedPairOwnershipExists(root, identity, agentConversationId, expectedWorkId) {
  const current = loadPairState(root);
  if (current.work_id !== expectedWorkId) return false;
  const state = loadPairState(root, expectedWorkId);
  return state.continuation?.owner_session_id === String(agentConversationId)
    && state.continuation?.owner_runtime === identity.runtime;
}

function assertPairWorkIdleForAdoption(root, reference) {
  if (!reference) return null;
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

function sealConversation(root, registry, paths, identity, at) {
    const conversation = registry.conversations[identity.sourceKey];
    if (!conversation || conversation.status !== 'warm' || !conversation.checkpoint) throw new Error('Agent Conversation requires a warm checkpoint before sealing');
    if (conversation.sealed_handover_id) return { handoverId: conversation.sealed_handover_id, sourceKey: identity.sourceKey, alreadySealed: true };
    if (conversation.kind === 'pair') {
      const checkpoint = derivePairCheckpoint(root);
      if (JSON.stringify(conversation.checkpoint) !== JSON.stringify(checkpoint)) {
        conversation.checkpoint = checkpoint;
        conversation.checkpoint_revision += 1;
      }
    }
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
  const expectedManifestKeys = [
    'checkpoint_bytes', 'checkpoint_revision', 'checkpoint_sha256', 'created_at', 'handover_id',
    'kind', 'pair_work', 'runtime', 'schema', 'source_key',
  ];
  if (
    !isPlainObject(manifest) ||
    Object.keys(manifest).sort().join(',') !== expectedManifestKeys.sort().join(',') ||
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
  let checkpoint;
  try {
    checkpoint = JSON.parse(checkpointBytes);
  } catch {
    throw new Error('invalid handover');
  }
  if (!isPlainObject(checkpoint) || checkpointBytes !== JSON.stringify(checkpoint)) throw new Error('invalid handover');
  if (checkpointBytes !== JSON.stringify(normalizeCheckpoint(checkpoint))) throw new Error('invalid handover');
  validatePairWorkManifestBinding(root, manifest.pair_work, manifest.kind, checkpoint);
  const modernClaim = claim.runtime !== undefined || claim.kind !== undefined ||
    claim.checkpoint_revision !== undefined || claim.checkpoint_sha256 !== undefined;
  if (modernClaim) {
    if (
      claim.runtime !== manifest.runtime ||
      claim.kind !== manifest.kind ||
      claim.checkpoint_revision !== manifest.checkpoint_revision ||
      claim.checkpoint_sha256 !== manifest.checkpoint_sha256
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
      JSON.stringify(source.checkpoint) !== checkpointBytes
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
    registry.conversations[identity.sourceKey] = {
      source_key: identity.sourceKey,
      runtime: identity.runtime,
      kind: source.kind,
      status: 'warm',
      registered_at: at,
      last_active_at: at,
      checkpoint,
      checkpoint_revision: manifest.checkpoint_revision,
      sealed_handover_id: null,
      adopted_handover_id: handoverId,
      override: null,
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
      adopterKey: identity.sourceKey, checkpoint, directory,
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
  MAX_CHECKPOINT_BYTES,
  assessAgentConversationFreshness,
  adoptAgentConversationHandover,
  authorizeColdResume,
  completeColdResume,
  derivePairCheckpoint,
  formatFreshnessProjection,
  freshnessProjection,
  hasAgentConversationRegistration,
  handoverPaths,
  normalizeCheckpoint,
  readAgentConversationHandover,
  readAgentConversationHandoverForAdoption,
  readAgentConversationRegistry,
  recordAgentConversationStop,
  registerAgentConversation,
  sealAgentConversationHandover,
  updateAgentConversationCheckpoint,
};
