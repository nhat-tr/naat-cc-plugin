'use strict';

const ARCHITECTURE_NODE_WIDTH = 156;
const ARCHITECTURE_NODE_HEIGHT = 68;
const ARCHITECTURE_GRAPH_ROOT_ID = 'architecture:union';
const COMPACT_GRAPH_EDGE_THRESHOLD = 80;
const PORT_SIZE = 8;

function architectureNodeHeight(node) {
  return ARCHITECTURE_NODE_HEIGHT + (Array.isArray(node.points) ? node.points.length * 24 : 0);
}

const ROUTE_SPACING_OPTIONS = {
  'elk.spacing.edgeEdge': '18',
  'elk.spacing.edgeNode': '24',
  'elk.layered.spacing.edgeEdgeBetweenLayers': '18',
  'elk.layered.spacing.edgeNodeBetweenLayers': '24',
};

function portId(nodeId, id) {
  return `${nodeId}:${id}`;
}

function activeEdges(content, mode) {
  return content.edges.filter(edge => edge.modes.includes(mode));
}

function defaultArchitecturePresentationScope(content) {
  return activeEdges(content, content.initial_mode).length > COMPACT_GRAPH_EDGE_THRESHOLD
    && content.scenarios.length > 0
    ? 'scenario'
    : 'all';
}

function architectureScenarioPresentation(content, mode, scenario) {
  const path = scenario?.paths?.[mode] ?? { edge_ids: [], node_ids: [] };
  const edgeIds = new Set(path.edge_ids);
  const nodeIds = new Set(path.node_ids);
  const boundaryById = new Map(content.ownership_boundaries.map(boundary => [boundary.id, boundary]));
  const boundaryIds = new Set();
  for (const node of content.nodes) {
    if (!nodeIds.has(node.id)) continue;
    let boundaryId = node.owner_id;
    while (boundaryId) {
      boundaryIds.add(boundaryId);
      boundaryId = boundaryById.get(boundaryId)?.parent_id ?? null;
    }
  }
  return {
    content: {
      ...content,
      ownership_boundaries: content.ownership_boundaries
        .filter(boundary => boundaryIds.has(boundary.id)),
      nodes: content.nodes.filter(node => nodeIds.has(node.id)),
      edges: content.edges.filter(edge => edgeIds.has(edge.id)),
    },
    edgeIds,
    nodeIds,
  };
}

function buildArchitectureElkGraph(content) {
  const boundaryNodes = new Map();
  for (const boundary of content.ownership_boundaries) {
    boundaryNodes.set(boundary.id, {
      id: boundary.id,
      children: [],
      layoutOptions: {
        'elk.algorithm': content.layout.algorithm,
        'elk.direction': content.layout.direction,
        'elk.edgeRouting': 'ORTHOGONAL',
        'elk.padding': '[top=54,left=24,bottom=24,right=24]',
        'elk.spacing.nodeNode': '30',
        'elk.layered.spacing.nodeNodeBetweenLayers': '52',
        ...ROUTE_SPACING_OPTIONS,
      },
    });
  }

  for (const boundary of content.ownership_boundaries) {
    if (!boundary.parent_id) continue;
    boundaryNodes.get(boundary.parent_id)?.children?.push(boundaryNodes.get(boundary.id));
  }

  const orderedNodes = [...content.nodes].sort((left, right) => (
    left.layout_hint.layer - right.layout_hint.layer
    || left.layout_hint.order - right.layout_hint.order
    || left.id.localeCompare(right.id)
  ));
  for (const node of orderedNodes) {
    boundaryNodes.get(node.owner_id)?.children?.push({
      id: node.id,
      width: ARCHITECTURE_NODE_WIDTH,
      height: architectureNodeHeight(node),
      layoutOptions: {
        'elk.portConstraints': 'FIXED_SIDE',
      },
      ports: node.ports.map(port => ({
        id: portId(node.id, port.id),
        width: PORT_SIZE,
        height: PORT_SIZE,
        layoutOptions: {
          'elk.port.side': port.direction === 'input' ? 'WEST' : 'EAST',
        },
      })),
    });
  }

  return {
    id: ARCHITECTURE_GRAPH_ROOT_ID,
    children: content.ownership_boundaries
      .filter(boundary => boundary.parent_id === null)
      .map(boundary => boundaryNodes.get(boundary.id)),
    edges: content.edges.map(edge => ({
      id: edge.id,
      sources: [portId(edge.source.node_id, edge.source.port_id)],
      targets: [portId(edge.target.node_id, edge.target.port_id)],
    })),
    layoutOptions: {
      'elk.algorithm': content.layout.algorithm,
      'elk.direction': content.layout.direction,
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.padding': '[top=12,left=12,bottom=12,right=12]',
      'elk.spacing.nodeNode': '56',
      'elk.layered.spacing.nodeNodeBetweenLayers': '96',
      ...ROUTE_SPACING_OPTIONS,
    },
  };
}

module.exports = {
  ARCHITECTURE_NODE_HEIGHT,
  ARCHITECTURE_NODE_WIDTH,
  architectureScenarioPresentation,
  architectureNodeHeight,
  buildArchitectureElkGraph,
  defaultArchitecturePresentationScope,
};
