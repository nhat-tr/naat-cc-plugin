import {
  Handle,
  Position,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";

import type {
  ArchitectureEdge,
  ArchitectureNode,
  OwnershipBoundary,
} from "./architecture-layout";

export interface ArchitectureNodeData extends Record<string, unknown> {
  node: ArchitectureNode;
  focused: boolean;
  scenario: boolean;
  scenarioId: string | null;
  scenarioEnd: boolean;
  scenarioStart: boolean;
}

export interface OwnershipBoundaryData extends Record<string, unknown> {
  boundary: OwnershipBoundary;
  focused: boolean;
}

export interface ArchitectureEdgeData extends Record<string, unknown> {
  edge: ArchitectureEdge;
  path: string;
  routePoints: number;
  scenario: boolean;
  scenarioId: string | null;
  scenarioPathIdentity: boolean;
}

export type ArchitectureFlowNode = Node<ArchitectureNodeData, "architectureNode">;
export type OwnershipBoundaryFlowNode = Node<OwnershipBoundaryData, "ownershipBoundary">;
export type ArchitectureCanvasNode = ArchitectureFlowNode | OwnershipBoundaryFlowNode;
export type ArchitectureFlowEdge = Edge<ArchitectureEdgeData, "architectureEdge">;

export function ArchitectureNodeView({ data }: NodeProps<ArchitectureFlowNode>) {
  const { node } = data;
  const endpointLabel = data.scenarioStart && data.scenarioEnd
    ? "Scenario start and end"
    : data.scenarioStart
      ? "Scenario start"
      : data.scenarioEnd
        ? "Scenario end"
        : null;
  return (
    <article
      aria-label={[node.label, node.type.replaceAll("_", " "), endpointLabel].filter(Boolean).join(", ")}
      className={`architecture-node architecture-node-${node.type} change-${node.change}`}
      data-architecture-node=""
      data-brainstorm-id={node.component_id}
      data-brainstorm-label={node.label}
      data-change={node.change}
      data-focused={data.focused ? "true" : undefined}
      data-node-id={node.id}
      data-node-type={node.type}
      data-owner-id={node.owner_id}
      data-scenario-id={data.scenario ? data.scenarioId ?? undefined : undefined}
      data-scenario-active={data.scenario ? "" : undefined}
      data-scenario-endpoint={data.scenarioStart ? "start" : data.scenarioEnd ? "end" : undefined}
    >
      {node.ports.map(port => (
        <Handle
          aria-label={`${node.label} ${port.label}`}
          className={`architecture-port architecture-port-${port.direction}`}
          data-architecture-port=""
          data-port-direction={port.direction}
          id={port.id}
          isConnectable={false}
          key={port.id}
          position={port.direction === "input" ? Position.Left : Position.Right}
          role="img"
          title={`${port.label}: ${port.protocol}`}
          type={port.direction === "input" ? "target" : "source"}
        />
      ))}
      <div className="architecture-node-heading">
        <span aria-hidden="true" className="architecture-type-mark" />
        <strong>{node.label}</strong>
        {data.scenarioStart || data.scenarioEnd ? (
          <span className="architecture-scenario-endpoints">
            {data.scenarioStart ? <span data-scenario-endpoint-badge="start">Start</span> : null}
            {data.scenarioEnd ? <span data-scenario-endpoint-badge="end">End</span> : null}
          </span>
        ) : null}
      </div>
      <div className="architecture-node-meta">
        <span>{node.type.replaceAll("_", " ")}</span>
        {node.change !== "unchanged" ? <span className="architecture-change">{node.change}</span> : null}
      </div>
    </article>
  );
}

export function OwnershipBoundaryView({ data }: NodeProps<OwnershipBoundaryFlowNode>) {
  const { boundary } = data;
  return (
    <section
      className="ownership-boundary"
      data-boundary-id={boundary.id}
      data-brainstorm-id={boundary.component_id}
      data-brainstorm-label={boundary.label}
      data-focused={data.focused ? "true" : undefined}
      data-ownership-boundary=""
      data-parent-boundary-id={boundary.parent_id ?? undefined}
    >
      <header>{boundary.label}</header>
    </section>
  );
}

export function ArchitectureEdgeView({ data, markerEnd }: EdgeProps<ArchitectureFlowEdge>) {
  if (!data || data.path.length === 0) return null;
  return (
    <g
      className={`architecture-edge architecture-edge-${data.edge.type}${data.scenario ? " scenario-active" : ""}`}
      data-architecture-edge=""
      data-brainstorm-id={data.edge.component_id}
      data-brainstorm-label={`${data.edge.type} ${data.edge.id}`}
      data-edge-id={data.edge.id}
      data-edge-type={data.edge.type}
      data-route-points={data.routePoints}
      data-scenario-id={data.scenario ? data.scenarioId ?? undefined : undefined}
      data-scenario-path={data.scenarioPathIdentity ? "" : undefined}
    >
      <path className="architecture-edge-hit" d={data.path} />
      <path className="architecture-edge-path" d={data.path} markerEnd={markerEnd} />
    </g>
  );
}
