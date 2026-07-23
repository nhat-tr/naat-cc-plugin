'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { compileUmlDraft } = require('../scripts/uml-draft.cjs');
const {
  preflightUmlContent,
  preflightWorkspaceDocument,
} = require('../scripts/workspace-render-preflight.cjs');

function graphDocument() {
  return compileUmlDraft({
    kind: 'uml',
    diagram_kind: 'state_machine',
    work_id: 'work-20260723-uml-preflight',
    title: 'State machine preflight',
    nodes: [
      { id: 'start', label: 'start', node_kind: 'initial' },
      { id: 'active', label: 'Active', node_kind: 'state' },
      { id: 'done', label: 'end', node_kind: 'final' },
    ],
    edges: [
      { id: 't1', source: 'start', target: 'active' },
      { id: 't2', label: 'finish', source: 'active', target: 'done' },
    ],
  });
}

function sequenceDocument() {
  return compileUmlDraft({
    kind: 'uml',
    diagram_kind: 'sequence',
    work_id: 'work-20260723-uml-seq-preflight',
    title: 'Sequence preflight',
    lifelines: [
      { id: 'a', label: 'A', lifeline_kind: 'actor' },
      { id: 'b', label: 'B' },
    ],
    messages: [{ id: 'm1', label: 'call()', from: 'a', to: 'b' }],
    fragments: [],
  });
}

test('UML render preflight runs ELK for graph diagrams and reports finite geometry', async () => {
  const document = graphDocument();
  const result = await preflightWorkspaceDocument(document);

  assert.equal(result.status, 'ready');
  assert.equal(result.workspace_kind, 'uml');
  assert.equal(result.diagram_kind, 'state_machine');
  assert.ok(result.width > 0);
  assert.ok(result.height > 0);
  assert.equal(result.node_count, document.content.nodes.length);
  assert.equal(result.edge_count, document.content.edges.length);
  assert.deepEqual(result.scopes.map(scope => scope.id), ['state_machine']);
  assert.ok(result.scopes.every(scope => scope.status === 'ready'));
});

test('UML render preflight skips ELK for sequence diagrams', async () => {
  const result = await preflightWorkspaceDocument(sequenceDocument());

  assert.equal(result.status, 'ready');
  assert.equal(result.workspace_kind, 'uml');
  assert.equal(result.diagram_kind, 'sequence');
  assert.deepEqual(result.scopes, []);
  assert.equal(result.node_count, 2);
  assert.equal(result.edge_count, 1);
});

test('UML render preflight reports a diagram-specific ELK failure', async () => {
  const document = graphDocument();
  await assert.rejects(
    preflightUmlContent(document.content, {
      layout: async () => { throw new Error('synthetic ELK failure'); },
    }),
    /UML render preflight failed: state_machine: synthetic ELK failure/,
  );
});
