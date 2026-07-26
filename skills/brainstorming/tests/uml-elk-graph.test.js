'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  UML_NODE_BASE_HEIGHT,
  UML_STEREOTYPE_KINDS,
  umlCardHeight,
  umlEdgeLabelId,
  umlEdgeLabelLines,
  umlEdgeLabelSize,
  buildUmlElkGraph,
} = require('../scripts/uml-elk-graph.cjs');

function umlNode(id, { label, node_kind = 'state', container_id = null, points = [], layer = 0, order = 0 } = {}) {
  return {
    id,
    label,
    node_kind,
    container_id,
    points,
    layout_hint: { layer, order },
  };
}

function umlEdge(id, source, target, label) {
  const edge = { id, source, target };
  if (label !== undefined) edge.label = label;
  return edge;
}

function umlContent({ nodes, edges, containers = [] }) {
  return {
    layout: { algorithm: 'layered', direction: 'DOWN' },
    containers,
    nodes,
    edges,
  };
}

test('buildUmlElkGraph attaches an ELK label to every edge that has a label and omits it otherwise', () => {
  const content = umlContent({
    nodes: [umlNode('a', { label: 'A' }), umlNode('b', { label: 'B' }), umlNode('c', { label: 'C' })],
    edges: [umlEdge('e1', 'a', 'b', 'hosts'), umlEdge('e2', 'b', 'c')],
  });

  const graph = buildUmlElkGraph(content);
  const labeled = graph.edges.find(edge => edge.id === 'e1');
  const unlabeled = graph.edges.find(edge => edge.id === 'e2');

  assert.equal(labeled.labels.length, 1);
  assert.ok(labeled.labels[0].width > 0, 'labelled edge reserves a nonzero label width');
  assert.ok(labeled.labels[0].height > 0, 'labelled edge reserves a nonzero label height');
  assert.equal(labeled.labels[0].text, 'hosts');
  assert.equal(unlabeled.labels, undefined, 'an edge without a label gets no ELK labels array');
});

test('the ELK edge label id matches umlEdgeLabelId(edge.id)', () => {
  const content = umlContent({
    nodes: [umlNode('a', { label: 'A' }), umlNode('b', { label: 'B' })],
    edges: [umlEdge('e1', 'a', 'b', 'hosts')],
  });

  const graph = buildUmlElkGraph(content);
  const edge = graph.edges.find(candidate => candidate.id === 'e1');

  assert.equal(edge.labels[0].id, umlEdgeLabelId('e1'));
});

test('umlEdgeLabelSize agrees with umlEdgeLabelLines: more wrapped lines means taller, longest line drives width', () => {
  const short = umlEdgeLabelSize('hosts');
  const long = umlEdgeLabelSize('AgentRun tool calls pass through');

  assert.equal(short.lines.length, 1);
  assert.ok(long.lines.length > 1, `expected the long label to wrap to more than one line, got ${JSON.stringify(long.lines)}`);
  assert.ok(long.height > short.height, 'more wrapped lines reserves more height');

  // A same-length label with no spaces cannot wrap (umlEdgeLabelLines never breaks a
  // word), so it shows the width the real label would need if forced onto one line.
  // The real label wraps, so its widest line — and thus its width — must be narrower.
  const singleLineEquivalent = umlEdgeLabelSize('x'.repeat('AgentRun tool calls pass through'.length));
  assert.ok(
    long.width < singleLineEquivalent.width,
    'wrapping keeps the label narrower than the single-line width it would otherwise need',
  );

  assert.deepEqual(umlEdgeLabelSize(undefined), { width: 0, height: 0, lines: [] });
});

test('umlEdgeLabelLines never breaks a word and rejoining lines round-trips the label text', () => {
  const token = 'ToolInvocationMiddleware.cs:38-41';
  const label = `See ${token} for the fix`;

  const lines = umlEdgeLabelLines(label);

  assert.ok(lines.includes(token), `expected the over-long token to survive intact, got ${JSON.stringify(lines)}`);
  assert.equal(lines.join(' '), label);
});

test('umlCardHeight reserves more height for a wrapping card label than a short one', () => {
  // node_kind 'component' adds a stereotype line, which pushes the header past the
  // UML_NODE_BASE_HEIGHT floor for the long label but not the short one — with a plain
  // 'state' card both labels clamp to the same base height and the difference is hidden.
  const shortNode = umlNode('short', { label: 'Pipeline', node_kind: 'component' });
  const longNode = umlNode('long', { label: 'ToolInvocationMiddleware (choke point)', node_kind: 'component' });
  assert.ok(
    umlCardHeight(longNode) > umlCardHeight(shortNode),
    'a wrapping label reserves more height than a one-line label',
  );

  const shortWithPoints = umlNode('short-p', {
    label: 'Pipeline',
    node_kind: 'component',
    points: ['entry: ready'],
  });
  const longWithPoints = umlNode('long-p', {
    label: 'ToolInvocationMiddleware (choke point)',
    node_kind: 'component',
    points: ['entry: ready'],
  });
  assert.ok(
    umlCardHeight(longWithPoints) > umlCardHeight(shortWithPoints),
    'the label-height reservation still applies once a node also carries points',
  );
});

test('umlCardHeight reserves extra height for the stereotype line once the header exceeds the base height', () => {
  // Long enough that the header clears UML_NODE_BASE_HEIGHT even without a stereotype
  // line, so the stereotype's contribution is observable rather than hidden by the floor.
  const label = 'ToolInvocationMiddleware pipeline choke point handler';
  const stateNode = umlNode('state', { label, node_kind: 'state' });
  const componentNode = umlNode('component', { label, node_kind: 'component' });

  assert.ok(UML_STEREOTYPE_KINDS.includes('component'));
  const stateHeight = umlCardHeight(stateNode);
  assert.ok(stateHeight > UML_NODE_BASE_HEIGHT, 'the label alone must already clear the base-height floor');
  assert.ok(
    umlCardHeight(componentNode) > stateHeight,
    'a stereotype kind reserves more height than a plain state with the same label and points',
  );
});

test('buildUmlElkGraph requests centred edge-label placement on the root graph and container nodes', () => {
  const content = umlContent({
    containers: [{ id: 'box', parent_id: null }],
    nodes: [umlNode('a', { label: 'A', container_id: 'box' }), umlNode('b', { label: 'B' })],
    edges: [umlEdge('e1', 'a', 'b', 'flows to')],
  });

  const graph = buildUmlElkGraph(content);
  const container = graph.children.find(child => child.id === 'box');

  assert.equal(graph.layoutOptions['elk.edgeLabels.placement'], 'CENTER');
  assert.equal(container.layoutOptions['elk.edgeLabels.placement'], 'CENTER');
});
