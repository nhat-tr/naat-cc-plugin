import ELK, {
  type ElkExtendedEdge,
  type ElkNode,
  type ElkPoint,
} from "elkjs/lib/elk-api.js";
import umlElkGraph from "../../../scripts/uml-elk-graph.cjs";

const {
  UML_NODE_WIDTH: NODE_WIDTH,
  umlNodeSize,
  buildUmlElkGraph,
} = umlElkGraph;

export type UmlGraphDiagramKind = "component" | "state_machine" | "activity";
export type UmlDiagramKind = UmlGraphDiagramKind | "sequence";

export type UmlNodeKind =
  | "component"
  | "interface"
  | "artifact"
  | "deployment_node"
  | "actor"
  | "use_case"
  | "state"
  | "initial"
  | "final"
  | "flow_final"
  | "choice"
  | "junction"
  | "fork"
  | "join"
  | "terminate"
  | "history"
  | "action"
  | "decision"
  | "merge"
  | "object"
  | "accept_event"
  | "send_signal";

export type UmlRelation =
  | "dependency"
  | "assembly"
  | "delegation"
  | "realization"
  | "association"
  | "generalization"
  | "transition"
  | "control_flow"
  | "object_flow";

export type UmlContainerKind = "package" | "composite_state" | "partition" | "node" | "frame";

export interface UmlContainer {
  id: string;
  component_id: string;
  label: string;
  container_kind: UmlContainerKind;
  parent_id: string | null;
}

export interface UmlGraphNode {
  id: string;
  component_id: string;
  label: string;
  node_kind: UmlNodeKind;
  container_id: string | null;
  points?: string[];
  layout_hint: { layer: number; order: number };
}

export interface UmlGraphEdge {
  id: string;
  component_id: string;
  label?: string;
  relation: UmlRelation;
  source: string;
  target: string;
}

export interface UmlGraphContent {
  diagram_kind: UmlGraphDiagramKind;
  layout: {
    contract_version: number;
    engine: "elk";
    algorithm: "layered";
    direction: "RIGHT" | "DOWN";
  };
  containers: UmlContainer[];
  nodes: UmlGraphNode[];
  edges: UmlGraphEdge[];
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

export type UmlLifelineKind =
  | "actor"
  | "object"
  | "boundary"
  | "control"
  | "entity"
  | "participant"
  | "database";

export type UmlMessageKind = "sync" | "async" | "reply" | "create" | "destroy" | "self";
export type UmlFragmentKind = "alt" | "opt" | "loop" | "par" | "break" | "critical" | "ref";

export interface UmlLifeline {
  id: string;
  component_id: string;
  label: string;
  lifeline_kind: UmlLifelineKind;
  points?: string[];
}

export interface UmlMessage {
  id: string;
  component_id: string;
  label: string;
  message_kind: UmlMessageKind;
  from: string;
  to: string;
  points?: string[];
}

export interface UmlFragment {
  id: string;
  component_id: string;
  label: string;
  fragment_kind: UmlFragmentKind;
  message_ids: string[];
}

export interface UmlSequenceContent {
  diagram_kind: "sequence";
  lifelines: UmlLifeline[];
  messages: UmlMessage[];
  fragments: UmlFragment[];
  annotation_targets: string[];
}

export interface LayoutUmlContainer {
  container: UmlContainer;
  position: ElkPoint;
  width: number;
  height: number;
}

export interface LayoutUmlNode {
  node: UmlGraphNode;
  position: ElkPoint;
  absolutePosition: ElkPoint;
  width: number;
  height: number;
}

export interface LayoutUmlEdge {
  edge: UmlGraphEdge;
  path: string;
  points: ElkPoint[];
  labelPoint: ElkPoint | null;
}

export interface UmlLayoutResult {
  containers: LayoutUmlContainer[];
  nodes: LayoutUmlNode[];
  edges: LayoutUmlEdge[];
  width: number;
  height: number;
}

function finite(value: number | undefined, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function routePath(points: ElkPoint[]): string {
  return points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");
}

function midpoint(points: ElkPoint[]): ElkPoint | null {
  if (points.length === 0) return null;
  if (points.length <= 2) {
    const start = points[0];
    const end = points[points.length - 1];
    if (!start || !end) return null;
    return { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  }
  return points[Math.floor(points.length / 2)] ?? null;
}

function collectEdges(node: ElkNode, destination: ElkExtendedEdge[]): void {
  if (node.edges) destination.push(...node.edges);
  for (const child of node.children ?? []) collectEdges(child, destination);
}

function mapLayout(content: UmlGraphContent, graph: ElkNode): UmlLayoutResult {
  const containerById = new Map(content.containers.map(container => [container.id, container]));
  const nodeById = new Map(content.nodes.map(node => [node.id, node]));
  const absoluteOrigins = new Map<string, ElkPoint>([[graph.id, { x: 0, y: 0 }]]);
  const containers: LayoutUmlContainer[] = [];
  const nodes: LayoutUmlNode[] = [];

  const visit = (child: ElkNode, parentOrigin: ElkPoint): void => {
    const position = { x: finite(child.x), y: finite(child.y) };
    const absolutePosition = {
      x: parentOrigin.x + position.x,
      y: parentOrigin.y + position.y,
    };
    absoluteOrigins.set(child.id, absolutePosition);
    const container = containerById.get(child.id);
    if (container) {
      containers.push({
        container,
        position,
        width: finite(child.width, 1),
        height: finite(child.height, 1),
      });
    } else {
      const node = nodeById.get(child.id);
      if (node) {
        const size = umlNodeSize(node, content.layout.direction);
        nodes.push({
          node,
          position,
          absolutePosition,
          width: finite(child.width, size.width),
          height: finite(child.height, size.height),
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
    let points: ElkPoint[] = section
      ? [section.startPoint, ...(section.bendPoints ?? []), section.endPoint].map(point => ({
        x: point.x + containerOrigin.x,
        y: point.y + containerOrigin.y,
      }))
      : [];
    if (points.length < 2) {
      const source = positionedNodeById.get(edge.source);
      const target = positionedNodeById.get(edge.target);
      if (source && target) {
        const start = {
          x: source.absolutePosition.x + source.width / 2,
          y: source.absolutePosition.y + source.height / 2,
        };
        const end = {
          x: target.absolutePosition.x + target.width / 2,
          y: target.absolutePosition.y + target.height / 2,
        };
        points = [start, end];
      }
    }
    return { edge, points, path: routePath(points), labelPoint: midpoint(points) };
  });

  return {
    containers,
    nodes,
    edges,
    width: finite(graph.width, 1),
    height: finite(graph.height, 1),
  };
}

export async function layoutUml(content: UmlGraphContent): Promise<UmlLayoutResult> {
  const workerUrl = window.__BRAINSTORM_ELK_WORKER_URL_PROMISE__
    ? await window.__BRAINSTORM_ELK_WORKER_URL_PROMISE__
    : `${document.body.dataset.basePath || "/"}assets/elk-worker.min.js`;
  const elk = new ELK({ workerUrl });
  try {
    const graph = await elk.layout(buildUmlElkGraph(content));
    return mapLayout(content, graph);
  } finally {
    elk.terminateWorker();
  }
}

// --- Sequence diagram: deterministic client-side layout (no ELK) ---

const SEQ_TOP = 14;
const SEQ_HEADER_WIDTH = 132;
const SEQ_HEADER_HEIGHT = 46;
const SEQ_COLUMN_GAP = 176;
const SEQ_FIRST_COLUMN_X = 96;
const SEQ_ROW_HEIGHT = 58;
const SEQ_POINT_LINE = 15;
const SEQ_ROW_GAP = 8;
const SEQ_SELF_LOOP = 26;
const SEQ_SIDE_MARGIN = 48;
const SEQ_BOTTOM_MARGIN = 44;
const SEQ_FRAGMENT_PAD = 16;
const SEQ_ACTIVATION_WIDTH = 12;

export interface SequencePointLayout {
  id: string;
  label: string;
  text: string;
  y: number;
}

export interface LayoutSequenceLifeline {
  lifeline: UmlLifeline;
  centerX: number;
  headerTop: number;
  headerHeight: number;
  lineTop: number;
  lineBottom: number;
  points: SequencePointLayout[];
}

export interface LayoutSequenceMessage {
  message: UmlMessage;
  y: number;
  fromX: number;
  toX: number;
  selfMessage: boolean;
  points: SequencePointLayout[];
}

export interface LayoutSequenceActivation {
  lifelineId: string;
  centerX: number;
  top: number;
  bottom: number;
  depth: number;
}

export interface LayoutSequenceFragment {
  fragment: UmlFragment;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SequenceLayoutResult {
  lifelines: LayoutSequenceLifeline[];
  messages: LayoutSequenceMessage[];
  activations: LayoutSequenceActivation[];
  fragments: LayoutSequenceFragment[];
  width: number;
  height: number;
}

function pointLayouts(componentId: string, label: string, points: string[] | undefined, top: number): SequencePointLayout[] {
  return (points ?? []).map((text, index) => ({
    id: `${componentId}-p${index + 1}`,
    label: `${label} · point ${index + 1}`,
    text,
    y: top + index * SEQ_POINT_LINE,
  }));
}

export function computeSequenceLayout(content: UmlSequenceContent): SequenceLayoutResult {
  const columnX = new Map<string, number>();
  const maxLifelinePoints = content.lifelines.reduce(
    (max, lifeline) => Math.max(max, (lifeline.points ?? []).length),
    0,
  );
  const headerBlockHeight = SEQ_HEADER_HEIGHT + (maxLifelinePoints > 0 ? maxLifelinePoints * SEQ_POINT_LINE + 6 : 0);
  const messagesTop = SEQ_TOP + headerBlockHeight + 34;

  // Assign message rows first so lifeline lines can span the full timeline.
  let cursor = messagesTop;
  const rowY = new Map<string, number>();
  const messageHeights = content.messages.map(message => {
    const isSelf = message.from === message.to;
    const pointRows = (message.points ?? []).length;
    const base = SEQ_ROW_HEIGHT + (isSelf ? SEQ_SELF_LOOP : 0) + pointRows * SEQ_POINT_LINE;
    return { message, isSelf, height: base + SEQ_ROW_GAP };
  });
  const positionedMessages: LayoutSequenceMessage[] = messageHeights.map(entry => {
    const y = cursor + (entry.isSelf ? 8 : SEQ_ROW_HEIGHT / 2);
    rowY.set(entry.message.id, y);
    cursor += entry.height;
    return {
      message: entry.message,
      y,
      fromX: 0,
      toX: 0,
      selfMessage: entry.isSelf,
      points: pointLayouts(
        entry.message.component_id,
        entry.message.label,
        entry.message.points,
        y + (entry.isSelf ? SEQ_SELF_LOOP : 14),
      ),
    };
  });
  const timelineBottom = Math.max(cursor, messagesTop + SEQ_ROW_HEIGHT) + 10;

  const lifelines: LayoutSequenceLifeline[] = content.lifelines.map((lifeline, index) => {
    const centerX = SEQ_FIRST_COLUMN_X + index * SEQ_COLUMN_GAP;
    columnX.set(lifeline.id, centerX);
    return {
      lifeline,
      centerX,
      headerTop: SEQ_TOP,
      headerHeight: SEQ_HEADER_HEIGHT,
      lineTop: SEQ_TOP + headerBlockHeight,
      lineBottom: timelineBottom,
      points: pointLayouts(
        lifeline.component_id,
        lifeline.label,
        lifeline.points,
        SEQ_TOP + SEQ_HEADER_HEIGHT + 14,
      ),
    };
  });

  for (const message of positionedMessages) {
    message.fromX = columnX.get(message.message.from) ?? SEQ_FIRST_COLUMN_X;
    message.toX = columnX.get(message.message.to) ?? SEQ_FIRST_COLUMN_X;
  }

  // Activation bars: a call/create activates its callee; a reply deactivates its
  // source. Leftover activations close at the end of the timeline.
  const activations: LayoutSequenceActivation[] = [];
  const openByLifeline = new Map<string, { top: number; depth: number }[]>();
  for (const message of positionedMessages) {
    const { message_kind: kind, from, to } = message.message;
    if (kind === "reply" || kind === "destroy") {
      const stack = openByLifeline.get(from);
      const open = stack?.pop();
      if (open) {
        activations.push({
          lifelineId: from,
          centerX: columnX.get(from) ?? SEQ_FIRST_COLUMN_X,
          top: open.top,
          bottom: message.y,
          depth: open.depth,
        });
      }
    } else {
      const stack = openByLifeline.get(to) ?? [];
      stack.push({ top: message.y, depth: stack.length });
      openByLifeline.set(to, stack);
    }
  }
  for (const [lifelineId, stack] of openByLifeline) {
    for (const open of stack) {
      activations.push({
        lifelineId,
        centerX: columnX.get(lifelineId) ?? SEQ_FIRST_COLUMN_X,
        top: open.top,
        bottom: timelineBottom - 8,
        depth: open.depth,
      });
    }
  }

  const fragments: LayoutSequenceFragment[] = content.fragments.map(fragment => {
    const rows = fragment.message_ids.map(id => rowY.get(id)).filter((y): y is number => typeof y === "number");
    const involvedX = fragment.message_ids.flatMap(id => {
      const message = content.messages.find(candidate => candidate.id === id);
      if (!message) return [];
      return [columnX.get(message.from), columnX.get(message.to)].filter((x): x is number => typeof x === "number");
    });
    const top = (rows.length ? Math.min(...rows) : messagesTop) - SEQ_FRAGMENT_PAD - 16;
    const bottom = (rows.length ? Math.max(...rows) : messagesTop) + SEQ_FRAGMENT_PAD;
    const left = (involvedX.length ? Math.min(...involvedX) : SEQ_FIRST_COLUMN_X) - SEQ_FRAGMENT_PAD - 10;
    const right = (involvedX.length ? Math.max(...involvedX) : SEQ_FIRST_COLUMN_X) + SEQ_FRAGMENT_PAD + 10;
    return {
      fragment,
      x: left,
      y: top,
      width: Math.max(120, right - left),
      height: Math.max(48, bottom - top),
    };
  });

  const lastCenter = lifelines.length ? lifelines[lifelines.length - 1]!.centerX : SEQ_FIRST_COLUMN_X;
  const width = lastCenter + SEQ_HEADER_WIDTH / 2 + SEQ_SIDE_MARGIN;
  const height = timelineBottom + SEQ_BOTTOM_MARGIN;
  return { lifelines, messages: positionedMessages, activations, fragments, width, height };
}

export const SEQUENCE_METRICS = {
  headerWidth: SEQ_HEADER_WIDTH,
  headerHeight: SEQ_HEADER_HEIGHT,
  activationWidth: SEQ_ACTIVATION_WIDTH,
  selfLoop: SEQ_SELF_LOOP,
};

export const UML_GRAPH_NODE_WIDTH: number = NODE_WIDTH;

declare global {
  interface Window {
    __BRAINSTORM_ELK_WORKER_URL_PROMISE__?: Promise<string>;
  }
}
