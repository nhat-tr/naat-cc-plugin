const MAX_WORKSPACE_DOCUMENT_BYTES = 512 * 1024;
const WORKSPACE_KINDS = Object.freeze([
  'product',
  'architecture',
  'research',
  'business',
  'review',
]);

const WORKSPACE_KIND_SET = new Set(WORKSPACE_KINDS);
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,119}$/;
const WORK_ID_PATTERN = /^work-[0-9]{8}-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REFERENCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const REVISION_PATTERN = /^[a-f0-9]{8}$/;
const RFC3339_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/;
const BLOCKED_COMPATIBILITY_FIELDS = new Set([
  'capabilitytoken',
  'connectionurl',
  'constructor',
  'html',
  'prompt',
  'proto',
  'prototype',
  'script',
  'secret',
  'token',
  'transcript',
  '__proto__',
]);
const ENVELOPE_FIELDS = [
  'version',
  'work_id',
  'workspace_kind',
  'title',
  'evidence_refs',
  'revision',
  'frames',
  'components',
  'decisions',
  'feedback_threads',
  'content',
  'read_only',
];

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function rejectUnknown(value, allowed, label) {
  const unknown = Object.keys(value).find(key => !allowed.includes(key));
  if (unknown !== undefined) throw new TypeError(`unsupported field ${label}.${unknown}`);
}

function text(value, maximum, label, required = true) {
  if (typeof value !== 'string') throw new TypeError(`${label} must be text`);
  const normalized = value.trim();
  if (required && !normalized) throw new TypeError(`${label} is required`);
  if (normalized.length > maximum) throw new RangeError(`${label} must be at most ${maximum} characters`);
  return normalized;
}

function identifier(value, label) {
  const normalized = text(value, 120, label);
  if (!ID_PATTERN.test(normalized)) throw new TypeError(`${label} must be a lowercase identifier`);
  return normalized;
}

function boundedArray(value, maximum, label) {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new RangeError(`${label} must be an array with at most ${maximum} items`);
  }
  return value;
}

function uniqueId(id, seen, label) {
  if (seen.has(id)) throw new TypeError(`duplicate ${label} identity ${id}`);
  seen.add(id);
  return id;
}

function byteLength(value) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new TypeError('workspace document must be JSON-serializable');
  }
  if (serialized === undefined) throw new TypeError('workspace document must be JSON-serializable');
  return Buffer.byteLength(serialized, 'utf8');
}

function documentRevision(value) {
  assertObject(value, 'workspace document');
  const semantic = structuredClone(value);
  delete semantic.revision;
  const json = JSON.stringify(semantic);
  let hash = 0x811c9dc5;
  for (let index = 0; index < json.length; index += 1) {
    hash ^= json.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function normalizeOpaqueWorkspaceContent(value) {
  let itemCount = 0;
  const visit = (current, depth, label) => {
    itemCount += 1;
    if (itemCount > 20_000) throw new RangeError('workspace content contains too many values');
    if (depth > 20) throw new RangeError('workspace content is nested too deeply');
    if (current === null || typeof current === 'boolean') return current;
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new TypeError(`${label} must contain finite numbers`);
      return current;
    }
    if (typeof current === 'string') {
      if (current.length > 50_000) throw new RangeError(`${label} contains oversized text`);
      return current;
    }
    if (Array.isArray(current)) {
      if (current.length > 5_000) throw new RangeError(`${label} contains too many items`);
      return current.map((item, index) => visit(item, depth + 1, `${label}[${index}]`));
    }
    assertObject(current, label);
    const keys = Object.keys(current);
    if (keys.length > 1_000) throw new RangeError(`${label} contains too many fields`);
    const normalized = {};
    for (const key of keys) {
      const securityKey = key.replace(/[^a-z0-9]/giu, '').toLowerCase();
      if (BLOCKED_COMPATIBILITY_FIELDS.has(securityKey)) {
        throw new TypeError('unsupported security-sensitive workspace content field');
      }
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,119}$/u.test(key)) {
        throw new TypeError(`${label} contains an invalid field name`);
      }
      normalized[key] = visit(current[key], depth + 1, `${label}.${key}`);
    }
    return normalized;
  };
  assertObject(value, 'workspace content');
  return visit(value, 0, 'workspace content');
}

function normalizeEvidenceReferences(value) {
  const seen = new Set();
  return boundedArray(value, 100, 'workspace document.evidence_refs').map((entry, index) => {
    const label = `workspace document.evidence_refs[${index}]`;
    assertObject(entry, label);
    rejectUnknown(entry, ['id', 'label'], label);
    const id = text(entry.id, 200, `${label}.id`);
    if (!REFERENCE_ID_PATTERN.test(id)) throw new TypeError(`${label}.id must be a stable evidence identifier`);
    uniqueId(id, seen, 'evidence reference');
    return { id, label: text(entry.label, 300, `${label}.label`) };
  });
}

function normalizeFrames(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    throw new RangeError('workspace document.frames must contain 1-100 frames');
  }
  const seen = new Set();
  return value.map((frame, index) => {
    const label = `workspace document.frames[${index}]`;
    assertObject(frame, label);
    rejectUnknown(frame, ['id', 'title', 'component_ids'], label);
    const id = uniqueId(identifier(frame.id, `${label}.id`), seen, 'frame');
    const componentIds = boundedArray(frame.component_ids, 5000, `${label}.component_ids`)
      .map((componentId, componentIndex) => identifier(componentId, `${label}.component_ids[${componentIndex}]`));
    const componentSeen = new Set();
    for (const componentId of componentIds) uniqueId(componentId, componentSeen, 'component in frame');
    return { id, title: text(frame.title, 200, `${label}.title`), component_ids: componentIds };
  });
}

function normalizeComponents(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 5000) {
    throw new RangeError('workspace document.components must contain 1-5000 components');
  }
  const seen = new Set();
  return value.map((component, index) => {
    const label = `workspace document.components[${index}]`;
    assertObject(component, label);
    rejectUnknown(component, ['id', 'frame_id', 'label'], label);
    return {
      id: uniqueId(identifier(component.id, `${label}.id`), seen, 'component'),
      frame_id: identifier(component.frame_id, `${label}.frame_id`),
      label: text(component.label, 300, `${label}.label`),
    };
  });
}

function validateFrameMembership(frames, components) {
  const frameById = new Map(frames.map(frame => [frame.id, frame]));
  const componentById = new Map(components.map(component => [component.id, component]));
  const listed = new Map();
  for (const frame of frames) {
    for (const componentId of frame.component_ids) {
      const component = componentById.get(componentId);
      if (!component) throw new TypeError(`unknown component ${componentId} listed by frame ${frame.id}`);
      if (component.frame_id !== frame.id) {
        throw new TypeError(`component ${componentId} belongs to frame ${component.frame_id}, not ${frame.id}`);
      }
      listed.set(componentId, (listed.get(componentId) || 0) + 1);
    }
  }
  for (const component of components) {
    if (!frameById.has(component.frame_id)) throw new TypeError(`component ${component.id} references unknown frame ${component.frame_id}`);
    if (listed.get(component.id) !== 1) throw new TypeError(`component ${component.id} must be listed by its frame exactly once`);
  }
}

function normalizeDecisions(value, componentIds) {
  const seen = new Set();
  return boundedArray(value, 100, 'workspace document.decisions').map((decision, index) => {
    const label = `workspace document.decisions[${index}]`;
    assertObject(decision, label);
    rejectUnknown(decision, ['id', 'title', 'multiselect', 'option_component_ids'], label);
    const id = uniqueId(identifier(decision.id, `${label}.id`), seen, 'decision');
    if (typeof decision.multiselect !== 'boolean') throw new TypeError(`${label}.multiselect must be a boolean`);
    if (!Array.isArray(decision.option_component_ids) || decision.option_component_ids.length < 1 || decision.option_component_ids.length > 100) {
      throw new RangeError(`${label}.option_component_ids must contain 1-100 component identities`);
    }
    const options = decision.option_component_ids.map((option, optionIndex) => identifier(option, `${label}.option_component_ids[${optionIndex}]`));
    const optionSeen = new Set();
    for (const option of options) {
      uniqueId(option, optionSeen, 'Decision Option Component');
      if (!componentIds.has(option)) throw new TypeError(`Decision ${id} references unknown Option Component ${option}`);
    }
    return { id, title: text(decision.title, 200, `${label}.title`), multiselect: decision.multiselect, option_component_ids: options };
  });
}

function normalizeRevision(value, label) {
  if (typeof value !== 'string' || !REVISION_PATTERN.test(value)) {
    throw new TypeError(`${label} must be exactly 8 lowercase hexadecimal characters`);
  }
  return value;
}

function normalizeReplies(value, replyIds, threadLabel) {
  return boundedArray(value, 200, `${threadLabel}.replies`).map((reply, index) => {
    const label = `${threadLabel}.replies[${index}]`;
    assertObject(reply, label);
    rejectUnknown(reply, ['id', 'author', 'text', 'recorded_at'], label);
    const id = uniqueId(identifier(reply.id, `${label}.id`), replyIds, 'Reply');
    const recordedAt = text(reply.recorded_at, 40, `${label}.recorded_at`);
    const timestamp = recordedAt.match(RFC3339_PATTERN);
    const year = Number(timestamp?.[1]);
    const month = Number(timestamp?.[2]);
    const day = Number(timestamp?.[3]);
    const hour = Number(timestamp?.[4]);
    const minute = Number(timestamp?.[5]);
    const second = Number(timestamp?.[6]);
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    const offsetHour = timestamp?.[10] == null ? 0 : Number(timestamp[10]);
    const offsetMinute = timestamp?.[11] == null ? 0 : Number(timestamp[11]);
    if (!timestamp || month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]
      || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59
      || Number.isNaN(Date.parse(recordedAt))) {
      throw new TypeError(`${label}.recorded_at must be an RFC 3339 date-time`);
    }
    return {
      id,
      author: text(reply.author, 80, `${label}.author`),
      text: text(reply.text, 10_000, `${label}.text`),
      recorded_at: recordedAt,
    };
  });
}

function normalizeFeedbackThreads(value, componentIds) {
  const threadIds = new Set();
  const replyIds = new Set();
  return boundedArray(value, 1000, 'workspace document.feedback_threads').map((thread, index) => {
    const label = `workspace document.feedback_threads[${index}]`;
    assertObject(thread, label);
    rejectUnknown(thread, ['id', 'component_id', 'revision', 'type', 'status', 'comment', 'replies'], label);
    const id = uniqueId(identifier(thread.id, `${label}.id`), threadIds, 'feedback thread');
    const componentId = identifier(thread.component_id, `${label}.component_id`);
    if (!componentIds.has(componentId)) throw new TypeError(`feedback thread ${id} references unknown component ${componentId}`);
    const status = text(thread.status, 20, `${label}.status`);
    if (!['open', 'resolved', 'outdated'].includes(status)) throw new TypeError(`${label}.status is unsupported`);
    return {
      id,
      component_id: componentId,
      revision: normalizeRevision(thread.revision, `${label}.revision`),
      type: text(thread.type, 200, `${label}.type`),
      status,
      comment: text(thread.comment, 10_000, `${label}.comment`),
      replies: normalizeReplies(thread.replies, replyIds, label),
    };
  });
}

function normalizeWorkspaceDocument(value, options = {}) {
  assertObject(value, 'workspace document');
  if (byteLength(value) > MAX_WORKSPACE_DOCUMENT_BYTES) {
    throw new RangeError(`workspace document exceeds ${MAX_WORKSPACE_DOCUMENT_BYTES} bytes`);
  }
  rejectUnknown(value, ENVELOPE_FIELDS, 'workspace document');
  if (value.version !== 2) throw new TypeError('workspace document.version must be 2');
  if (typeof options.contentValidator !== 'function') throw new TypeError('content validator is required');

  const workId = text(value.work_id, 200, 'workspace document.work_id');
  if (!WORK_ID_PATTERN.test(workId)) throw new TypeError('workspace document.work_id is invalid');
  const workspaceKind = text(value.workspace_kind, 40, 'workspace document.workspace_kind');
  if (!WORKSPACE_KIND_SET.has(workspaceKind)) throw new TypeError(`unsupported Workspace Kind ${workspaceKind}`);
  const evidenceRefs = normalizeEvidenceReferences(value.evidence_refs);
  const frames = normalizeFrames(value.frames);
  const components = normalizeComponents(value.components);
  validateFrameMembership(frames, components);
  const componentIds = new Set(components.map(component => component.id));
  const decisions = normalizeDecisions(value.decisions, componentIds);
  const feedbackThreads = normalizeFeedbackThreads(value.feedback_threads, componentIds);
  assertObject(value.content, 'workspace document.content');
  const content = options.contentValidator(structuredClone(value.content), {
    work_id: workId,
    workspace_kind: workspaceKind,
  });
  assertObject(content, 'normalized content from content validator');
  const normalized = {
    version: 2,
    work_id: workId,
    workspace_kind: workspaceKind,
    title: text(value.title, 300, 'workspace document.title'),
    evidence_refs: evidenceRefs,
    revision: undefined,
    frames,
    components,
    decisions,
    feedback_threads: feedbackThreads,
    content: structuredClone(content),
    read_only: value.read_only === true,
  };
  if (value.read_only !== true && value.read_only !== false) throw new TypeError('workspace document.read_only must be a boolean');
  if (byteLength(normalized) > MAX_WORKSPACE_DOCUMENT_BYTES) {
    throw new RangeError(`normalized workspace document exceeds ${MAX_WORKSPACE_DOCUMENT_BYTES} bytes`);
  }
  const derivedRevision = documentRevision(normalized);
  if (value.revision != null) {
    const suppliedRevision = normalizeRevision(value.revision, 'workspace document.revision');
    if (suppliedRevision !== derivedRevision) throw new TypeError('workspace document.revision must match the derived content Revision');
  }
  normalized.revision = derivedRevision;
  if (byteLength(normalized) > MAX_WORKSPACE_DOCUMENT_BYTES) {
    throw new RangeError(`normalized workspace document exceeds ${MAX_WORKSPACE_DOCUMENT_BYTES} bytes`);
  }
  return normalized;
}

module.exports = {
  MAX_WORKSPACE_DOCUMENT_BYTES,
  WORKSPACE_KINDS,
  documentRevision,
  normalizeOpaqueWorkspaceContent,
  normalizeWorkspaceDocument,
};
