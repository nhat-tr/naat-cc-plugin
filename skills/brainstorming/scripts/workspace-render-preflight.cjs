'use strict';

const ELK = require('elkjs/lib/elk.bundled.js');

const {
  architectureScenarioPresentation,
  buildArchitectureElkGraph,
  defaultArchitecturePresentationScope,
} = require('./architecture-elk-graph.cjs');

function finitePositive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function collectLayoutNodes(node, destination) {
  for (const child of node.children || []) {
    destination.set(child.id, child);
    collectLayoutNodes(child, destination);
  }
}

async function defaultLayout(graph) {
  const elk = new ELK();
  return elk.layout(graph);
}

function contentForMode(content, mode) {
  const nodes = content.nodes.filter(node => node.modes.includes(mode));
  const nodeIds = new Set(nodes.map(node => node.id));
  const boundaryById = new Map(content.ownership_boundaries.map(boundary => [boundary.id, boundary]));
  const boundaryIds = new Set();
  for (const node of nodes) {
    let ownerId = node.owner_id;
    while (ownerId && !boundaryIds.has(ownerId)) {
      boundaryIds.add(ownerId);
      ownerId = boundaryById.get(ownerId)?.parent_id ?? null;
    }
  }
  return {
    ...content,
    ownership_boundaries: content.ownership_boundaries.filter(boundary => boundaryIds.has(boundary.id)),
    nodes,
    edges: content.edges.filter(edge => (
      edge.modes.includes(mode)
      && nodeIds.has(edge.source.node_id)
      && nodeIds.has(edge.target.node_id)
    )),
  };
}

async function preflightScope(content, scopeId, layoutGraph) {
  if (content.nodes.length === 0) {
    return {
      id: scopeId,
      status: 'not_applicable',
      width: 0,
      height: 0,
      node_count: 0,
      edge_count: 0,
    };
  }
  try {
    const graph = buildArchitectureElkGraph(content);
    const layout = await layoutGraph(graph);
    if (!finitePositive(layout.width) || !finitePositive(layout.height)) {
      throw new Error('ELK returned blank canvas dimensions');
    }

    const layoutNodes = new Map();
    collectLayoutNodes(layout, layoutNodes);
    for (const node of content.nodes) {
      const geometry = layoutNodes.get(node.id);
      if (!geometry
        || !Number.isFinite(geometry.x)
        || !Number.isFinite(geometry.y)
        || !finitePositive(geometry.width)
        || !finitePositive(geometry.height)) {
        throw new Error(`ELK omitted finite geometry for node ${node.id}`);
      }
    }

    return {
      id: scopeId,
      status: 'ready',
      width: layout.width,
      height: layout.height,
      node_count: content.nodes.length,
      edge_count: content.edges.length,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Architecture render preflight failed: ${scopeId}: ${message}`, { cause: error });
  }
}

async function preflightArchitectureContent(content, options = {}) {
  const layoutGraph = options.layout || defaultLayout;
  const initialScope = defaultArchitecturePresentationScope(content);
  const initialContent = initialScope === 'scenario'
    ? architectureScenarioPresentation(
      content,
      content.initial_mode,
      content.scenarios[0] ?? null,
    ).content
    : content;
  const scopes = [];
  for (const [id, scopeContent] of [
    [`initial_${initialScope}`, initialContent],
    ['union', content],
    ['current', contentForMode(content, 'current')],
    ['proposed', contentForMode(content, 'proposed')],
  ]) {
    scopes.push(await preflightScope(scopeContent, id, layoutGraph));
  }
  const union = scopes.find(scope => scope.id === 'union');
  return {
    status: 'ready',
    workspace_kind: 'architecture',
    width: union.width,
    height: union.height,
    node_count: content.nodes.length,
    edge_count: content.edges.length,
    scopes,
  };
}

async function preflightWorkspaceDocument(document, options = {}) {
  if (document?.version !== 2 || document.workspace_kind !== 'architecture') {
    return {
      status: 'not_applicable',
      workspace_kind: document?.version === 2 ? document.workspace_kind : null,
    };
  }
  return preflightArchitectureContent(document.content, options);
}

module.exports = {
  preflightArchitectureContent,
  preflightWorkspaceDocument,
};
