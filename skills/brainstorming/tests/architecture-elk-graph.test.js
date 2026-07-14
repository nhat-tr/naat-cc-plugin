'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const ELK = require('elkjs/lib/elk.bundled.js');
const {
  buildArchitectureElkGraph,
} = require('../scripts/architecture-elk-graph.cjs');

function architectureNode(id, layer, order, ports) {
  return {
    id,
    component_id: id,
    type: 'service',
    label: id,
    owner_id: 'runtime-boundary',
    layout_hint: { layer, order },
    ports: ports.map(([portId, direction]) => ({
      id: portId,
      label: portId,
      direction,
      kind: 'control',
      protocol: 'in-proc',
    })),
    modes: ['current', 'proposed'],
    change: 'unchanged',
  };
}

function architectureEdge(id, sourceNode, sourcePort, targetNode, targetPort) {
  return {
    id,
    component_id: id,
    type: 'control',
    source: { node_id: sourceNode, port_id: sourcePort },
    target: { node_id: targetNode, port_id: targetPort },
    modes: ['current', 'proposed'],
  };
}

function forkJoinContent() {
  return {
    layout_direction: {
      id: 'exclusive-view-modes',
      comparison: 'exclusive_view_modes',
      evidence_ref: 'EVD-fork-join',
    },
    layout: {
      contract_version: 1,
      engine: 'elk',
      algorithm: 'layered',
      direction: 'RIGHT',
      stable_across_modes: true,
    },
    initial_mode: 'proposed',
    ownership_boundaries: [{
      id: 'runtime-boundary',
      component_id: 'runtime-boundary',
      label: 'Runtime',
      parent_id: null,
    }],
    nodes: [
      architectureNode('start', 0, 0, [['out', 'output']]),
      architectureNode('fork', 1, 0, [['in', 'input'], ['out', 'output']]),
      architectureNode('left', 2, 0, [['in', 'input'], ['out', 'output']]),
      architectureNode('right', 2, 1, [['in', 'input'], ['out', 'output']]),
      architectureNode('join', 3, 0, [['in', 'input'], ['out', 'output']]),
      architectureNode('end', 4, 0, [['in', 'input']]),
    ],
    edges: [
      architectureEdge('start-fork', 'start', 'out', 'fork', 'in'),
      architectureEdge('fork-left', 'fork', 'out', 'left', 'in'),
      architectureEdge('fork-right', 'fork', 'out', 'right', 'in'),
      architectureEdge('left-join', 'left', 'out', 'join', 'in'),
      architectureEdge('right-join', 'right', 'out', 'join', 'in'),
      architectureEdge('join-end', 'join', 'out', 'end', 'in'),
    ],
    scenarios: [],
    camera: {
      min_zoom: 0.2,
      max_zoom: 2,
      default_zoom: 1,
      fit_padding: 0.15,
      controls: ['pan', 'zoom_in', 'zoom_out', 'fit_view', 'minimap'],
    },
    focus_targets: [],
    annotation_targets: [],
  };
}

test('compound ownership boundary fork/join graph produces a nonblank ELK layout', async () => {
  const elk = new ELK();

  const graph = buildArchitectureElkGraph(forkJoinContent());
  assert.equal(
    graph.children[0].layoutOptions['elk.layered.considerModelOrder.strategy'],
    undefined,
    'compound ownership boundaries must not enable the crashing model-order strategy',
  );

  const result = await elk.layout(graph);
  assert.ok(result.width > 0, 'layout has a nonzero width');
  assert.ok(result.height > 0, 'layout has a nonzero height');
  assert.equal(result.children[0].children.length, 6, 'all architecture nodes are laid out');
  assert.ok(
    result.children[0].children.every(node => Number.isFinite(node.x) && Number.isFinite(node.y)),
    'every architecture node receives finite geometry',
  );
});

test('ELK root identity cannot collide with an authored Architecture topology identity', () => {
  const content = forkJoinContent();
  content.ownership_boundaries[0].id = 'architecture-union';
  for (const node of content.nodes) node.owner_id = 'architecture-union';

  const graph = buildArchitectureElkGraph(content);

  assert.notEqual(graph.id, 'architecture-union');
  assert.ok(graph.id.includes(':'), 'ELK root must live outside authored identifier syntax');
  assert.equal(graph.children[0].id, 'architecture-union');
});
