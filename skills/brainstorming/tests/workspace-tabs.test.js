const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const { createScratchDirectory } = require('./test-support');

const workspaceTabs = require('../scripts/workspace-tabs.cjs');

function architectureDocument(overrides = {}) {
  return {
    version: 2,
    work_id: 'work-20260712-visual-companion-vnext',
    workspace_kind: 'architecture',
    content: {},
    ...overrides,
  };
}

function umlDocument(diagramKind, overrides = {}) {
  return {
    version: 2,
    work_id: 'work-20260712-visual-companion-vnext',
    workspace_kind: 'uml',
    content: { diagram_kind: diagramKind },
    ...overrides,
  };
}

test('defaultTabId derives a stable id per Workspace Kind, and per UML diagram_kind', () => {
  assert.equal(workspaceTabs.defaultTabId(architectureDocument()), 'architecture');
  assert.equal(workspaceTabs.defaultTabId(umlDocument('state_machine')), 'uml-state_machine');
  assert.equal(workspaceTabs.defaultTabId(umlDocument('sequence')), 'uml-sequence');
});

test('defaultTabId rejects a uml document missing content.diagram_kind', () => {
  assert.throws(() => workspaceTabs.defaultTabId(umlDocument(undefined, { content: {} })), /diagram_kind/);
});

test('writeWorkspaceTab creates a new tab entry and makes it the active tab', t => {
  const contentDir = createScratchDirectory(t, 'workspace-tabs-create');
  const document = architectureDocument();
  const result = workspaceTabs.writeWorkspaceTab(contentDir, { document, now: 1_000 });

  assert.equal(result.tabId, 'architecture');
  assert.equal(result.created, true);

  const index = workspaceTabs.readWorkspaceTabsIndex(contentDir);
  assert.equal(index.active_tab_id, 'architecture');
  assert.equal(index.tabs.length, 1);
  assert.equal(index.tabs[0].id, 'architecture');
  assert.equal(index.tabs[0].label, 'Architecture Canvas');
  assert.equal(index.tabs[0].workspace_kind, 'architecture');
  assert.equal(index.tabs[0].updated_at, new Date(1_000).toISOString());

  assert.deepEqual(workspaceTabs.readWorkspaceTabDocument(contentDir, 'architecture'), document);
});

test('writeWorkspaceTab keeps prior tabs untouched and preserves creation order when adding a new tab', t => {
  const contentDir = createScratchDirectory(t, 'workspace-tabs-multi');
  const architecture = architectureDocument();
  const stateMachine = umlDocument('state_machine');
  const sequence = umlDocument('sequence');

  workspaceTabs.writeWorkspaceTab(contentDir, { document: architecture, now: 1_000 });
  workspaceTabs.writeWorkspaceTab(contentDir, { document: stateMachine, now: 2_000 });
  workspaceTabs.writeWorkspaceTab(contentDir, { document: sequence, now: 3_000 });

  const index = workspaceTabs.readWorkspaceTabsIndex(contentDir);
  assert.equal(index.active_tab_id, 'uml-sequence');
  assert.deepEqual(index.tabs.map(tab => tab.id), ['architecture', 'uml-state_machine', 'uml-sequence']);

  // Untouched tabs must still be readable, byte for byte.
  assert.deepEqual(workspaceTabs.readWorkspaceTabDocument(contentDir, 'architecture'), architecture);
  assert.deepEqual(workspaceTabs.readWorkspaceTabDocument(contentDir, 'uml-state_machine'), stateMachine);
});

test('writeWorkspaceTab republishing an existing tab id updates content in place without moving its position', t => {
  const contentDir = createScratchDirectory(t, 'workspace-tabs-republish');
  workspaceTabs.writeWorkspaceTab(contentDir, { document: architectureDocument(), now: 1_000 });
  workspaceTabs.writeWorkspaceTab(contentDir, { document: umlDocument('sequence'), now: 2_000 });

  const revised = architectureDocument({ title: 'Revised architecture' });
  const result = workspaceTabs.writeWorkspaceTab(contentDir, { document: revised, now: 3_000 });
  assert.equal(result.created, false);

  const index = workspaceTabs.readWorkspaceTabsIndex(contentDir);
  assert.deepEqual(index.tabs.map(tab => tab.id), ['architecture', 'uml-sequence']);
  assert.equal(index.active_tab_id, 'architecture');
  assert.equal(index.tabs[0].updated_at, new Date(3_000).toISOString());
  assert.deepEqual(workspaceTabs.readWorkspaceTabDocument(contentDir, 'architecture'), revised);
});

test('writeWorkspaceTab accepts an explicit tabId and tabLabel override', t => {
  const contentDir = createScratchDirectory(t, 'workspace-tabs-explicit');
  const result = workspaceTabs.writeWorkspaceTab(contentDir, {
    document: umlDocument('state_machine'),
    tabId: 'lifecycle',
    label: 'Pair v4 Lifecycle',
    now: 1_000,
  });
  assert.equal(result.tabId, 'lifecycle');
  const index = workspaceTabs.readWorkspaceTabsIndex(contentDir);
  assert.equal(index.tabs[0].id, 'lifecycle');
  assert.equal(index.tabs[0].label, 'Pair v4 Lifecycle');
});

test('writeWorkspaceTab rejects a malformed explicit tabId', t => {
  const contentDir = createScratchDirectory(t, 'workspace-tabs-bad-id');
  assert.throws(() => workspaceTabs.writeWorkspaceTab(contentDir, {
    document: architectureDocument(),
    tabId: 'Not Valid!',
  }), /identifier/);
});

test('readWorkspaceTabsIndex returns an empty index when no tabs have been published', t => {
  const contentDir = createScratchDirectory(t, 'workspace-tabs-empty');
  fs.mkdirSync(contentDir, { recursive: true });
  const index = workspaceTabs.readWorkspaceTabsIndex(contentDir);
  assert.deepEqual(index, { version: 1, active_tab_id: null, tabs: [] });
});

test('readWorkspaceTabDocument returns null for an unknown tab id', t => {
  const contentDir = createScratchDirectory(t, 'workspace-tabs-missing');
  fs.mkdirSync(contentDir, { recursive: true });
  assert.equal(workspaceTabs.readWorkspaceTabDocument(contentDir, 'architecture'), null);
});

test('readWorkspaceTabDocument rejects a malformed tab id rather than reading arbitrary paths', t => {
  const contentDir = createScratchDirectory(t, 'workspace-tabs-traversal');
  fs.mkdirSync(contentDir, { recursive: true });
  assert.throws(() => workspaceTabs.readWorkspaceTabDocument(contentDir, '../../etc/passwd'), /identifier/);
});

test('listWorkspaceTabFiles enumerates only tab document files present on disk', t => {
  const contentDir = createScratchDirectory(t, 'workspace-tabs-listing');
  workspaceTabs.writeWorkspaceTab(contentDir, { document: architectureDocument(), now: 1_000 });
  workspaceTabs.writeWorkspaceTab(contentDir, { document: umlDocument('sequence'), now: 2_000 });
  fs.writeFileSync(`${contentDir}/workspace.json`, '{}');
  fs.writeFileSync(`${contentDir}/screen.json`, '{}');

  const files = workspaceTabs.listWorkspaceTabFiles(contentDir).sort();
  assert.deepEqual(files, ['tab-architecture.json', 'tab-uml-sequence.json']);
});
