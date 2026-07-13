import ELK, {
  type ElkExtendedEdge,
  type ElkNode,
  type ElkPoint,
} from "elkjs/lib/elk-api.js";

export type ArchitectureMode = "current" | "proposed";
export type ArchitectureNodeType =
  | "adapter"
  | "artifact"
  | "data_store"
  | "external_system"
  | "interface"
  | "service"
  | "worker";
export type ArchitectureEdgeType = "command" | "control" | "data" | "event" | "evidence";
export type ArchitectureChange = "added" | "modified" | "removed" | "unchanged";

export interface ArchitecturePort {
  id: string;
  label: string;
  direction: "input" | "output";
  kind: string;
  protocol: string;
}

export interface ArchitectureNode {
  id: string;
  component_id: string;
  type: ArchitectureNodeType;
  label: string;
  owner_id: string;
  layout_hint: { layer: number; order: number };
  ports: ArchitecturePort[];
  modes: ArchitectureMode[];
  change: ArchitectureChange;
}

export interface ArchitectureEdge {
  id: string;
  component_id: string;
  type: ArchitectureEdgeType;
  source: { node_id: string; port_id: string };
  target: { node_id: string; port_id: string };
  modes: ArchitectureMode[];
}

export interface OwnershipBoundary {
  id: string;
  component_id: string;
  label: string;
  parent_id: string | null;
}

export interface ScenarioPath {
  node_ids: string[];
  edge_ids: string[];
}

export interface ArchitectureScenario {
  id: string;
  component_id: string;
  label: string;
  description: string;
  paths: Record<ArchitectureMode, ScenarioPath>;
}

export interface ArchitectureWorkspaceContent {
  layout_direction: {
    id: string;
    comparison: "exclusive_view_modes";
    evidence_ref: string;
  };
  layout: {
    contract_version: number;
    engine: "elk";
    algorithm: "layered";
    direction: "RIGHT";
    stable_across_modes: true;
  };
  initial_mode: ArchitectureMode;
  ownership_boundaries: OwnershipBoundary[];
  nodes: ArchitectureNode[];
  edges: ArchitectureEdge[];
  scenarios: ArchitectureScenario[];
  camera: {
    min_zoom: number;
    max_zoom: number;
    default_zoom: number;
    fit_padding: number;
    controls: string[];
  };
  focus_targets: string[];
  annotation_targets: string[];
}

export interface LayoutBoundary {
  boundary: OwnershipBoundary;
  position: ElkPoint;
  width: number;
  height: number;
}

export interface LayoutArchitectureNode {
  node: ArchitectureNode;
  position: ElkPoint;
  absolutePosition: ElkPoint;
  width: number;
  height: number;
}

export interface LayoutArchitectureEdge {
  edge: ArchitectureEdge;
  path: string;
  points: ElkPoint[];
}

export interface ArchitectureLayoutResult {
  boundaries: LayoutBoundary[];
  nodes: LayoutArchitectureNode[];
  edges: LayoutArchitectureEdge[];
  width: number;
  height: number;
}

const NODE_WIDTH = 156;
const NODE_HEIGHT = 68;
const PORT_SIZE = 8;

function portId(nodeId: string, id: string): string {
  return `${nodeId}:${id}`;
}

function finite(value: number | undefined, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function buildElkGraph(content: ArchitectureWorkspaceContent): ElkNode {
  const boundaryNodes = new Map<string, ElkNode>();
  for (const boundary of content.ownership_boundaries) {
    boundaryNodes.set(boundary.id, {
      id: boundary.id,
      children: [],
      layoutOptions: {
        "elk.algorithm": content.layout.algorithm,
        "elk.direction": content.layout.direction,
        "elk.edgeRouting": "ORTHOGONAL",
        "elk.padding": "[top=54,left=24,bottom=24,right=24]",
        "elk.spacing.nodeNode": "30",
        "elk.layered.spacing.nodeNodeBetweenLayers": "52",
      },
    });
  }

  for (const boundary of content.ownership_boundaries) {
    if (!boundary.parent_id) continue;
    boundaryNodes.get(boundary.parent_id)?.children?.push(boundaryNodes.get(boundary.id)!);
  }

  const orderedNodes = [...content.nodes].sort((left, right) => (
    left.layout_hint.layer - right.layout_hint.layer
    || left.layout_hint.order - right.layout_hint.order
    || left.id.localeCompare(right.id)
  ));
  for (const node of orderedNodes) {
    boundaryNodes.get(node.owner_id)?.children?.push({
      id: node.id,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      layoutOptions: {
        "elk.portConstraints": "FIXED_SIDE",
      },
      ports: node.ports.map(port => ({
        id: portId(node.id, port.id),
        width: PORT_SIZE,
        height: PORT_SIZE,
        layoutOptions: {
          "elk.port.side": port.direction === "input" ? "WEST" : "EAST",
        },
      })),
    });
  }

  return {
    id: "architecture-union",
    children: content.ownership_boundaries
      .filter(boundary => boundary.parent_id === null)
      .map(boundary => boundaryNodes.get(boundary.id)!),
    edges: content.edges.map(edge => ({
      id: edge.id,
      sources: [portId(edge.source.node_id, edge.source.port_id)],
      targets: [portId(edge.target.node_id, edge.target.port_id)],
    })),
    layoutOptions: {
      "elk.algorithm": content.layout.algorithm,
      "elk.direction": content.layout.direction,
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.padding": "[top=12,left=12,bottom=12,right=12]",
      "elk.spacing.nodeNode": "56",
      "elk.layered.spacing.nodeNodeBetweenLayers": "96",
    },
  };
}

function routePath(points: ElkPoint[]): string {
  return points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");
}

function collectEdges(node: ElkNode, destination: ElkExtendedEdge[]): void {
  if (node.edges) destination.push(...node.edges);
  for (const child of node.children ?? []) collectEdges(child, destination);
}

function mapLayout(content: ArchitectureWorkspaceContent, graph: ElkNode): ArchitectureLayoutResult {
  const boundaryById = new Map(content.ownership_boundaries.map(boundary => [boundary.id, boundary]));
  const nodeById = new Map(content.nodes.map(node => [node.id, node]));
  const absoluteOrigins = new Map<string, ElkPoint>([[graph.id, { x: 0, y: 0 }]]);
  const boundaries: LayoutBoundary[] = [];
  const nodes: LayoutArchitectureNode[] = [];

  const visit = (child: ElkNode, parentOrigin: ElkPoint): void => {
    const position = { x: finite(child.x), y: finite(child.y) };
    const absolutePosition = {
      x: parentOrigin.x + position.x,
      y: parentOrigin.y + position.y,
    };
    absoluteOrigins.set(child.id, absolutePosition);
    const boundary = boundaryById.get(child.id);
    if (boundary) {
      boundaries.push({
        boundary,
        position,
        width: finite(child.width, 1),
        height: finite(child.height, 1),
      });
    } else {
      const node = nodeById.get(child.id);
      if (node) {
        nodes.push({
          node,
          position,
          absolutePosition,
          width: finite(child.width, NODE_WIDTH),
          height: finite(child.height, NODE_HEIGHT),
        });
      }
    }
    for (const nested of child.children ?? []) visit(nested, absolutePosition);
  };

  for (const child of graph.children ?? []) visit(child, { x: 0, y: 0 });

  const layoutEdges: ElkExtendedEdge[] = [];
  collectEdges(graph, layoutEdges);
  const layoutEdgeById = new Map(layoutEdges.map(edge => [edge.id, edge]));
  const positionedNodeById = new Map(nodes.map(item => [item.node.id, item]));
  const edges = content.edges.map(edge => {
    const layoutEdge = layoutEdgeById.get(edge.id);
    const containerOrigin = absoluteOrigins.get(layoutEdge?.container ?? graph.id) ?? { x: 0, y: 0 };
    const section = layoutEdge?.sections?.[0];
    let points = section
      ? [section.startPoint, ...(section.bendPoints ?? []), section.endPoint].map(point => ({
        x: point.x + containerOrigin.x,
        y: point.y + containerOrigin.y,
      }))
      : [];
    if (points.length < 2) {
      const source = positionedNodeById.get(edge.source.node_id);
      const target = positionedNodeById.get(edge.target.node_id);
      if (source && target) {
        const start = {
          x: source.absolutePosition.x + source.width,
          y: source.absolutePosition.y + source.height / 2,
        };
        const end = {
          x: target.absolutePosition.x,
          y: target.absolutePosition.y + target.height / 2,
        };
        const midpoint = (start.x + end.x) / 2;
        points = [start, { x: midpoint, y: start.y }, { x: midpoint, y: end.y }, end];
      }
    }
    return { edge, points, path: routePath(points) };
  });

  return {
    boundaries,
    nodes,
    edges,
    width: finite(graph.width, 1),
    height: finite(graph.height, 1),
  };
}

export async function layoutArchitecture(
  content: ArchitectureWorkspaceContent,
): Promise<ArchitectureLayoutResult> {
  const workerUrl = window.__BRAINSTORM_ELK_WORKER_URL_PROMISE__
    ? await window.__BRAINSTORM_ELK_WORKER_URL_PROMISE__
    : `${document.body.dataset.basePath || "/"}assets/elk-worker.min.js`;
  const elk = new ELK({ workerUrl });
  try {
    const graph = await elk.layout(buildElkGraph(content));
    return mapLayout(content, graph);
  } finally {
    elk.terminateWorker();
  }
}

declare global {
  interface Window {
    __BRAINSTORM_ELK_WORKER_URL_PROMISE__?: Promise<string>;
  }
}
