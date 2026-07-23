import {
  Handle,
  Position,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";

import { InlineText } from "../../shared/InlineText";
import type {
  UmlContainer,
  UmlGraphEdge,
  UmlGraphNode,
  UmlNodeKind,
  UmlRelation,
} from "./uml-layout";

interface Point {
  x: number;
  y: number;
}

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
  labelPoint: Point | null;
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
const STEREOTYPE_KINDS = new Set<UmlNodeKind>([
  "component",
  "interface",
  "artifact",
  "deployment_node",
  "use_case",
  "accept_event",
  "send_signal",
]);

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

export function UmlGraphEdgeView({ data }: EdgeProps<UmlGraphFlowEdge>) {
  if (!data || data.path.length === 0) return null;
  const { edge, points, labelPoint } = data;
  const dashed = DASHED_RELATIONS.has(edge.relation);
  const labelWidth = edge.label ? Math.min(220, edge.label.length * 6.3 + 14) : 0;
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
      <ArrowHead kind={RELATION_ARROWHEAD[edge.relation]} points={points} />
      {edge.label && labelPoint ? (
        <g className="uml-edge-label" transform={`translate(${labelPoint.x}, ${labelPoint.y})`}>
          <rect height={18} rx={4} width={labelWidth} x={-labelWidth / 2} y={-9} />
          <text dominantBaseline="central" textAnchor="middle" x={0} y={1}>{edge.label}</text>
        </g>
      ) : null}
    </g>
  );
}
