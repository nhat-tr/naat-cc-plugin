'use strict';

// Persistent Workspace Tabs let an agent publish several Visual Documents (an Architecture Canvas
// plus one or more UML diagrams) into the same live session without any of them displacing another.
// workspace.json keeps meaning exactly what it always meant — "the currently active document" — so
// every existing single-document consumer (export, standalone snapshot, feedback Revision binding)
// stays untouched. Tabs are a pure addition: each published document is filed under a stable id in
// tab-<id>.json, indexed by tabs-index.json, and never overwritten by publishing a different tab.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const TABS_INDEX_FILE = 'tabs-index.json';
const TAB_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_LABEL_LENGTH = 120;

const UML_DIAGRAM_LABELS = {
  component: 'Component Diagram',
  state_machine: 'State Machine',
  activity: 'Activity Diagram',
  sequence: 'Sequence Diagram',
};

const WORKSPACE_KIND_LABELS = {
  architecture: 'Architecture Canvas',
  product: 'Product',
  research: 'Research',
  business: 'Business',
  review: 'Review',
};

function assertTabId(tabId) {
  if (typeof tabId !== 'string' || !TAB_ID_PATTERN.test(tabId)) {
    throw new TypeError('tab id must be a lowercase identifier of up to 64 characters');
  }
  return tabId;
}

function tabFileName(tabId) {
  return `tab-${assertTabId(tabId)}.json`;
}

function tabsIndexPath(contentDir) {
  return path.join(contentDir, TABS_INDEX_FILE);
}

function tabDocumentPath(contentDir, tabId) {
  return path.join(contentDir, tabFileName(tabId));
}

function defaultTabId(document) {
  if (!document || typeof document !== 'object') throw new TypeError('document is required to derive a tab id');
  if (document.workspace_kind === 'uml') {
    const diagramKind = document.content?.diagram_kind;
    if (typeof diagramKind !== 'string' || !diagramKind) {
      throw new TypeError('uml workspace document.content.diagram_kind is required to derive a tab id');
    }
    return assertTabId(`uml-${diagramKind}`);
  }
  return assertTabId(String(document.workspace_kind));
}

function defaultTabLabel(document) {
  if (document?.workspace_kind === 'uml') {
    const diagramKind = document.content?.diagram_kind;
    return UML_DIAGRAM_LABELS[diagramKind] || 'UML Diagram';
  }
  return WORKSPACE_KIND_LABELS[document?.workspace_kind] || String(document?.workspace_kind ?? 'Workspace');
}

function normalizeLabel(label, document) {
  if (label == null) return defaultTabLabel(document);
  if (typeof label !== 'string') throw new TypeError('tab label must be text');
  const trimmed = label.trim();
  if (!trimmed) return defaultTabLabel(document);
  if (trimmed.length > MAX_LABEL_LENGTH) throw new RangeError(`tab label must be at most ${MAX_LABEL_LENGTH} characters`);
  return trimmed;
}

function readRegularJson(file, label) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error.code === 'ELOOP') throw new Error(`${label} must be a regular file and must not be a symlink`);
    throw new Error(`${label} could not be read`);
  }
  let contents;
  try {
    if (!fs.fstatSync(descriptor).isFile()) {
      throw new Error(`${label} must be a regular file and must not be a symlink`);
    }
    contents = fs.readFileSync(descriptor, 'utf8');
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    return JSON.parse(contents);
  } catch {
    throw new Error(`${label} contains invalid JSON`);
  }
}

function atomicJson(file, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, mode);
}

function readWorkspaceTabsIndex(contentDir) {
  const value = readRegularJson(tabsIndexPath(contentDir), 'Workspace Tabs index');
  if (value == null) return { version: 1, active_tab_id: null, tabs: [] };
  if (value.version !== 1 || !Array.isArray(value.tabs)) {
    throw new Error('Workspace Tabs index is malformed');
  }
  return value;
}

function readWorkspaceTabDocument(contentDir, tabId) {
  return readRegularJson(tabDocumentPath(contentDir, tabId), 'Workspace Tab document');
}

function listWorkspaceTabFiles(contentDir) {
  let entries;
  try {
    entries = fs.readdirSync(contentDir);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return entries.filter(name => name.startsWith('tab-') && name.endsWith('.json'));
}

// Writes (or republishes) one Workspace Tab and makes it the active tab. An existing tab id keeps
// its position in the tab bar — only its label/kind/updated_at and document body change in place —
// so republishing never reorders tabs the user has already arranged their attention around.
function writeWorkspaceTab(contentDir, options = {}) {
  const { document } = options;
  if (!document || typeof document !== 'object') throw new TypeError('document is required');
  const tabId = options.tabId != null ? assertTabId(options.tabId) : defaultTabId(document);
  const label = normalizeLabel(options.label, document);
  const now = options.now ?? Date.now();
  const updatedAt = new Date(now).toISOString();

  const index = readWorkspaceTabsIndex(contentDir);
  const existingIndex = index.tabs.findIndex(tab => tab.id === tabId);
  const entry = { id: tabId, label, workspace_kind: document.workspace_kind, updated_at: updatedAt };
  const created = existingIndex === -1;
  const tabs = created ? [...index.tabs, entry] : index.tabs.map((tab, i) => (i === existingIndex ? entry : tab));

  atomicJson(tabDocumentPath(contentDir, tabId), document);
  atomicJson(tabsIndexPath(contentDir), { version: 1, active_tab_id: tabId, tabs });

  return { tabId, label, created };
}

module.exports = {
  TAB_ID_PATTERN,
  defaultTabId,
  defaultTabLabel,
  listWorkspaceTabFiles,
  readWorkspaceTabDocument,
  readWorkspaceTabsIndex,
  tabDocumentPath,
  tabsIndexPath,
  writeWorkspaceTab,
};
