import {
  Background,
  BackgroundVariant,
  MiniMap,
  ReactFlow,
  type ReactFlowInstance,
} from "@xyflow/react";
import { Minus, Plus, Scan } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  UmlContainerView,
  UmlGraphEdgeView,
  UmlGraphNodeView,
  type UmlCanvasNode,
  type UmlGraphFlowEdge,
} from "./uml-graph";
import {
  layoutUml,
  type UmlGraphContent,
  type UmlLayoutResult,
  type UmlSequenceContent,
} from "./uml-layout";
import { UmlSequence } from "./uml-sequence";

interface UmlWorkspaceProps {
  content: Record<string, unknown>;
  onPresentedComponentIdsChange?: (componentIds: string[]) => void;
}

interface LayoutState {
  status: "loading" | "ready" | "error";
  result: UmlLayoutResult | null;
  error: string | null;
}

const NODE_TYPES = {
  umlNode: UmlGraphNodeView,
  umlContainer: UmlContainerView,
};
const EDGE_TYPES = {
  umlEdge: UmlGraphEdgeView,
};

const DIAGRAM_TITLES: Record<string, string> = {
  component: "Component diagram",
  state_machine: "State machine",
  activity: "Activity diagram",
  sequence: "Sequence diagram",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function graphContent(value: Record<string, unknown>): UmlGraphContent | null {
  if (
    !isRecord(value.layout)
    || value.layout.engine !== "elk"
    || !isRecord(value.camera)
    || !Array.isArray(value.containers)
    || !Array.isArray(value.nodes)
    || !Array.isArray(value.edges)
    || !Array.isArray(value.focus_targets)
    || !Array.isArray(value.annotation_targets)
    || (value.diagram_kind !== "component"
      && value.diagram_kind !== "state_machine"
      && value.diagram_kind !== "activity")
  ) return null;
  return value as unknown as UmlGraphContent;
}

function sequenceContent(value: Record<string, unknown>): UmlSequenceContent | null {
  if (
    value.diagram_kind !== "sequence"
    || !Array.isArray(value.lifelines)
    || !Array.isArray(value.messages)
    || !Array.isArray(value.fragments)
    || !Array.isArray(value.annotation_targets)
  ) return null;
  return value as unknown as UmlSequenceContent;
}

function containerDepth(containerById: Map<string, { parent_id: string | null }>, id: string): number {
  let depth = 0;
  let current = containerById.get(id);
  while (current && current.parent_id) {
    depth += 1;
    current = containerById.get(current.parent_id);
  }
  return depth;
}

function UmlGraphCanvas({ content, onPresentedComponentIdsChange }: {
  content: UmlGraphContent;
  onPresentedComponentIdsChange?: (componentIds: string[]) => void;
}) {
  const [flow, setFlow] = useState<ReactFlowInstance<UmlCanvasNode, UmlGraphFlowEdge> | null>(null);
  const [layout, setLayout] = useState<LayoutState>({ status: "loading", result: null, error: null });

  useEffect(() => {
    let active = true;
    setLayout({ status: "loading", result: null, error: null });
    void layoutUml(content).then(
      result => { if (active) setLayout({ status: "ready", result, error: null }); },
      error => {
        if (!active) return;
        setLayout({
          status: "error",
          result: null,
          error: error instanceof Error ? error.message : "ELK layout failed.",
        });
      },
    );
    return () => { active = false; };
  }, [content]);

  useEffect(() => {
    if (!flow || layout.status !== "ready") return;
    const frame = requestAnimationFrame(() => {
      void flow.fitView({ padding: content.camera.fit_padding, duration: 0, maxZoom: 1.1 });
    });
    return () => cancelAnimationFrame(frame);
  }, [content.camera.fit_padding, flow, layout.status]);

  const visibleNodes = useMemo<UmlCanvasNode[]>(() => {
    if (!layout.result) return [];
    const containerById = new Map(content.containers.map(container => [container.id, container]));
    const containers = [...layout.result.containers]
      .sort((left, right) => (
        containerDepth(containerById, left.container.id) - containerDepth(containerById, right.container.id)
      ))
      .map<UmlCanvasNode>(item => ({
        id: item.container.id,
        type: "umlContainer",
        parentId: item.container.parent_id ?? undefined,
        position: item.position,
        data: { container: item.container, focused: false },
        ariaLabel: item.container.label,
        focusable: false,
        selectable: true,
        draggable: false,
        style: { width: item.width, height: item.height },
      }));
    const nodes = layout.result.nodes.map<UmlCanvasNode>(item => ({
      id: item.node.id,
      type: "umlNode",
      parentId: item.node.container_id ?? undefined,
      extent: item.node.container_id ? "parent" : undefined,
      position: item.position,
      data: { node: item.node, focused: false },
      ariaLabel: item.node.label,
      focusable: false,
      selectable: true,
      draggable: false,
      style: { width: item.width, height: item.height },
    }));
    return [...containers, ...nodes];
  }, [content.containers, layout.result]);

  const visibleEdges = useMemo<UmlGraphFlowEdge[]>(() => {
    if (!layout.result) return [];
    return layout.result.edges.map(item => ({
      id: item.edge.id,
      type: "umlEdge",
      source: item.edge.source,
      target: item.edge.target,
      data: {
        edge: item.edge,
        path: item.path,
        points: item.points,
        labelPoint: item.labelPoint,
      },
      ariaLabel: item.edge.label ?? item.edge.relation,
      focusable: false,
      selectable: true,
    }));
  }, [layout.result]);

  const presentedComponentIds = useMemo(() => {
    const annotationTargets = new Set(content.annotation_targets);
    const ids: string[] = [];
    if (layout.status === "ready" && layout.result) {
      ids.push(
        ...layout.result.containers.map(item => item.container.component_id),
        ...layout.result.nodes.flatMap(item => [
          item.node.component_id,
          ...(item.node.points ?? []).map((_point, index) => `${item.node.component_id}-p${index + 1}`),
        ]),
        ...layout.result.edges.map(item => item.edge.component_id),
      );
    }
    return [...new Set(ids.filter(id => annotationTargets.has(id)))].sort();
  }, [content.annotation_targets, layout.result, layout.status]);

  useEffect(() => {
    if (layout.status !== "ready") return;
    onPresentedComponentIdsChange?.(presentedComponentIds);
  }, [layout.status, onPresentedComponentIdsChange, presentedComponentIds]);

  return (
    <div
      className="uml-viewport"
      data-layout-edge-count={content.edges.length}
      data-layout-engine={content.layout.engine}
      data-layout-node-count={content.nodes.length}
      data-layout-status={layout.status}
      data-uml-viewport=""
    >
      {layout.status === "loading" ? (
        <div className="uml-layout-message" role="status">Computing diagram layout...</div>
      ) : layout.status === "error" ? (
        <div className="uml-layout-message" role="alert">{layout.error}</div>
      ) : (
        <ReactFlow<UmlCanvasNode, UmlGraphFlowEdge>
          aria-label="UML diagram graph"
          edges={visibleEdges}
          edgeTypes={EDGE_TYPES}
          edgesFocusable={false}
          elementsSelectable
          maxZoom={content.camera.max_zoom}
          minZoom={content.camera.min_zoom}
          nodeTypes={NODE_TYPES}
          nodes={visibleNodes}
          nodesConnectable={false}
          nodesDraggable={false}
          nodesFocusable={false}
          onInit={setFlow}
          onlyRenderVisibleElements={false}
          panOnDrag
          preventScrolling
          proOptions={{ hideAttribution: true }}
          zoomOnDoubleClick={false}
        >
          <Background color="#cbd4dd" gap={28} size={1} variant={BackgroundVariant.Dots} />
          <div className="uml-camera-controls" data-camera-controls="" role="toolbar" aria-label="Camera controls">
            <button onClick={() => void flow?.zoomIn({ duration: 0 })} title="Zoom in" type="button">
              <Plus aria-hidden="true" size={17} />
              <span className="sr-only">Zoom in</span>
            </button>
            <button onClick={() => void flow?.zoomOut({ duration: 0 })} title="Zoom out" type="button">
              <Minus aria-hidden="true" size={17} />
              <span className="sr-only">Zoom out</span>
            </button>
            <button
              onClick={() => void flow?.fitView({ padding: content.camera.fit_padding, duration: 0 })}
              title="Fit view"
              type="button"
            >
              <Scan aria-hidden="true" size={17} />
              <span className="sr-only">Fit view</span>
            </button>
          </div>
          <div className="uml-minimap-shell" data-uml-minimap="">
            <MiniMap
              ariaLabel="UML minimap"
              bgColor="#f7f9fb"
              maskColor="rgba(25, 35, 45, 0.14)"
              nodeColor="#6f8294"
              nodeStrokeColor="#31465a"
              nodeStrokeWidth={1.5}
              pannable
              zoomable
            />
          </div>
        </ReactFlow>
      )}
    </div>
  );
}

export function UmlWorkspace({ content, onPresentedComponentIdsChange }: UmlWorkspaceProps) {
  const kind = isRecord(content) ? content.diagram_kind : null;
  const graph = useMemo(() => (isRecord(content) ? graphContent(content) : null), [content]);
  const sequence = useMemo(() => (isRecord(content) ? sequenceContent(content) : null), [content]);

  if (!graph && !sequence) {
    return <p className="workspace-error" role="alert">UML Workspace content is invalid.</p>;
  }

  return (
    <section
      className="uml-canvas"
      data-diagram-kind={typeof kind === "string" ? kind : undefined}
      data-uml-canvas=""
    >
      <header className="uml-canvas-header">
        <span className="uml-kicker">UML Diagram</span>
        <h2>{typeof kind === "string" ? DIAGRAM_TITLES[kind] ?? "UML diagram" : "UML diagram"}</h2>
      </header>
      {graph ? (
        <UmlGraphCanvas content={graph} onPresentedComponentIdsChange={onPresentedComponentIdsChange} />
      ) : sequence ? (
        <UmlSequence content={sequence} onPresentedComponentIdsChange={onPresentedComponentIdsChange} />
      ) : null}
    </section>
  );
}
