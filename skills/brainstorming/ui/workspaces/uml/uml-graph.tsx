import {
  Handle,
  Position,
  useStore,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { useRef, type PointerEvent as ReactPointerEvent } from "react";

import { InlineText } from "../../shared/InlineText";
import { UML_STEREOTYPE_NODE_KINDS } from "./uml-layout";
import type {
  UmlContainer,
  UmlEdgeLabel,
  UmlGraphEdge,
  UmlGraphNode,
  UmlNodeKind,
  UmlRelation,
} from "./uml-layout";

interface Point {
  x: number;
  y: number;
}

const EDGE_LABEL_LINE_HEIGHT = 14;

export interface UmlGraphNodeData extends Record<string, unknown> {
  node: UmlGraphNode;
  focused: boolean;
}

export interface UmlContainerData extends Record<string, unknown> {
  container: UmlContainer;
  focused: boolean;
}

export interface UmlGraphEdgeData extends Record<string, unknown> {
  edge: UmlGraphEdge;
  path: string;
  points: Point[];
  label: UmlEdgeLabel | null;
  /** How far the reviewer nudged this label away from its computed slot, in flow units. */
  labelOffset: Point;
  onLabelMove: (edgeId: string, offset: Point) => void;
}

export type UmlGraphFlowNode = Node<UmlGraphNodeData, "umlNode">;
export type UmlContainerFlowNode = Node<UmlContainerData, "umlContainer">;
export type UmlCanvasNode = UmlGraphFlowNode | UmlContainerFlowNode;
export type UmlGraphFlowEdge = Edge<UmlGraphEdgeData, "umlEdge">;

const CARD_KINDS = new Set<UmlNodeKind>([
  "component",
  "interface",
  "artifact",
  "deployment_node",
  "actor",
  "use_case",
  "state",
  "action",
  "object",
  "accept_event",
  "send_signal",
]);
const DIAMOND_KINDS = new Set<UmlNodeKind>(["choice", "decision", "merge"]);
// Shared with the ELK sizing contract so the height reserved for a card's header is the
// height the card renders.
const STEREOTYPE_KINDS = UML_STEREOTYPE_NODE_KINDS;

const DASHED_RELATIONS = new Set<UmlRelation>(["dependency", "realization", "object_flow"]);
const RELATION_ARROWHEAD: Record<UmlRelation, "open" | "filled" | "hollow"> = {
  dependency: "open",
  assembly: "open",
  delegation: "open",
  realization: "hollow",
  association: "open",
  generalization: "hollow",
  transition: "open",
  control_flow: "filled",
  object_flow: "open",
};

function titleCase(value: string): string {
  return value.replaceAll("_", " ").replace(/^./u, first => first.toUpperCase());
}

export function UmlGraphNodeView({ data }: NodeProps<UmlGraphFlowNode>) {
  const { node } = data;
  const isCard = CARD_KINDS.has(node.node_kind);
  const isDiamond = DIAMOND_KINDS.has(node.node_kind);
  const points = node.points ?? [];
  return (
    <div
      aria-label={`${node.label}, ${titleCase(node.node_kind)}`}
      className={`uml-node uml-node-${node.node_kind}`}
      data-brainstorm-id={node.component_id}
      data-brainstorm-label={node.label}
      data-focused={data.focused ? "true" : undefined}
      data-node-id={node.id}
      data-node-kind={node.node_kind}
    >
      <Handle className="uml-handle" isConnectable={false} position={Position.Left} type="target" />
      <Handle className="uml-handle" isConnectable={false} position={Position.Right} type="source" />
      {isCard ? (
        <div className="uml-node-body">
          {STEREOTYPE_KINDS.has(node.node_kind) ? (
            <span className="uml-node-stereotype">«{titleCase(node.node_kind)}»</span>
          ) : null}
          <span className="uml-node-label"><InlineText value={node.label} /></span>
          {points.length > 0 ? (
            <ul className="uml-node-points">
              {points.map((point, index) => (
                <li
                  data-brainstorm-id={`${node.component_id}-p${index + 1}`}
                  data-brainstorm-label={`${node.label} · point ${index + 1}`}
                  key={`${node.component_id}-p${index + 1}`}
                >
                  <InlineText value={point} />
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : isDiamond ? (
        <span className="uml-node-shape-label">{node.label}</span>
      ) : (
        <span className="uml-node-marker-label">{node.label}</span>
      )}
    </div>
  );
}

export function UmlContainerView({ data }: NodeProps<UmlContainerFlowNode>) {
  const { container } = data;
  return (
    <section
      className={`uml-container uml-container-${container.container_kind}`}
      data-brainstorm-id={container.component_id}
      data-brainstorm-label={container.label}
      data-container-id={container.id}
      data-container-kind={container.container_kind}
      data-focused={data.focused ? "true" : undefined}
    >
      <header>{container.label}</header>
    </section>
  );
}

function arrowGeometry(points: Point[]): { tip: Point; left: Point; right: Point } | null {
  if (points.length < 2) return null;
  const end = points[points.length - 1];
  const prev = points[points.length - 2];
  if (!end || !prev) return null;
  const dx = end.x - prev.x;
  const dy = end.y - prev.y;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const headLength = 12;
  const headWidth = 6;
  const baseX = end.x - ux * headLength;
  const baseY = end.y - uy * headLength;
  const perpX = -uy;
  const perpY = ux;
  return {
    tip: { x: end.x, y: end.y },
    left: { x: baseX + perpX * headWidth, y: baseY + perpY * headWidth },
    right: { x: baseX - perpX * headWidth, y: baseY - perpY * headWidth },
  };
}

function ArrowHead({ points, kind }: { points: Point[]; kind: "open" | "filled" | "hollow" }) {
  const geometry = arrowGeometry(points);
  if (!geometry) return null;
  const { tip, left, right } = geometry;
  if (kind === "open") {
    return (
      <path
        className="uml-arrow uml-arrow-open"
        d={`M ${left.x} ${left.y} L ${tip.x} ${tip.y} L ${right.x} ${right.y}`}
      />
    );
  }
  return (
    <polygon
      className={`uml-arrow uml-arrow-${kind}`}
      points={`${tip.x},${tip.y} ${left.x},${left.y} ${right.x},${right.y}`}
    />
  );
}

// A label the reviewer nudged this far from its slot gets a leader line, so it stays
// obvious which edge it belongs to.
const LABEL_LEADER_THRESHOLD = 14;

// The shell selects an Annotation Component from a capture-phase click on an ancestor, which
// runs before any handler this component could attach. Swallowing the click that ends a drag
// therefore has to happen at the window, outside that ancestor's capture path.
function suppressNextClick(): void {
  const swallow = (event: MouseEvent): void => {
    event.stopPropagation();
    event.stopImmediatePropagation();
  };
  globalThis.addEventListener("click", swallow, { capture: true, once: true });
  // A drag that ends without a following click must not leave the trap armed.
  globalThis.setTimeout(() => globalThis.removeEventListener("click", swallow, { capture: true }), 300);
}

function UmlEdgeLabelView({ edgeId, label, offset, onMove }: {
  edgeId: string;
  label: UmlEdgeLabel;
  offset: Point;
  onMove: (edgeId: string, offset: Point) => void;
}) {
  const zoom = useStore(state => state.transform[2]);
  const drag = useRef<{ pointerId: number; startX: number; startY: number; base: Point; moved: boolean } | null>(null);

  const box = {
    x: label.box.x + offset.x,
    y: label.box.y + offset.y,
    width: label.box.width,
    height: label.box.height,
  };
  const centerX = box.x + box.width / 2;
  const firstLineY = box.y + box.height / 2 - ((label.lines.length - 1) * EDGE_LABEL_LINE_HEIGHT) / 2;
  const nudged = Math.hypot(offset.x, offset.y) > LABEL_LEADER_THRESHOLD;

  const onPointerDown = (event: ReactPointerEvent<SVGGElement>): void => {
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      base: offset,
      moved: false,
    };
  };
  const onPointerMove = (event: ReactPointerEvent<SVGGElement>): void => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const dx = (event.clientX - active.startX) / (zoom || 1);
    const dy = (event.clientY - active.startY) / (zoom || 1);
    if (!active.moved && Math.hypot(dx, dy) < 2) return;
    active.moved = true;
    onMove(edgeId, { x: active.base.x + dx, y: active.base.y + dy });
  };
  const onPointerUp = (event: ReactPointerEvent<SVGGElement>): void => {
    if (drag.current?.pointerId !== event.pointerId) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    const moved = drag.current.moved;
    drag.current = null;
    if (moved) suppressNextClick();
  };

  return (
    <g
      className="uml-edge-label"
      data-edge-label={edgeId}
      data-label-nudged={nudged ? "" : undefined}
      onPointerCancel={onPointerUp}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {nudged ? (
        <line
          className="uml-edge-label-leader"
          x1={label.box.x + label.box.width / 2}
          x2={centerX}
          y1={label.box.y + label.box.height / 2}
          y2={box.y + box.height / 2}
        />
      ) : null}
      <rect height={box.height} rx={4} width={box.width} x={box.x} y={box.y} />
      <text textAnchor="middle" x={centerX} y={firstLineY}>
        {label.lines.map((line, index) => (
          <tspan
            dominantBaseline="central"
            key={line + String(index)}
            x={centerX}
            y={firstLineY + index * EDGE_LABEL_LINE_HEIGHT}
          >
            {line}
          </tspan>
        ))}
      </text>
    </g>
  );
}

export function UmlGraphEdgeView({ data }: EdgeProps<UmlGraphFlowEdge>) {
  if (!data || data.path.length === 0) return null;
  const { edge, points, label } = data;
  const dashed = DASHED_RELATIONS.has(edge.relation);
  return (
    <g
      className={`uml-edge uml-edge-${edge.relation}`}
      data-brainstorm-id={edge.component_id}
      data-brainstorm-label={edge.label ? `${titleCase(edge.relation)}: ${edge.label}` : `${titleCase(edge.relation)} ${edge.id}`}
      data-edge-id={edge.id}
      data-relation={edge.relation}
    >
      <path className="uml-edge-hit" d={data.path} />
      <path className="uml-edge-path" d={data.path} data-dashed={dashed ? "" : undefined} />
      {/* The label is drawn before the arrowhead so its background can never hide an arrow. */}
      {label ? (
        <UmlEdgeLabelView
          edgeId={edge.id}
          label={label}
          offset={data.labelOffset}
          onMove={data.onLabelMove}
        />
      ) : null}
      <ArrowHead kind={RELATION_ARROWHEAD[edge.relation]} points={points} />
    </g>
  );
}
