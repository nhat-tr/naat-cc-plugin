import ELK, {
  type ElkExtendedEdge,
  type ElkNode,
  type ElkPoint,
} from "elkjs/lib/elk-api.js";
import architectureElkGraph from "../../../scripts/architecture-elk-graph.cjs";

const {
  ARCHITECTURE_NODE_HEIGHT: NODE_HEIGHT,
  ARCHITECTURE_NODE_WIDTH: NODE_WIDTH,
  architectureNodeHeight,
  buildArchitectureElkGraph,
} = architectureElkGraph;

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
  points?: string[];
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

export interface ArchitectureBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ArchitectureLayoutResult {
  boundaries: LayoutBoundary[];
  nodes: LayoutArchitectureNode[];
  edges: LayoutArchitectureEdge[];
  width: number;
  height: number;
}

function finite(value: number | undefined, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function routePath(points: ElkPoint[]): string {
  return points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");
}

function collectEdges(node: ElkNode, destination: ElkExtendedEdge[]): void {
  if (node.edges) destination.push(...node.edges);
  for (const child of node.children ?? []) collectEdges(child, destination);
}

// Input ports sit on a node's left edge and output ports on its right, both at mid-height,
// so an edge leaves the source's output side and enters the target's input side. Used both
// as the fallback for an edge ELK left unrouted and as the live route for a dragged node.
function routeArchitectureEdge(source: ArchitectureBox, target: ArchitectureBox): ElkPoint[] {
  const forward = target.x + target.width / 2 >= source.x + source.width / 2;
  const start = {
    x: forward ? source.x + source.width : source.x,
    y: source.y + source.height / 2,
  };
  const end = {
    x: forward ? target.x : target.x + target.width,
    y: target.y + target.height / 2,
  };
  if (Math.abs(start.y - end.y) < 1) return [start, { x: end.x, y: start.y }];
  const bend = (start.x + end.x) / 2;
  return [start, { x: bend, y: start.y }, { x: bend, y: end.y }, end];
}

export function manualArchitectureEdgeGeometry(
  source: ArchitectureBox,
  target: ArchitectureBox,
): { path: string; points: ElkPoint[] } {
  const points = routeArchitectureEdge(source, target);
  return { path: routePath(points), points };
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
          height: finite(child.height, architectureNodeHeight(node)),
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
        points = routeArchitectureEdge(
          { ...source.absolutePosition, width: source.width, height: source.height },
          { ...target.absolutePosition, width: target.width, height: target.height },
        );
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
    const graph = await elk.layout(buildArchitectureElkGraph(content));
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
