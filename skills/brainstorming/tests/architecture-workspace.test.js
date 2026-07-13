'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const Ajv2020 = require('ajv/dist/2020').default;

const { normalizeKnownWorkspaceContent } = require('../scripts/workspace-content.cjs');
const { normalizeWorkspaceDocument } = require('../scripts/workspace-document.cjs');

const fixturePath = path.join(__dirname, '..', 'fixtures', 'architecture-large.json');
const schemaPath = path.join(__dirname, '..', 'schemas', 'architecture-workspace.schema.json');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function fixture() {
  return readJson(fixturePath);
}

function architectureValidator() {
  assert.equal(
    fs.existsSync(schemaPath),
    true,
    'Architecture Canvas must own architecture-workspace.schema.json',
  );
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  return ajv.compile(readJson(schemaPath));
}

function assertValid(validate, value, message) {
  assert.equal(validate(value), true, `${message}: ${JSON.stringify(validate.errors)}`);
}

function ids(values) {
  return new Set(values.map(value => value.id));
}

test('large Architecture Canvas fixture is a canonical v2 architecture Visual Document', () => {
  const document = fixture();
  const normalized = normalizeWorkspaceDocument(document, {
    contentValidator(content, context) {
      assert.equal(context.workspace_kind, 'architecture');
      return content;
    },
  });

  assert.deepEqual(normalized, document);
  assert.equal(document.workspace_kind, 'architecture');
  assert.equal(document.frames.length, 1);
  assert.equal(document.frames[0].id, 'topology');
  assert.deepEqual(document.evidence_refs[0], {
    id: 'EVD-001-design-direction-approval',
    label: 'Approved exclusive view modes',
  });
});

test('large graph has typed nodes, typed edges, typed ports, and resolvable nested ownership', () => {
  const { content } = fixture();
  const nodeIds = ids(content.nodes);
  const boundaryIds = ids(content.ownership_boundaries);
  const nodeTypes = new Set();
  const edgeTypes = new Set();

  assert.equal(content.nodes.length, 200);
  assert.equal(content.edges.length, 320);
  assert.equal(content.ownership_boundaries.length, 5);

  for (const boundary of content.ownership_boundaries) {
    if (boundary.parent_id !== null) {
      assert.ok(boundaryIds.has(boundary.parent_id), `${boundary.id} parent must resolve`);
      assert.notEqual(boundary.parent_id, boundary.id, `${boundary.id} cannot own itself`);
    }
  }
  assert.ok(
    content.ownership_boundaries.some(boundary => {
      const parent = content.ownership_boundaries.find(candidate => candidate.id === boundary.parent_id);
      return parent?.parent_id !== null;
    }),
    'fixture must contain ownership nested at least two levels deep',
  );

  for (const node of content.nodes) {
    nodeTypes.add(node.type);
    assert.ok(boundaryIds.has(node.owner_id), `${node.id} owner must resolve`);
    assert.deepEqual(node.ports.map(port => port.direction), ['input', 'output']);
    assert.ok(node.ports.every(port => port.kind && port.protocol), `${node.id} ports must be typed`);
  }
  assert.ok(nodeTypes.size >= 6, 'large fixture must exercise multiple node types');

  for (const edge of content.edges) {
    edgeTypes.add(edge.type);
    const source = content.nodes.find(node => node.id === edge.source.node_id);
    const target = content.nodes.find(node => node.id === edge.target.node_id);
    assert.ok(source, `${edge.id} source node must resolve`);
    assert.ok(target, `${edge.id} target node must resolve`);
    assert.equal(source.ports.find(port => port.id === edge.source.port_id)?.direction, 'output');
    assert.equal(target.ports.find(port => port.id === edge.target.port_id)?.direction, 'input');
    assert.ok(edge.modes.every(mode => source.modes.includes(mode) && target.modes.includes(mode)));
  }
  assert.ok(edgeTypes.size >= 5, 'large fixture must exercise multiple edge types');
  assert.equal(nodeIds.has('delivery-core'), true);
});

test('approved exclusive modes share one versioned layout contract without duplicated coordinates', () => {
  const { content } = fixture();

  assert.deepEqual(content.layout_direction, {
    id: 'exclusive-view-modes',
    comparison: 'exclusive_view_modes',
    evidence_ref: 'EVD-001-design-direction-approval',
  });
  assert.deepEqual(content.layout, {
    contract_version: 1,
    engine: 'elk',
    algorithm: 'layered',
    direction: 'RIGHT',
    stable_across_modes: true,
  });
  assert.equal(content.initial_mode, 'proposed');

  const added = content.nodes.find(node => node.id === 'codex-idle-worker');
  const removed = content.nodes.find(node => node.id === 'legacy-poll-worker');
  assert.deepEqual(added.modes, ['proposed']);
  assert.equal(added.change, 'added');
  assert.deepEqual(removed.modes, ['current']);
  assert.equal(removed.change, 'removed');

  for (const node of content.nodes) {
    assert.deepEqual(Object.keys(node.layout_hint).sort(), ['layer', 'order']);
    for (const forbidden of ['position', 'current_position', 'proposed_position', 'states']) {
      assert.equal(Object.hasOwn(node, forbidden), false, `${node.id} must use the one shared layout contract`);
    }
  }
});

test('scenario paths resolve in both modes and camera, focus, and annotation contracts are explicit', () => {
  const { content } = fixture();
  const nodeIds = ids(content.nodes);
  const edgeIds = ids(content.edges);
  const boundaryIds = ids(content.ownership_boundaries);
  const componentIds = new Set(fixture().components.map(component => component.id));

  assert.equal(content.scenarios.length, 1);
  const scenario = content.scenarios[0];
  assert.equal(scenario.id, 'feedback-delivery');
  for (const mode of ['current', 'proposed']) {
    const scenarioPath = scenario.paths[mode];
    assert.equal(scenarioPath.node_ids.length, scenarioPath.edge_ids.length + 1);
    assert.ok(scenarioPath.node_ids.every(id => nodeIds.has(id)), `${mode} scenario nodes must resolve`);
    assert.ok(scenarioPath.edge_ids.every(id => edgeIds.has(id)), `${mode} scenario edges must resolve`);
    assert.ok(scenarioPath.node_ids.every(id => content.nodes.find(node => node.id === id).modes.includes(mode)));
    assert.ok(scenarioPath.edge_ids.every(id => content.edges.find(edge => edge.id === id).modes.includes(mode)));
  }

  assert.deepEqual(content.camera.controls, ['pan', 'zoom_in', 'zoom_out', 'fit_view', 'minimap']);
  assert.ok(content.camera.min_zoom < content.camera.default_zoom);
  assert.ok(content.camera.default_zoom < content.camera.max_zoom);
  assert.ok(content.focus_targets.every(id => nodeIds.has(id) || boundaryIds.has(id)));
  assert.ok(content.annotation_targets.every(id => componentIds.has(id)));
  assert.ok(content.annotation_targets.some(id => edgeIds.has(id)), 'an edge must be annotatable');
});

test('Architecture Workspace Kind schema validates the representative semantic graph contract', () => {
  const validate = architectureValidator();
  assertValid(validate, fixture().content, 'representative Architecture content must validate');
});

test('Architecture Workspace Kind schema rejects untyped topology and unstable comparison drift', () => {
  const validate = architectureValidator();
  const candidates = [];

  const untypedNode = structuredClone(fixture().content);
  untypedNode.nodes[0].type = 'mystery';
  candidates.push(['untyped node', untypedNode]);

  const untypedPort = structuredClone(fixture().content);
  untypedPort.nodes[0].ports[0].direction = 'sideways';
  candidates.push(['untyped port direction', untypedPort]);

  const untypedEdge = structuredClone(fixture().content);
  untypedEdge.edges[0].type = 'mystery';
  candidates.push(['untyped edge', untypedEdge]);

  const duplicatedCoordinates = structuredClone(fixture().content);
  duplicatedCoordinates.nodes[0].current_position = { x: 0, y: 0 };
  candidates.push(['mode-specific coordinates', duplicatedCoordinates]);

  const unstableLayout = structuredClone(fixture().content);
  unstableLayout.layout.stable_across_modes = false;
  candidates.push(['unstable layout', unstableLayout]);

  const unapprovedComparison = structuredClone(fixture().content);
  unapprovedComparison.layout_direction.comparison = 'unsynced_split';
  candidates.push(['unapproved comparison', unapprovedComparison]);

  for (const [name, candidate] of candidates) {
    assert.equal(validate(candidate), false, `${name} must be rejected by the Architecture schema`);
  }
});

test('runtime content composition enforces the Architecture schema instead of accepting opaque content', () => {
  const invalid = structuredClone(fixture().content);
  invalid.nodes[0].ports[0].direction = 'sideways';

  assert.throws(
    () => normalizeKnownWorkspaceContent(invalid, { workspace_kind: 'architecture' }),
    /architecture Workspace content is invalid/i,
  );
});
