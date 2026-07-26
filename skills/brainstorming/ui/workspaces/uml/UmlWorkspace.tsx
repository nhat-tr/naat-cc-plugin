import {
  Background,
  BackgroundVariant,
  MiniMap,
  ReactFlow,
  type NodeChange,
  type ReactFlowInstance,
  type XYPosition,
} from "@xyflow/react";
import { Minus, Plus, RotateCcw, Scan } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  UmlContainerView,
  UmlGraphEdgeView,
  UmlGraphNodeView,
  type UmlCanvasNode,
  type UmlGraphFlowEdge,
} from "./uml-graph";
import {
  layoutUml,
  manualUmlEdgeGeometry,
  type UmlBox,
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

// A dragged card may travel this far beyond the package box ELK computed for it.
const DRAG_ALLOWANCE = 600;
// Mirrors the package padding and header height in the ELK container layout options.
const PACKAGE_PADDING = 22;
const PACKAGE_HEADER_HEIGHT = 34;
const ORIGIN: XYPosition = { x: 0, y: 0 };
// Above the node layer, which React Flow leaves at the default z-index.
const NUDGED_EDGE_Z_INDEX = 6;

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
  // Cards a reviewer dragged. Empty means "exactly where ELK put it", which is what a new
  // Revision falls back to, so a publish clears the manual moves.
  const [movedNodes, setMovedNodes] = useState<Record<string, XYPosition>>({});
  // Edge labels the reviewer nudged, as an offset from the slot the layout reserved, so a
  // label keeps its nudge when its edge re-routes.
  const [movedLabels, setMovedLabels] = useState<Record<string, XYPosition>>({});

  useEffect(() => {
    let active = true;
    setMovedNodes({});
    setMovedLabels({});
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

  // Absolute geometry of every card at its current position, and the package boxes grown to
  // keep containing them. Packages are sized here rather than through React Flow's
  // `expandParent`, whose change stream fights a layout this component owns.
  const liveGeometry = useMemo(() => {
    const cards = new Map<string, UmlBox>();
    const packages = new Map<string, UmlBox>();
    if (!layout.result) return { cards, packages };
    const containerLayout = new Map(layout.result.containers.map(item => [item.container.id, item]));
    const originOf = (containerId: string | null): XYPosition => {
      const origin = { x: 0, y: 0 };
      const visited = new Set<string>();
      let current = containerId;
      while (current && !visited.has(current)) {
        visited.add(current);
        const item = containerLayout.get(current);
        if (!item) break;
        origin.x += item.position.x;
        origin.y += item.position.y;
        current = item.container.parent_id;
      }
      return origin;
    };
    for (const item of layout.result.containers) {
      const origin = originOf(item.container.id);
      packages.set(item.container.id, {
        x: origin.x,
        y: origin.y,
        width: item.width,
        height: item.height,
      });
    }
    for (const item of layout.result.nodes) {
      const origin = originOf(item.node.container_id);
      const position = movedNodes[item.node.id] ?? item.position;
      const box = {
        x: origin.x + position.x,
        y: origin.y + position.y,
        width: item.width,
        height: item.height,
      };
      cards.set(item.node.id, box);
      // Grow every package the card belongs to so a dragged card stays enclosed.
      let ownerId = item.node.container_id;
      const visited = new Set<string>();
      while (ownerId && !visited.has(ownerId)) {
        visited.add(ownerId);
        const owner = packages.get(ownerId);
        if (owner) {
          owner.width = Math.max(owner.width, box.x + box.width + PACKAGE_PADDING - owner.x);
          owner.height = Math.max(owner.height, box.y + box.height + PACKAGE_PADDING - owner.y);
        }
        ownerId = containerLayout.get(ownerId)?.container.parent_id ?? null;
      }
    }
    return { cards, packages };
  }, [layout.result, movedNodes]);

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
        // `measured` is what keeps React Flow's node internals alive when a drag hands it a
        // fresh node object: without it, handle bounds reset and every edge unmounts for a
        // frame. It is always the size we set through `style`.
        measured: {
          width: liveGeometry.packages.get(item.container.id)?.width ?? item.width,
          height: liveGeometry.packages.get(item.container.id)?.height ?? item.height,
        },
        style: {
          width: liveGeometry.packages.get(item.container.id)?.width ?? item.width,
          height: liveGeometry.packages.get(item.container.id)?.height ?? item.height,
        },
      }));
    const nodes = layout.result.nodes.map<UmlCanvasNode>(item => ({
      id: item.node.id,
      type: "umlNode",
      parentId: item.node.container_id ?? undefined,
      // A card may be dragged well past the box ELK sized for its original neighbours — the
      // package grows with it — but never up or left out of the package it belongs to.
      extent: item.node.container_id
        ? [
          [PACKAGE_PADDING, PACKAGE_HEADER_HEIGHT],
          [
            (liveGeometry.packages.get(item.node.container_id)?.width ?? item.width) + DRAG_ALLOWANCE,
            (liveGeometry.packages.get(item.node.container_id)?.height ?? item.height) + DRAG_ALLOWANCE,
          ],
        ]
        : undefined,
      position: movedNodes[item.node.id] ?? item.position,
      data: { node: item.node, focused: false },
      ariaLabel: item.node.label,
      focusable: false,
      selectable: true,
      draggable: true,
      measured: { width: item.width, height: item.height },
      style: { width: item.width, height: item.height },
    }));
    return [...containers, ...nodes];
  }, [content.containers, layout.result, liveGeometry, movedNodes]);

  const liveBoxes = liveGeometry.cards;

  const moveLabel = useCallback((edgeId: string, offset: XYPosition) => {
    setMovedLabels(current => ({ ...current, [edgeId]: offset }));
  }, []);

  const visibleEdges = useMemo<UmlGraphFlowEdge[]>(() => {
    if (!layout.result) return [];
    // Only edges whose endpoints left the position ELK routed them to need re-routing; the
    // rest keep the orthogonal route and the label slot the layout engine reserved.
    const displaced = (item: { node: { id: string }; absolutePosition: XYPosition }): boolean => {
      const live = liveBoxes.get(item.node.id);
      if (!live) return false;
      return Math.abs(live.x - item.absolutePosition.x) > 0.5
        || Math.abs(live.y - item.absolutePosition.y) > 0.5;
    };
    const displacedIds = new Set(layout.result.nodes.filter(displaced).map(item => item.node.id));
    return layout.result.edges.map(item => {
      const source = liveBoxes.get(item.edge.source);
      const target = liveBoxes.get(item.edge.target);
      const moved = displacedIds.has(item.edge.source) || displacedIds.has(item.edge.target);
      const geometry = moved && source && target
        ? manualUmlEdgeGeometry(item.edge, source, target, content.layout.direction)
        : item;
      return {
        id: item.edge.id,
        type: "umlEdge",
        source: item.edge.source,
        target: item.edge.target,
        // A label dragged out of its slot may land over a card. React Flow renders each edge
        // in its own SVG, so lifting that one edge keeps the label the reviewer is placing
        // readable instead of hiding it behind the card.
        zIndex: movedLabels[item.edge.id] ? NUDGED_EDGE_Z_INDEX : undefined,
        data: {
          edge: item.edge,
          path: geometry.path,
          points: geometry.points,
          label: geometry.label,
          labelOffset: movedLabels[item.edge.id] ?? ORIGIN,
          onLabelMove: moveLabel,
        },
        ariaLabel: item.edge.label ?? item.edge.relation,
        focusable: false,
        selectable: true,
      };
    });
  }, [content.layout.direction, layout.result, liveBoxes, movedLabels, moveLabel]);

  const applyNodeChanges = useCallback((changes: NodeChange<UmlCanvasNode>[]) => {
    setMovedNodes(current => {
      let next = current;
      for (const change of changes) {
        if (change.type !== "position" || !change.position) continue;
        next = next === current ? { ...current } : next;
        next[change.id] = change.position;
      }
      return next;
    });
  }, []);

  const resetLayout = useCallback(() => {
    setMovedNodes({});
    setMovedLabels({});
  }, []);

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
          nodesDraggable
          nodesFocusable={false}
          onInit={setFlow}
          onNodesChange={applyNodeChanges}
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
            <button
              data-reset-layout=""
              disabled={Object.keys(movedNodes).length + Object.keys(movedLabels).length === 0}
              onClick={resetLayout}
              title="Restore the computed layout"
              type="button"
            >
              <RotateCcw aria-hidden="true" size={17} />
              <span className="sr-only">Restore the computed layout</span>
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
