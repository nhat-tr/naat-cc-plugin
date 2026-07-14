import type {
  ArchitectureEdge,
  ArchitectureMode,
  ArchitectureScenario,
  ArchitectureWorkspaceContent,
  OwnershipBoundary,
  ScenarioPath,
} from "./architecture-layout";
import architectureElkGraph from "../../../scripts/architecture-elk-graph.cjs";

const {
  architectureScenarioPresentation,
  defaultArchitecturePresentationScope: defaultPresentationScope,
} = architectureElkGraph;

export type ArchitecturePresentationScope = "all" | "scenario" | "selected";

export interface ArchitecturePresentation {
  content: ArchitectureWorkspaceContent;
  edgeIds: Set<string>;
  nodeIds: Set<string>;
}

function activeEdges(content: ArchitectureWorkspaceContent, mode: ArchitectureMode): ArchitectureEdge[] {
  return content.edges.filter(edge => edge.modes.includes(mode));
}

function boundaryContains(
  candidateId: string,
  selectedId: string,
  boundaryById: Map<string, OwnershipBoundary>,
): boolean {
  let current: string | null = candidateId;
  while (current) {
    if (current === selectedId) return true;
    current = boundaryById.get(current)?.parent_id ?? null;
  }
  return false;
}

function requiredBoundaryIds(
  content: ArchitectureWorkspaceContent,
  nodeIds: Set<string>,
): Set<string> {
  const boundaryById = new Map(content.ownership_boundaries.map(boundary => [boundary.id, boundary]));
  const result = new Set<string>();
  for (const node of content.nodes) {
    if (!nodeIds.has(node.id)) continue;
    let boundaryId: string | null = node.owner_id;
    while (boundaryId) {
      result.add(boundaryId);
      boundaryId = boundaryById.get(boundaryId)?.parent_id ?? null;
    }
  }
  return result;
}

function selectedGraph(
  content: ArchitectureWorkspaceContent,
  mode: ArchitectureMode,
  focusedId: string | null,
  scenarioPath: ScenarioPath | null,
): { edgeIds: Set<string>; nodeIds: Set<string> } {
  const nodes = content.nodes.filter(node => node.modes.includes(mode));
  const nodeIds = new Set(nodes.map(node => node.id));
  const edges = activeEdges(content, mode).filter(edge => (
    nodeIds.has(edge.source.node_id) && nodeIds.has(edge.target.node_id)
  ));
  const focusedNode = focusedId && nodeIds.has(focusedId) ? focusedId : null;
  const focusedEdge = focusedId ? edges.find(edge => edge.id === focusedId) : undefined;
  const boundaryById = new Map(content.ownership_boundaries.map(boundary => [boundary.id, boundary]));
  const focusedBoundary = focusedId ? boundaryById.get(focusedId) : undefined;

  if (focusedEdge) {
    return {
      edgeIds: new Set([focusedEdge.id]),
      nodeIds: new Set([focusedEdge.source.node_id, focusedEdge.target.node_id]),
    };
  }

  if (focusedBoundary) {
    const selectedNodeIds = new Set(nodes
      .filter(node => boundaryContains(node.owner_id, focusedBoundary.id, boundaryById))
      .map(node => node.id));
    return {
      edgeIds: new Set(edges
        .filter(edge => selectedNodeIds.has(edge.source.node_id) && selectedNodeIds.has(edge.target.node_id))
        .map(edge => edge.id)),
      nodeIds: selectedNodeIds,
    };
  }

  const selectedNodeId = focusedNode
    ?? content.focus_targets.find(id => nodeIds.has(id))
    ?? scenarioPath?.node_ids.find(id => nodeIds.has(id))
    ?? nodes[0]?.id
    ?? null;
  if (!selectedNodeId) return { edgeIds: new Set(), nodeIds: new Set() };

  const incidentEdges = edges.filter(edge => (
    edge.source.node_id === selectedNodeId || edge.target.node_id === selectedNodeId
  ));
  return {
    edgeIds: new Set(incidentEdges.map(edge => edge.id)),
    nodeIds: new Set([
      selectedNodeId,
      ...incidentEdges.flatMap(edge => [edge.source.node_id, edge.target.node_id]),
    ]),
  };
}

export function defaultArchitecturePresentationScope(
  content: ArchitectureWorkspaceContent,
): ArchitecturePresentationScope {
  return defaultPresentationScope(content);
}

export function architecturePresentation(
  content: ArchitectureWorkspaceContent,
  mode: ArchitectureMode,
  scope: ArchitecturePresentationScope,
  scenario: ArchitectureScenario | null,
  focusedId: string | null,
): ArchitecturePresentation {
  const scenarioPath = scenario?.paths[mode] ?? null;
  if (scope === "all") {
    return {
      content,
      edgeIds: new Set(activeEdges(content, mode).map(edge => edge.id)),
      nodeIds: new Set(content.nodes.filter(node => node.modes.includes(mode)).map(node => node.id)),
    };
  }

  if (scope === "scenario") {
    return architectureScenarioPresentation(content, mode, scenario);
  }

  const selected = selectedGraph(content, mode, focusedId, scenarioPath);
  const boundaryIds = requiredBoundaryIds(content, selected.nodeIds);
  return {
    content: {
      ...content,
      ownership_boundaries: content.ownership_boundaries.filter(boundary => boundaryIds.has(boundary.id)),
      nodes: content.nodes.filter(node => selected.nodeIds.has(node.id)),
      edges: content.edges.filter(edge => selected.edgeIds.has(edge.id)),
    },
    edgeIds: selected.edgeIds,
    nodeIds: selected.nodeIds,
  };
}
