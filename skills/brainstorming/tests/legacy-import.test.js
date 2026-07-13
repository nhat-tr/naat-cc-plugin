const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { normalizeVisualDocument } = require('../scripts/visual-document.cjs');
const { createScratchDirectory } = require('./test-support');

let legacyImport = {};
let workspaceDocument = {};
try {
  legacyImport = require('../scripts/legacy-visual-import.cjs');
  workspaceDocument = require('../scripts/workspace-document.cjs');
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
}

function contractFunction(name) {
  assert.equal(
    typeof legacyImport[name],
    'function',
    `legacy-visual-import.cjs must export ${name}`,
  );
  return legacyImport[name];
}

function workspaceContractFunction(name) {
  assert.equal(
    typeof workspaceDocument[name],
    'function',
    `workspace-document.cjs must export ${name}`,
  );
  return workspaceDocument[name];
}

function legacyDocument() {
  return normalizeVisualDocument({
    version: 1,
    profile: 'technical',
    audience: 'Software developers',
    title: 'Visual Companion compatibility',
    summary: 'Keep existing identity and feedback readable.',
    sections: [
      {
        kind: 'cards',
        id: 'facts',
        title: 'Observed facts',
        items: [{
          id: 'identity',
          title: 'Identity contract',
          points: ['Section and item IDs remain stable.', 'Derived Point IDs remain stable.'],
        }],
      },
      {
        kind: 'mockup',
        id: 'prototype',
        title: 'Existing mockup',
        device: 'desktop',
        regions: [{
          id: 'toolbar',
          title: 'Toolbar',
          elements: [
            { kind: 'heading', text: 'Visual Companion' },
            { kind: 'button', label: 'Submit feedback', variant: 'primary' },
          ],
        }],
      },
      {
        kind: 'decision',
        id: 'transport',
        title: 'Choose transport',
        options: [
          { id: 'sse', label: 'SSE', points: ['Reconnect from durable state.'] },
          { id: 'polling', label: 'Polling' },
        ],
      },
    ],
  });
}

function legacySessionSnapshot() {
  return {
    version: 1,
    cursor: 0,
    pendingTurns: 1,
    events: [{
      version: 1,
      id: 'event-1',
      seq: 1,
      timestamp: 1_725_000_000_000,
      type: 'user.turn',
      role: 'user',
      clientTurnId: 'legacy-turn-1',
      message: 'Keep both anchors.',
      annotations: [
        {
          id: 'point-note',
          comment: 'This Point identity must survive import.',
          target: { componentId: 'identity-p2', selector: null, label: 'Derived Point' },
        },
        {
          id: 'element-note',
          comment: 'This element identity must survive import.',
          target: { componentId: 'toolbar-e2', selector: null, label: 'Submit feedback button' },
        },
      ],
      choices: [{
        groupId: 'transport',
        componentId: 'sse',
        value: 'sse',
        label: 'SSE',
      }],
      screen: { id: 'screen', file: 'screen.json', revision: 'a1b2c3d4' },
    }],
  };
}

function importOptions(overrides = {}) {
  return {
    workId: 'work-20260712-visual-companion-vnext',
    workspaceKind: 'review',
    sessionSnapshot: legacySessionSnapshot(),
    evidenceRefs: [{ id: 'EVD-legacy-session', label: 'Imported Visual Session' }],
    ...overrides,
  };
}

test('legacy visual document import is deterministic, read-only, and does not mutate v1 input', () => {
  const importLegacyVisualDocument = contractFunction('importLegacyVisualDocument');
  const source = legacyDocument();
  const sessionSnapshot = legacySessionSnapshot();
  const sourceBefore = structuredClone(source);
  const sessionSnapshotBefore = structuredClone(sessionSnapshot);

  const first = importLegacyVisualDocument(source, importOptions({ sessionSnapshot }));
  const second = importLegacyVisualDocument(source, importOptions({ sessionSnapshot }));

  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.deepEqual(source, sourceBefore);
  assert.deepEqual(sessionSnapshot, sessionSnapshotBefore);
  assert.equal(first.version, 2);
  assert.equal(first.workspace_kind, 'review');
  assert.equal(first.revision, workspaceContractFunction('documentRevision')(first));
  assert.equal(first.read_only, true);
  assert.deepEqual(first.evidence_refs, [{ id: 'EVD-legacy-session', label: 'Imported Visual Session' }]);
  assert.deepEqual(first.content.legacy_document, source);
});

test('legacy visual state preserves Session Store identity and history outside feedback threads', () => {
  const importLegacyVisualState = contractFunction('importLegacyVisualState');
  const source = legacyDocument();
  const sessionSnapshot = legacySessionSnapshot();
  const imported = importLegacyVisualState(source, importOptions({ sessionSnapshot }));

  assert.equal(imported.document.version, 2);
  assert.deepEqual(imported.session, sessionSnapshot);
  assert.equal(imported.session.events[0].id, 'event-1');
  assert.equal(imported.session.events[0].clientTurnId, 'legacy-turn-1');
  assert.equal(imported.session.events[0].message, 'Keep both anchors.');
  assert.deepEqual(imported.session.events[0].choices, [{
    groupId: 'transport',
    componentId: 'sse',
    value: 'sse',
    label: 'SSE',
  }]);
  assert.equal(imported.session.events[0].screen.revision, 'a1b2c3d4');
  assert.deepEqual(sessionSnapshot, legacySessionSnapshot(), 'import must not mutate persisted v1 history');
});

test('legacy visual document import materializes the renderer exact Component inventory including Point and element IDs', () => {
  const importLegacyVisualDocument = contractFunction('importLegacyVisualDocument');
  const imported = importLegacyVisualDocument(legacyDocument(), importOptions());

  assert.deepEqual(imported.components.map(component => component.id), [
    'facts',
    'identity',
    'identity-p1',
    'identity-p2',
    'prototype',
    'toolbar',
    'toolbar-e1',
    'toolbar-e2',
    'transport',
    'sse',
    'sse-p1',
    'polling',
  ]);
  assert.deepEqual(
    imported.feedback_threads,
    [
      {
        id: 'point-note',
        component_id: 'identity-p2',
        revision: 'a1b2c3d4',
        type: 'annotation',
        status: 'open',
        comment: 'This Point identity must survive import.',
        replies: [],
      },
      {
        id: 'element-note',
        component_id: 'toolbar-e2',
        revision: 'a1b2c3d4',
        type: 'annotation',
        status: 'open',
        comment: 'This element identity must survive import.',
        replies: [],
      },
    ],
  );
  assert.equal(imported.feedback_threads.some(thread => Object.hasOwn(thread, 'choices')), false);
  assert.equal(imported.feedback_threads.some(thread => Object.hasOwn(thread, 'message')), false);
});

test('legacy visual document import requires an explicit Workspace Kind and rejects orphaned feedback identity', () => {
  const importLegacyVisualDocument = contractFunction('importLegacyVisualDocument');

  assert.throws(
    () => importLegacyVisualDocument(legacyDocument(), importOptions({ workspaceKind: undefined })),
    /workspace kind|workspaceKind.*required/i,
  );
  assert.throws(
    () => importLegacyVisualDocument(legacyDocument(), importOptions({ workspaceKind: 'technical' })),
    /workspace kind|unsupported/i,
  );

  const sessionSnapshot = legacySessionSnapshot();
  sessionSnapshot.events[0].annotations[0].target.componentId = 'identity-p3';
  assert.throws(
    () => importLegacyVisualDocument(legacyDocument(), importOptions({ sessionSnapshot })),
    /identity-p3|unknown component|feedback.*anchor/i,
  );
});

test('legacy visual document file import never overwrites source or an existing v2 destination', t => {
  const writeLegacyVisualImport = contractFunction('writeLegacyVisualImport');
  const directory = createScratchDirectory(t, 'legacy-visual-import');
  const sourceFile = path.join(directory, 'screen.json');
  const outputFile = path.join(directory, 'workspace.json');
  const secondOutputFile = path.join(directory, 'workspace-second.json');
  const sourceBytes = `${JSON.stringify(legacyDocument(), null, 2)}\n`;
  fs.writeFileSync(sourceFile, sourceBytes);

  const first = writeLegacyVisualImport({
    sourceFile,
    outputFile,
    ...importOptions(),
  });

  assert.equal(first, outputFile);
  assert.equal(fs.readFileSync(sourceFile, 'utf8'), sourceBytes);
  const importedBytes = fs.readFileSync(outputFile, 'utf8');
  const imported = JSON.parse(importedBytes);
  assert.equal(imported.version, 2);
  assert.equal(imported.read_only, true);

  writeLegacyVisualImport({
    sourceFile,
    outputFile: secondOutputFile,
    ...importOptions(),
  });
  assert.equal(fs.readFileSync(secondOutputFile, 'utf8'), importedBytes);

  assert.throws(
    () => writeLegacyVisualImport({
      sourceFile,
      outputFile,
      ...importOptions(),
    }),
    /already exists|overwrite|EEXIST/i,
  );
  assert.equal(fs.readFileSync(sourceFile, 'utf8'), sourceBytes);
  assert.equal(fs.readFileSync(outputFile, 'utf8'), importedBytes);
});

test('legacy visual document file import refuses a symlink source at its own trust boundary', t => {
  const writeLegacyVisualImport = contractFunction('writeLegacyVisualImport');
  const directory = createScratchDirectory(t, 'legacy-visual-import-symlink');
  const outsideDirectory = createScratchDirectory(t, 'legacy-visual-import-outside');
  const outsideFile = path.join(outsideDirectory, 'screen.json');
  const sourceFile = path.join(directory, 'screen.json');
  const outputFile = path.join(directory, 'workspace.json');
  fs.writeFileSync(outsideFile, `${JSON.stringify(legacyDocument())}\n`);
  fs.symlinkSync(outsideFile, sourceFile);

  assert.throws(
    () => writeLegacyVisualImport({ sourceFile, outputFile, ...importOptions() }),
    /symlink|regular file/i,
  );
  assert.equal(fs.existsSync(outputFile), false);
});
