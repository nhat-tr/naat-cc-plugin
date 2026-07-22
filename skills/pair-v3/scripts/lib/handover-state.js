const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { loadPairState, pairStatePaths, redactString } = require('./pair-state');

const HANDOVER_SCHEMA = 1;
const MAX_CHECKPOINT_BYTES = 32 * 1024;
const FRESHNESS_WINDOW_MS = 60 * 60 * 1000;
const LOCK_WAIT_MS = 5;
const LOCK_TIMEOUT_MS = 10_000;
const HANDOVER_ID = /^handover-[a-f0-9-]{36}$/u;
const RUNTIMES = new Set(['codex', 'claude']);
const KINDS = new Set(['pair', 'brainstorming']);

function handoverPaths(root) {
  const pairDirectory = path.join(root, '.pair');
  const directory = path.join(pairDirectory, 'handovers');
  return {
    pairDirectory,
    directory,
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
    return paths;
  }
  for (const directory of [paths.pairDirectory, paths.directory]) {
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

function readRegistryFile(file) {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) return null;
  return readJson(file);
}

function validRegistry(registry) {
  if (!isPlainObject(registry) || registry.schema !== HANDOVER_SCHEMA || !isPlainObject(registry.conversations) || !isPlainObject(registry.handovers)) return false;
  for (const [sourceKey, conversation] of Object.entries(registry.conversations)) {
    if (!/^[a-f0-9]{64}$/u.test(sourceKey) || !isPlainObject(conversation)) return false;
    if (conversation.source_key !== sourceKey || !RUNTIMES.has(conversation.runtime) || !KINDS.has(conversation.kind)) return false;
    if (!['warm', 'sealed', 'override-active', 'retired'].includes(conversation.status)) return false;
    if (!Number.isInteger(conversation.checkpoint_revision) || conversation.checkpoint_revision < 0) return false;
    const handoverId = conversation.sealed_handover_id;
    if (handoverId === null || handoverId === undefined) {
      if (conversation.status === 'sealed' || conversation.status === 'override-active') return false;
      continue;
    }
    const handover = registry.handovers[handoverId];
    if (!HANDOVER_ID.test(handoverId) || !isPlainObject(handover) || handover.handover_id !== handoverId || handover.source_key !== sourceKey) return false;
    if (!['sealed', 'adopted'].includes(handover.status)) return false;
    if (conversation.status === 'warm') return false;
    if (conversation.status === 'sealed' || conversation.status === 'override-active') {
      if (handover.status !== 'sealed') return false;
    }
  }
  for (const [handoverId, handover] of Object.entries(registry.handovers)) {
    if (!HANDOVER_ID.test(handoverId) || !isPlainObject(handover) || handover.handover_id !== handoverId || !isPlainObject(registry.conversations[handover.source_key])) return false;
    if (!['sealed', 'adopted'].includes(handover.status)) return false;
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
    const registry = fs.existsSync(paths.registry) ? readRegistryFile(paths.registry) : { schema: HANDOVER_SCHEMA, conversations: {}, handovers: {} };
    if (!validRegistry(registry)) {
      throw new Error('invalid Agent Conversation Handover registry');
    }
    recoverSealedHandoverTransactions(paths, registry);
    const result = callback(registry, paths);
    atomicWrite(paths.registry, `${JSON.stringify(registry, null, 2)}\n`);
    return result;
  } finally {
    releaseLock(paths, lock);
  }
}

function readAgentConversationRegistry(root) {
  const paths = handoverPaths(root);
  if (!fs.existsSync(paths.registry)) return { schema: HANDOVER_SCHEMA, conversations: {}, handovers: {} };
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
    core_anchor: safeText(input?.coreAnchor, 4096),
    findings: (Array.isArray(input?.findings) ? input.findings : []).map(finding => {
      const reference = safeText(finding?.reference, 1024);
      const digest = /^[a-f0-9]{64}$/u.test(finding?.digest || '') ? finding.digest : null;
      return reference ? { reference, digest } : null;
    }).filter(Boolean).slice(0, 64),
    confirmed_choices: safeList(input?.confirmedChoices),
    rejected_alternatives: safeList(input?.rejectedAlternatives),
    current_direction: safeText(input?.currentDirection, 4096),
    unresolved_decisions: safeList(input?.unresolvedDecisions),
    next_action: safeText(input?.nextAction, 1024),
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
  return withRegistry(root, registry => {
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
  return withRegistry(root, registry => {
    const conversation = registry.conversations[identity.sourceKey];
    if (!conversation || conversation.status !== 'warm') throw new Error('Agent Conversation is not warm and registered');
    conversation.checkpoint = checkpoint;
    conversation.checkpoint_revision += 1;
    conversation.last_active_at = at;
    return { sourceKey: identity.sourceKey, revision: conversation.checkpoint_revision, checkpoint };
  });
}

function recordAgentConversationStop(root, input) {
  const identity = conversationIdentity(input);
  const at = timestamp(input.now);
  const recorded = withRegistry(root, registry => {
    const conversation = registry.conversations[identity.sourceKey];
    if (!conversation) return { status: 'unregistered', sourceKey: identity.sourceKey };
    if (conversation.status === 'override-active') return {
      status: 'override-active',
      sourceKey: identity.sourceKey,
      handoverId: conversation.sealed_handover_id,
      checkpoint: conversation.checkpoint,
    };
    if (conversation.status !== 'warm') return {
      status: conversation.status,
      sourceKey: identity.sourceKey,
      handoverId: conversation.sealed_handover_id || null,
    };
    conversation.last_active_at = at;
    return { status: 'warm', sourceKey: identity.sourceKey, lastActiveAt: at };
  });
  if (recorded.status !== 'override-active') return recorded;
  return completeColdResume(root, {
    ...input,
    runtime: identity.runtime,
    kind: identity.kind || input.kind,
    handoverId: recorded.handoverId,
    checkpoint: recorded.checkpoint,
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
  const now = Number(input.now === undefined ? Date.now() : input.now);
  if (!Number.isFinite(now) || now < 0) throw new Error('Agent Conversation timestamp must be a non-negative finite millisecond value');
  const at = timestamp(now);
  const assessment = withRegistry(root, (registry, paths) => {
    const conversation = registry.conversations[identity.sourceKey];
    if (!conversation) return { status: 'unregistered', sourceKey: identity.sourceKey };
    if (conversation.status === 'override-active') return {
      status: 'warm',
      sourceKey: identity.sourceKey,
      overrideAllowed: true,
    };
    if (conversation.status !== 'warm') return {
      status: conversation.status,
      sourceKey: identity.sourceKey,
      handoverId: conversation.sealed_handover_id || null,
    };
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
    const nextSafeAction = ['cold', 'sealed'].includes(projectedStatus)
      ? handoverId
        ? `pair-loop --fresh-from ${handoverId} --runtime ${conversation.runtime}`
        : 'Submit no further prompt; repair the Agent Conversation Handover state.'
      : projectedStatus === 'retired'
        ? 'Use the adopted fresh Agent Conversation.'
        : null;
    return {
      runtime: conversation.runtime,
      kind: conversation.kind,
      status: projectedStatus,
      age_ms: ageMs,
      deadline_at: invalidActivity ? null : new Date(activeAt + FRESHNESS_WINDOW_MS).toISOString(),
      checkpoint_revision: conversation.checkpoint_revision,
      checkpoint_sha256: conversation.checkpoint ? sha256(JSON.stringify(conversation.checkpoint)) : null,
      handover_id: handoverId,
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

function appendHandoverEvent(directory, event) {
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
  if (!state.work_id) return null;
  const paths = pairStatePaths(root, state.work_id);
  const projection = fs.readFileSync(paths.state);
  return {
    work_id: state.work_id,
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
  if (!reference || typeof reference !== 'object' || !String(reference.work_id || '').trim()) throw new Error('invalid handover');
  if (!/^[a-f0-9]{64}$/u.test(reference.projection_sha256 || '')) throw new Error('invalid handover');
  const paths = pairStatePaths(root, reference.work_id);
  const expectedPath = path.relative(root, paths.state).split(path.sep).join('/');
  if (reference.projection_path !== expectedPath) throw new Error('invalid handover');
  const projection = fs.lstatSync(paths.state, { throwIfNoEntry: false });
  if (!projection || !projection.isFile() || projection.isSymbolicLink()) throw new Error('invalid handover');
  if (sha256(fs.readFileSync(paths.state)) !== reference.projection_sha256) throw new Error('invalid handover');
}

function sealConversation(root, registry, paths, identity, at) {
    const conversation = registry.conversations[identity.sourceKey];
    if (!conversation || conversation.status !== 'warm' || !conversation.checkpoint) throw new Error('Agent Conversation requires a warm checkpoint before sealing');
    if (conversation.sealed_handover_id) return { handoverId: conversation.sealed_handover_id, sourceKey: identity.sourceKey, alreadySealed: true };
    const handoverId = `handover-${crypto.randomUUID()}`;
    const directory = stagingDirectory(paths, handoverId);
    ensurePrivateDirectory(directory);
    const checkpointBytes = JSON.stringify(conversation.checkpoint);
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
      pair_work: pairWorkReference(root),
    };
    atomicWrite(path.join(directory, 'checkpoint.md'), checkpointBytes);
    atomicWrite(path.join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    appendHandoverEvent(directory, { event: 'handover.sealed', at, source_key: identity.sourceKey, checkpoint_sha256: manifest.checkpoint_sha256 });
    conversation.status = 'sealed';
    conversation.sealed_handover_id = handoverId;
    registry.handovers[handoverId] = {
      handover_id: handoverId,
      source_key: identity.sourceKey,
      status: 'sealed',
      created_at: at,
      override_used: false,
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

function readAgentConversationHandoverUnchecked(root, handoverId) {
  const directory = safeHandoverDirectory(root, handoverId);
  let manifest;
  try {
    manifest = JSON.parse(readSafeFile(directory, 'manifest.json'));
  } catch {
    throw new Error('invalid handover');
  }
  const checkpointBytes = readSafeFile(directory, 'checkpoint.md');
  if (
    manifest?.schema !== HANDOVER_SCHEMA ||
    manifest.handover_id !== handoverId ||
    !KINDS.has(manifest.kind) ||
    !/^[a-f0-9]{64}$/u.test(manifest.checkpoint_sha256 || '') ||
    manifest.checkpoint_sha256 !== sha256(checkpointBytes) ||
    Buffer.byteLength(checkpointBytes, 'utf8') > MAX_CHECKPOINT_BYTES
  ) throw new Error('invalid handover');
  let checkpoint;
  try {
    checkpoint = JSON.parse(checkpointBytes);
  } catch {
    throw new Error('invalid handover');
  }
  validatePairWorkReference(root, manifest.pair_work, manifest.kind);
  return { manifest, checkpoint, directory };
}

function readAgentConversationHandover(root, handoverId) {
  withRegistry(root, () => null);
  return readAgentConversationHandoverUnchecked(root, handoverId);
}

function adoptAgentConversationHandover(root, input) {
  const handoverId = assertHandoverId(input.handoverId);
  const identity = conversationIdentity({ ...input, kind: input.kind || 'pair' });
  const at = timestamp(input.now);
  return withRegistry(root, registry => {
    const handover = registry.handovers[handoverId];
    if (!handover || handover.status !== 'sealed') throw new Error('invalid handover or already adopted');
    const { manifest, checkpoint, directory } = readAgentConversationHandoverUnchecked(root, handoverId);
    if (manifest.source_key !== handover.source_key || manifest.source_key === identity.sourceKey) throw new Error('invalid handover');
    const source = registry.conversations[handover.source_key];
    if (!source || source.status !== 'sealed' || source.sealed_handover_id !== handoverId) throw new Error('invalid handover');
    if (registry.conversations[identity.sourceKey]) throw new Error('fresh Agent Conversation is already registered');
    registry.conversations[identity.sourceKey] = {
      source_key: identity.sourceKey,
      runtime: identity.runtime,
      kind: source.kind,
      status: 'warm',
      registered_at: at,
      last_active_at: at,
      checkpoint,
      checkpoint_revision: source.checkpoint_revision,
      sealed_handover_id: null,
      adopted_handover_id: handoverId,
      override: null,
    };
    source.status = 'retired';
    handover.status = 'adopted';
    handover.adopted_by = identity.sourceKey;
    handover.adopted_at = at;
    appendHandoverEvent(directory, { event: 'handover.adopted', at, adopter_key: identity.sourceKey });
    return { status: 'adopted', handoverId, sourceKey: handover.source_key, adopterKey: identity.sourceKey, checkpoint };
  });
}

function authorizeColdResume(root, input) {
  const handoverId = assertHandoverId(input.handoverId);
  const identity = conversationIdentity(input);
  const at = timestamp(input.now);
  if (input.confirmCostRisk !== true) throw new Error('cold resume requires explicit confirmCostRisk');
  return withRegistry(root, registry => {
    const handover = registry.handovers[handoverId];
    const source = handover && registry.conversations[handover.source_key];
    if (!handover || !source || handover.source_key !== identity.sourceKey) throw new Error('invalid handover');
    if (handover.override_used) throw new Error('cold resume override already used');
    if (handover.status !== 'sealed' || source.status !== 'sealed' || source.sealed_handover_id !== handoverId) throw new Error('invalid handover');
    handover.override_used = true;
    handover.override_authorized_at = at;
    source.status = 'override-active';
    source.override = { handover_id: handoverId, status: 'allowed-once', authorized_at: at };
    appendHandoverEvent(safeHandoverDirectory(root, handoverId), { event: 'cold-resume.authorized', at, source_key: identity.sourceKey });
    return { status: 'allowed-once', handoverId };
  });
}

function completeColdResume(root, input) {
  const handoverId = assertHandoverId(input.handoverId);
  const identity = conversationIdentity(input);
  const at = timestamp(input.now);
  const completed = withRegistry(root, registry => {
    const handover = registry.handovers[handoverId];
    const source = handover && registry.conversations[handover.source_key];
    if (!handover || handover.status !== 'sealed' || !source || source.status !== 'override-active' || source.sealed_handover_id !== handoverId || handover.source_key !== identity.sourceKey || source.override?.status !== 'allowed-once') throw new Error('cold resume is not authorized');
    if (!input.checkpoint) throw new Error('cold resume completion requires a refreshed Agent Conversation Checkpoint');
    source.status = 'warm';
    source.checkpoint = normalizeCheckpoint(input.checkpoint);
    source.checkpoint_revision += 1;
    source.last_active_at = at;
    source.sealed_handover_id = null;
    const refreshed = sealConversation(root, registry, handoverPaths(root), identity, at);
    source.status = 'retired';
    source.override = { handover_id: handoverId, status: 'completed', completed_at: at, refreshed_handover_id: refreshed.handoverId };
    appendHandoverEvent(safeHandoverDirectory(root, handoverId), { event: 'cold-resume.completed', at, source_key: identity.sourceKey });
    return { status: 'retired', handoverId, refreshedHandoverId: refreshed.handoverId };
  });
  withRegistry(root, () => null);
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
  freshnessProjection,
  handoverPaths,
  normalizeCheckpoint,
  readAgentConversationHandover,
  readAgentConversationRegistry,
  recordAgentConversationStop,
  registerAgentConversation,
  sealAgentConversationHandover,
  updateAgentConversationCheckpoint,
};
