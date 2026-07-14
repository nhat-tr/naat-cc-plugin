'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createWorkspaceScaffold } = require('../scripts/workspace-scaffold.cjs');
const {
  preflightArchitectureContent,
  preflightWorkspaceDocument,
} = require('../scripts/workspace-render-preflight.cjs');

test('Architecture render preflight runs the pinned ELK layout before Publish', async () => {
  const document = createWorkspaceScaffold({
    workId: 'work-20260713-render-preflight',
    workspaceKind: 'architecture',
    title: 'Architecture render preflight',
  });

  const result = await preflightWorkspaceDocument(document);

  assert.equal(result.status, 'ready');
  assert.equal(result.workspace_kind, 'architecture');
  assert.ok(result.width > 0);
  assert.ok(result.height > 0);
  assert.equal(result.node_count, document.content.nodes.length);
  assert.equal(result.edge_count, document.content.edges.length);
  assert.deepEqual(result.scopes.map(scope => scope.id), ['initial_all', 'union', 'current', 'proposed']);
  assert.ok(result.scopes.every(scope => scope.status === 'ready'));
});

test('Architecture render preflight reports a phase-specific ELK failure', async () => {
  const document = createWorkspaceScaffold({
    workId: 'work-20260713-render-failure',
    workspaceKind: 'architecture',
    title: 'Architecture render failure',
  });

  await assert.rejects(
    preflightArchitectureContent(document.content, {
      layout: async () => { throw new Error('synthetic ELK failure'); },
    }),
    /Architecture render preflight failed: initial_all: synthetic ELK failure/,
  );
});

test('Architecture render preflight exercises the compact Scenario Path opened by a large canvas', async () => {
  const document = require('../fixtures/architecture-large.json');
  const result = await preflightWorkspaceDocument(document);
  const initial = result.scopes.find(scope => scope.id === 'initial_scenario');
  const path = document.content.scenarios[0].paths[document.content.initial_mode];

  assert.ok(initial, 'large Architecture preflight must include its initial Scenario Path scope');
  assert.equal(initial.status, 'ready');
  assert.equal(initial.node_count, path.node_ids.length);
  assert.equal(initial.edge_count, path.edge_ids.length);
});

test('render preflight truthfully skips Workspace Kinds without a layout engine', async () => {
  const document = createWorkspaceScaffold({
    workId: 'work-20260713-product-preflight',
    workspaceKind: 'product',
    title: 'Product render preflight',
  });

  assert.deepEqual(await preflightWorkspaceDocument(document), {
    status: 'not_applicable',
    workspace_kind: 'product',
  });
});
