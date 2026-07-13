const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { SessionStore } = require('./session-store.cjs');
const { normalizeVisualDocument } = require('./visual-document.cjs');
const {
  WORKSPACE_KINDS,
  normalizeWorkspaceDocument,
} = require('./workspace-document.cjs');

const WORKSPACE_KIND_SET = new Set(WORKSPACE_KINDS);
const REVISION_PATTERN = /^[a-f0-9]{8}$/;
const VISUAL_STATE_LOCK_STALE_MS = 60_000;

function requireSessionDir(value) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('sessionDir is required');
  return path.resolve(value);
}

function withVisualStateLock(sessionDirValue, action) {
  const sessionDir = requireSessionDir(sessionDirValue);
  const stateDir = path.join(sessionDir, 'state');
  const lockDir = path.join(stateDir, '.visual-state.lock');
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  try {
    fs.mkdirSync(lockDir);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    try {
      if (Date.now() - fs.statSync(lockDir).mtimeMs > VISUAL_STATE_LOCK_STALE_MS) {
        fs.rmSync(lockDir, { recursive: true, force: true });
        fs.mkdirSync(lockDir);
      } else {
        throw new Error('Visual Session state change is already in progress');
      }
    } catch (lockError) {
      if (lockError.code === 'ENOENT') return withVisualStateLock(sessionDir, action);
      throw lockError;
    }
  }
  try {
    return action();
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

function writeExclusive(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, contents, { mode: 0o600, flag: 'wx' });
    fs.linkSync(temporary, file);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('v2 destination already exists; refusing overwrite');
    throw error;
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function readRegularText(file, label) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  } catch (error) {
    if (error.code === 'ELOOP') throw new Error(`${label} must be a regular file and must not be a symlink`);
    throw new Error(`${label} could not be read`);
  }
  try {
    if (!fs.fstatSync(descriptor).isFile()) {
      throw new Error(`${label} must be a regular file and must not be a symlink`);
    }
    return fs.readFileSync(descriptor, 'utf8');
  } finally {
    fs.closeSync(descriptor);
  }
}

function readRegularJson(file, label) {
  try {
    return JSON.parse(readRegularText(file, label));
  } catch (error) {
    if (/regular file|symlink|could not be read/u.test(error.message)) throw error;
    throw new Error(`${label} contains invalid JSON`);
  }
}

function emptySessionSnapshot() {
  return { version: 1, cursor: 0, pendingTurns: 0, events: [] };
}

function cloneSessionSnapshot(value) {
  if (value == null) return emptySessionSnapshot();
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.events)) {
    throw new TypeError('sessionSnapshot must be a Session Store snapshot');
  }
  return structuredClone(value);
}

function componentInventory(document) {
  const frames = [];
  const components = [];
  const decisions = [];
  const add = (frameId, id, label) => components.push({ id, frame_id: frameId, label });

  for (const section of document.sections) {
    const start = components.length;
    add(section.id, section.id, section.title);
    for (const child of section.items || section.nodes || section.regions || []) {
      add(section.id, child.id, child.title);
      (child.points || []).forEach((_point, index) => add(section.id, `${child.id}-p${index + 1}`, `${child.title} - point ${index + 1}`));
      (child.elements || []).forEach((element, index) => add(section.id, `${child.id}-e${index + 1}`, `${child.title} - ${element.kind} ${index + 1}`));
    }
    for (const option of section.options || []) {
      add(section.id, option.id, option.label);
      (option.points || []).forEach((_point, index) => add(section.id, `${option.id}-p${index + 1}`, `${option.label} - point ${index + 1}`));
    }
    const componentIds = components.slice(start).map(component => component.id);
    frames.push({ id: section.id, title: section.title, component_ids: componentIds });
    if (section.kind === 'decision') {
      decisions.push({
        id: section.groupId || section.id,
        title: section.title,
        multiselect: section.multiselect === true,
        option_component_ids: section.options.map(option => option.id),
      });
    }
  }
  return { frames, components, decisions };
}

function feedbackThreads(snapshot, componentIds) {
  const result = [];
  for (const event of snapshot.events) {
    if (event?.type !== 'user.turn') continue;
    const revision = event.screen?.revision;
    for (const annotation of event.annotations || []) {
      const componentId = annotation?.target?.componentId;
      if (!componentIds.has(componentId)) {
        throw new TypeError(`feedback anchor references unknown component ${String(componentId)}`);
      }
      if (typeof revision !== 'string' || !REVISION_PATTERN.test(revision)) {
        throw new TypeError(`feedback annotation ${String(annotation.id)} requires an 8-hex Revision`);
      }
      result.push({
        id: annotation.id,
        component_id: componentId,
        revision,
        type: 'annotation',
        status: 'open',
        comment: annotation.comment,
        replies: [],
      });
    }
  }
  return result;
}

function importLegacyVisualDocument(value, options = {}) {
  if (!WORKSPACE_KIND_SET.has(options.workspaceKind)) {
    throw new TypeError('an explicit supported Workspace Kind is required');
  }
  const source = normalizeVisualDocument(structuredClone(value));
  const session = cloneSessionSnapshot(options.sessionSnapshot);
  const inventory = componentInventory(source);
  const componentIds = new Set(inventory.components.map(component => component.id));
  return normalizeWorkspaceDocument({
    version: 2,
    work_id: options.workId,
    workspace_kind: options.workspaceKind,
    title: source.title,
    evidence_refs: options.evidenceRefs || [],
    revision: undefined,
    frames: inventory.frames,
    components: inventory.components,
    decisions: inventory.decisions,
    feedback_threads: feedbackThreads(session, componentIds),
    content: { legacy_document: source },
    read_only: true,
  }, {
    contentValidator(content) {
      if (!content || typeof content !== 'object' || Array.isArray(content)) throw new TypeError('legacy content must be an object');
      return { legacy_document: normalizeVisualDocument(content.legacy_document) };
    },
  });
}

function importLegacyVisualState(value, options = {}) {
  const session = cloneSessionSnapshot(options.sessionSnapshot);
  return {
    document: importLegacyVisualDocument(value, { ...options, sessionSnapshot: session }),
    session,
  };
}

function writeLegacyVisualImport(options = {}) {
  if (!options.sourceFile || !options.outputFile) throw new TypeError('sourceFile and outputFile are required');
  const sourceFile = path.resolve(options.sourceFile);
  const outputFile = path.resolve(options.outputFile);
  if (sourceFile === outputFile) throw new Error('legacy import output must not overwrite its source');
  const source = readRegularJson(sourceFile, 'legacy Visual Document');
  const document = importLegacyVisualDocument(source, options);
  writeExclusive(outputFile, `${JSON.stringify(document)}\n`);
  return outputFile;
}

function writeActivation(stateDir, activeVersion) {
  const file = path.join(stateDir, 'visual-format.json');
  const value = {
    version: 1,
    active_version: activeVersion,
    v1_document: 'content/screen.json',
    v2_document: 'content/workspace.json',
  };
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return value;
}

function migratePersistedSession(options = {}) {
  const sessionDir = requireSessionDir(options.sessionDir);
  return withVisualStateLock(sessionDir, () => {
    const contentDir = path.join(sessionDir, 'content');
    const stateDir = path.join(sessionDir, 'state');
    const sourceFile = path.join(contentDir, 'screen.json');
    const outputFile = path.join(contentDir, 'workspace.json');
    const store = new SessionStore(stateDir);
    return store.withSnapshotLock(sessionSnapshot => {
      const source = readRegularJson(sourceFile, 'legacy Visual Document');
      const expected = importLegacyVisualDocument(source, {
        workId: options.workId,
        workspaceKind: options.workspaceKind,
        evidenceRefs: options.evidenceRefs || [],
        sessionSnapshot,
      });
      const expectedBytes = `${JSON.stringify(expected)}\n`;
      let reactivated = false;
      if (fs.existsSync(outputFile)) {
        if (readRegularText(outputFile, 'retained v2 Visual Document') !== expectedBytes) {
          throw new Error('retained v2 state differs; refusing overwrite');
        }
        reactivated = true;
      } else {
        writeExclusive(outputFile, expectedBytes);
      }
      writeActivation(stateDir, 2);
      return { activeVersion: 2, document: expected, reactivated };
    });
  });
}

function backoutPersistedSession(options = {}) {
  const sessionDir = requireSessionDir(options.sessionDir);
  return withVisualStateLock(sessionDir, () => {
    const sourceFile = path.join(sessionDir, 'content', 'screen.json');
    if (!fs.existsSync(sourceFile)) throw new Error('persisted v1 Visual Document is unavailable for backout');
    normalizeVisualDocument(readRegularJson(sourceFile, 'persisted v1 Visual Document'));
    const activation = writeActivation(path.join(sessionDir, 'state'), 1);
    return { activeVersion: 1, activation };
  });
}

module.exports = {
  backoutPersistedSession,
  importLegacyVisualDocument,
  importLegacyVisualState,
  migratePersistedSession,
  withVisualStateLock,
  writeLegacyVisualImport,
};
