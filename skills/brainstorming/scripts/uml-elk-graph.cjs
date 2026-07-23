'use strict';

// ELK graph builder for the UML graph diagram family (component | state_machine |
// activity). Unlike architecture, UML edges attach node-to-node (no ports) and the
// node vocabulary carries fixed-size pseudostate/control shapes (initial, final,
// decision, fork/join, ...) alongside label-sized cards. Sizing constants are shared
// with the frontend (uml-layout.ts imports this module) so the height ELK reserves for
// a card matches the height the browser renders — the same contract architecture uses.

const UML_NODE_WIDTH = 168;
const UML_NODE_BASE_HEIGHT = 56;
const UML_GRAPH_ROOT_ID = 'uml:root';

// Point-list metrics mirror `.uml-node-points` in uml.css so reserved height matches
// rendered height. A point that wraps to several lines needs room for every line.
const POINT_LINE_HEIGHT = 13; // 0.625rem text * 1.3 line-height, in px
const POINT_ROW_GAP = 3;
const POINT_BLOCK_PADDING = 6;
// Characters that fit on one wrapped line inside the point column (~124px usable).
const POINT_CHARS_PER_LINE = 18;

// Fixed geometry for pseudostate / control nodes that never grow with their label.
const PSEUDOSTATE_SIZES = Object.freeze({
  initial: { width: 26, height: 26 },
  final: { width: 30, height: 30 },
  flow_final: { width: 28, height: 28 },
  history: { width: 30, height: 30 },
  terminate: { width: 30, height: 30 },
  choice: { width: 48, height: 48 },
  junction: { width: 20, height: 20 },
  decision: { width: 52, height: 44 },
  merge: { width: 52, height: 44 },
});

const ROUTE_SPACING_OPTIONS = {
  'elk.spacing.edgeEdge': '18',
  'elk.spacing.edgeNode': '24',
  'elk.layered.spacing.edgeEdgeBetweenLayers': '18',
  'elk.layered.spacing.edgeNodeBetweenLayers': '24',
};

function pointLineCount(point) {
  const length = typeof point === 'string' ? point.trim().length : 0;
  return Math.max(1, Math.ceil(length / POINT_CHARS_PER_LINE));
}

function umlCardHeight(node) {
  const points = Array.isArray(node.points) ? node.points : [];
  if (points.length === 0) return UML_NODE_BASE_HEIGHT;
  const pointsHeight = points.reduce(
    (total, point) => total + pointLineCount(point) * POINT_LINE_HEIGHT + POINT_ROW_GAP,
    0,
  );
  return UML_NODE_BASE_HEIGHT + pointsHeight + POINT_BLOCK_PADDING;
}

// A fork/join bar is drawn perpendicular to the flow direction.
function forkJoinSize(direction) {
  return direction === 'DOWN'
    ? { width: 84, height: 14 }
    : { width: 14, height: 84 };
}

function umlNodeSize(node, direction) {
  if (node.node_kind === 'fork' || node.node_kind === 'join') return forkJoinSize(direction);
  const pseudostate = PSEUDOSTATE_SIZES[node.node_kind];
  if (pseudostate) return { width: pseudostate.width, height: pseudostate.height };
  return { width: UML_NODE_WIDTH, height: umlCardHeight(node) };
}

function containerLayoutOptions(content) {
  return {
    'elk.algorithm': content.layout.algorithm,
    'elk.direction': content.layout.direction,
    'elk.edgeRouting': 'ORTHOGONAL',
    'elk.padding': '[top=48,left=22,bottom=22,right=22]',
    'elk.spacing.nodeNode': '28',
    'elk.layered.spacing.nodeNodeBetweenLayers': '48',
    ...ROUTE_SPACING_OPTIONS,
  };
}

function buildUmlElkGraph(content) {
  const direction = content.layout.direction;
  const containers = Array.isArray(content.containers) ? content.containers : [];
  const containerNodes = new Map();
  for (const container of containers) {
    containerNodes.set(container.id, {
      id: container.id,
      children: [],
      layoutOptions: containerLayoutOptions(content),
    });
  }

  const rootChildren = [];
  for (const container of containers) {
    const elkContainer = containerNodes.get(container.id);
    const parent = container.parent_id ? containerNodes.get(container.parent_id) : null;
    if (parent) parent.children.push(elkContainer);
    else rootChildren.push(elkContainer);
  }

  const orderedNodes = [...content.nodes].sort((left, right) => (
    left.layout_hint.layer - right.layout_hint.layer
    || left.layout_hint.order - right.layout_hint.order
    || left.id.localeCompare(right.id)
  ));
  for (const node of orderedNodes) {
    const size = umlNodeSize(node, direction);
    const elkNode = { id: node.id, width: size.width, height: size.height };
    const owner = node.container_id ? containerNodes.get(node.container_id) : null;
    if (owner) owner.children.push(elkNode);
    else rootChildren.push(elkNode);
  }

  return {
    id: UML_GRAPH_ROOT_ID,
    children: rootChildren,
    edges: content.edges.map(edge => ({
      id: edge.id,
      sources: [edge.source],
      targets: [edge.target],
    })),
    layoutOptions: {
      'elk.algorithm': content.layout.algorithm,
      'elk.direction': direction,
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.padding': '[top=12,left=12,bottom=12,right=12]',
      'elk.spacing.nodeNode': '52',
      'elk.layered.spacing.nodeNodeBetweenLayers': '84',
      ...ROUTE_SPACING_OPTIONS,
    },
  };
}

module.exports = {
  UML_NODE_WIDTH,
  UML_NODE_BASE_HEIGHT,
  UML_GRAPH_ROOT_ID,
  umlCardHeight,
  umlNodeSize,
  buildUmlElkGraph,
};
