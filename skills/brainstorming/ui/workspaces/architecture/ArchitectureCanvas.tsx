import {
  Background,
  BackgroundVariant,
  MiniMap,
  ReactFlow,
  type ReactFlowInstance,
} from "@xyflow/react";
import {
  Focus,
  Minus,
  Route,
  Scan,
  Plus,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

import {
  ArchitectureEdgeView,
  ArchitectureNodeView,
  OwnershipBoundaryView,
  type ArchitectureCanvasNode,
  type ArchitectureFlowEdge,
} from "./architecture-nodes";
import {
  layoutArchitecture,
  type ArchitectureLayoutResult,
  type ArchitectureMode,
  type ArchitectureWorkspaceContent,
} from "./architecture-layout";

interface ArchitectureCanvasProps {
  content: Record<string, unknown>;
}

interface LayoutState {
  status: "loading" | "ready" | "error";
  result: ArchitectureLayoutResult | null;
  error: string | null;
}

const NODE_TYPES = {
  architectureNode: ArchitectureNodeView,
  ownershipBoundary: OwnershipBoundaryView,
};

const EDGE_TYPES = {
  architectureEdge: ArchitectureEdgeView,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function architectureContent(value: Record<string, unknown>): ArchitectureWorkspaceContent | null {
  if (
    !isRecord(value.layout_direction)
    || !isRecord(value.layout)
    || !isRecord(value.camera)
    || value.layout.engine !== "elk"
    || value.layout.stable_across_modes !== true
    || (value.initial_mode !== "current" && value.initial_mode !== "proposed")
    || !Array.isArray(value.ownership_boundaries)
    || !Array.isArray(value.nodes)
    || !Array.isArray(value.edges)
    || !Array.isArray(value.scenarios)
    || !Array.isArray(value.focus_targets)
    || !Array.isArray(value.annotation_targets)
  ) return null;
  return value as unknown as ArchitectureWorkspaceContent;
}

function titleCaseType(value: string): string {
  return value.replaceAll("_", " ").replace(/^./u, first => first.toUpperCase());
}

export function ArchitectureCanvas({ content }: ArchitectureCanvasProps) {
  const parsed = useMemo(() => architectureContent(content), [content]);
  const [mode, setMode] = useState<ArchitectureMode>(() => parsed?.initial_mode ?? "proposed");
  const [scenarioId, setScenarioId] = useState<string>(() => parsed?.scenarios[0]?.id ?? "");
  const [focusedId, setFocusedId] = useState<string | null>(() => parsed?.focus_targets[0] ?? null);
  const [flow, setFlow] = useState<ReactFlowInstance<ArchitectureCanvasNode, ArchitectureFlowEdge> | null>(null);
  const [layout, setLayout] = useState<LayoutState>({ status: "loading", result: null, error: null });
  const modeTabs = useRef(new Map<ArchitectureMode, HTMLButtonElement>());
  const initialViewApplied = useRef(false);

  useEffect(() => {
    if (!parsed) return;
    setMode(parsed.initial_mode);
    setScenarioId(parsed.scenarios[0]?.id ?? "");
    setFocusedId(parsed.focus_targets[0] ?? null);
    initialViewApplied.current = false;
    let active = true;
    setLayout({ status: "loading", result: null, error: null });
    void layoutArchitecture(parsed).then(
      result => {
        if (active) setLayout({ status: "ready", result, error: null });
      },
      error => {
        if (!active) return;
        setLayout({
          status: "error",
          result: null,
          error: error instanceof Error ? error.message : "ELK layout failed.",
        });
      },
    );
    return () => {
      active = false;
    };
  }, [parsed]);

  const activeScenario = parsed?.scenarios.find(scenario => scenario.id === scenarioId) ?? null;
  const scenarioPath = activeScenario?.paths[mode] ?? null;
  const scenarioNodeIds = useMemo(() => new Set(scenarioPath?.node_ids ?? []), [scenarioPath]);
  const scenarioEdgeIds = useMemo(() => new Set(scenarioPath?.edge_ids ?? []), [scenarioPath]);
  const scenarioPathIdentity = parsed?.annotation_targets.find(id => scenarioEdgeIds.has(id))
    ?? scenarioPath?.edge_ids[0]
    ?? null;

  useEffect(() => {
    const target = layout.result?.nodes.find(item => item.node.id === parsed?.focus_targets[0]);
    if (
      !flow
      || layout.status !== "ready"
      || initialViewApplied.current
      || !target
    ) return;
    initialViewApplied.current = true;
    const frame = requestAnimationFrame(() => {
      void flow.setCenter(
        target.absolutePosition.x + target.width / 2,
        target.absolutePosition.y + target.height / 2,
        { zoom: parsed?.camera.default_zoom ?? 0.8, duration: 0 },
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [flow, layout.result, layout.status, parsed]);

  const visibleNodes = useMemo<ArchitectureCanvasNode[]>(() => {
    if (!layout.result) return [];
    const boundaries: ArchitectureCanvasNode[] = layout.result.boundaries.map(item => ({
      id: item.boundary.id,
      type: "ownershipBoundary",
      parentId: item.boundary.parent_id ?? undefined,
      position: item.position,
      data: {
        boundary: item.boundary,
        focused: focusedId === item.boundary.id,
      },
      ariaLabel: item.boundary.label,
      focusable: false,
      selectable: true,
      draggable: false,
      style: { width: item.width, height: item.height },
    }));
    const nodes: ArchitectureCanvasNode[] = layout.result.nodes
      .filter(item => item.node.modes.includes(mode))
      .map(item => ({
        id: item.node.id,
        type: "architectureNode",
        parentId: item.node.owner_id,
        extent: "parent",
        position: item.position,
        data: {
          node: item.node,
          focused: focusedId === item.node.id,
          scenario: scenarioNodeIds.has(item.node.id),
          scenarioId: activeScenario?.id ?? null,
        },
        ariaLabel: `${item.node.label}, ${titleCaseType(item.node.type)}`,
        focusable: false,
        selectable: true,
        draggable: false,
        style: { width: item.width, height: item.height },
      }));
    return [...boundaries, ...nodes];
  }, [activeScenario?.id, focusedId, layout.result, mode, scenarioNodeIds]);

  const visibleEdges = useMemo<ArchitectureFlowEdge[]>(() => {
    if (!layout.result) return [];
    return layout.result.edges
      .filter(item => item.edge.modes.includes(mode))
      .map(item => ({
        id: item.edge.id,
        type: "architectureEdge",
        source: item.edge.source.node_id,
        sourceHandle: item.edge.source.port_id,
        target: item.edge.target.node_id,
        targetHandle: item.edge.target.port_id,
        data: {
          edge: item.edge,
          path: item.path,
          routePoints: item.points.length,
          scenario: scenarioEdgeIds.has(item.edge.id),
          scenarioId: activeScenario?.id ?? null,
          scenarioPathIdentity: item.edge.id === scenarioPathIdentity,
        },
        ariaLabel: `${item.edge.type} ${item.edge.id}`,
        focusable: false,
        selectable: true,
      }));
  }, [activeScenario?.id, layout.result, mode, scenarioEdgeIds, scenarioPathIdentity]);
  if (!parsed) {
    return <p className="workspace-error" role="alert">Architecture Workspace content is invalid.</p>;
  }

  const nodeById = new Map(parsed.nodes.map(node => [node.id, node]));
  const boundaryById = new Map(parsed.ownership_boundaries.map(boundary => [boundary.id, boundary]));
  const focusedNode = focusedId ? nodeById.get(focusedId) : undefined;
  const focusedBoundary = focusedId ? boundaryById.get(focusedId) : undefined;

  const selectMode = (nextMode: ArchitectureMode): void => {
    setMode(nextMode);
  };

  const moveMode = (event: KeyboardEvent<HTMLButtonElement>, direction: -1 | 1): void => {
    event.preventDefault();
    const nextMode: ArchitectureMode = direction < 0 ? "current" : "proposed";
    selectMode(nextMode);
    modeTabs.current.get(nextMode)?.focus();
  };

  const focusTarget = (id: string): void => {
    setFocusedId(id);
    if (!flow) return;
    const target = layout.result?.nodes.find(item => item.node.id === id);
    if (target) {
      void flow.setCenter(
        target.absolutePosition.x + target.width / 2,
        target.absolutePosition.y + target.height / 2,
        { zoom: Math.min(parsed.camera.default_zoom, 1.15), duration: 0 },
      );
      return;
    }
    void flow.fitView({
      nodes: [{ id }],
      padding: 0.45,
      duration: 0,
      maxZoom: 1.15,
    });
  };

  const fitScenario = (): void => {
    if (!flow || scenarioNodeIds.size === 0) return;
    void flow.fitView({
      nodes: [...scenarioNodeIds].map(id => ({ id })),
      padding: 0.35,
      duration: 0,
      maxZoom: 1,
    });
  };

  const handleGraphKeys = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      void flow?.zoomIn({ duration: 0 });
    } else if (event.key === "-") {
      event.preventDefault();
      void flow?.zoomOut({ duration: 0 });
    }
  };

  return (
    <section
      className="architecture-canvas"
      data-architecture-canvas=""
      data-layout-edge-count={parsed.edges.length}
      data-layout-engine={parsed.layout.engine}
      data-layout-node-count={parsed.nodes.length}
      data-layout-status={layout.status}
    >
      <header className="architecture-canvas-header">
        <div>
          <span className="architecture-kicker">Architecture Canvas</span>
          <h2>Runtime topology</h2>
        </div>
        <div aria-label="Architecture state" className="architecture-state-tabs" role="tablist">
          {(["current", "proposed"] as const).map(candidate => (
            <button
              aria-controls="architecture-topology"
              aria-selected={candidate === mode}
              className="architecture-state-tab"
              key={candidate}
              onClick={() => selectMode(candidate)}
              onKeyDown={event => {
                if (event.key === "ArrowLeft") moveMode(event, -1);
                if (event.key === "ArrowRight") moveMode(event, 1);
              }}
              ref={element => {
                if (element) modeTabs.current.set(candidate, element);
                else modeTabs.current.delete(candidate);
              }}
              role="tab"
              tabIndex={candidate === mode ? 0 : -1}
              type="button"
            >
              {candidate === "current" ? "Current" : "Proposed"}
            </button>
          ))}
        </div>
      </header>

      <div className="architecture-tools">
        <label className="architecture-scenario">
          <Route aria-hidden="true" size={16} />
          <span>Scenario</span>
          <select onChange={event => setScenarioId(event.target.value)} value={scenarioId}>
            {parsed.scenarios.map(scenario => (
              <option key={scenario.id} value={scenario.id}>{scenario.label}</option>
            ))}
          </select>
        </label>
        <div aria-label="Camera controls" className="architecture-camera-controls" data-camera-controls="" role="toolbar">
          <button onClick={() => void flow?.zoomIn({ duration: 0 })} title="Zoom in" type="button">
            <Plus aria-hidden="true" size={17} />
            <span className="sr-only">Zoom in</span>
          </button>
          <button onClick={() => void flow?.zoomOut({ duration: 0 })} title="Zoom out" type="button">
            <Minus aria-hidden="true" size={17} />
            <span className="sr-only">Zoom out</span>
          </button>
          <button
            onClick={() => void flow?.fitView({ padding: parsed.camera.fit_padding, duration: 0 })}
            title="Fit view"
            type="button"
          >
            <Scan aria-hidden="true" size={17} />
            <span className="sr-only">Fit view</span>
          </button>
          <button onClick={fitScenario} title="Fit scenario" type="button">
            <Route aria-hidden="true" size={17} />
            <span className="sr-only">Fit scenario</span>
          </button>
        </div>
        <nav aria-label="Focus targets" className="architecture-focus-targets">
          {parsed.focus_targets.map(id => {
            const label = nodeById.get(id)?.label ?? boundaryById.get(id)?.label ?? id;
            return (
              <button aria-pressed={focusedId === id} key={id} onClick={() => focusTarget(id)} type="button">
                <Focus aria-hidden="true" size={15} />
                <span>Focus {label}</span>
              </button>
            );
          })}
        </nav>
      </div>

      <div className="architecture-stage">
        <div
          aria-label="Architecture topology viewport"
          className="architecture-viewport"
          data-architecture-viewport=""
          data-mode={mode}
          id="architecture-topology"
          onKeyDown={handleGraphKeys}
          role="region"
          tabIndex={0}
        >
          {layout.status === "loading" ? (
            <div className="architecture-layout-message" role="status">Computing topology layout...</div>
          ) : layout.status === "error" ? (
            <div className="architecture-layout-message" role="alert">{layout.error}</div>
          ) : (
            <ReactFlow<ArchitectureCanvasNode, ArchitectureFlowEdge>
              aria-label="Architecture topology graph"
              edges={visibleEdges}
              edgeTypes={EDGE_TYPES}
              edgesFocusable={false}
              elementsSelectable
              maxZoom={parsed.camera.max_zoom}
              minZoom={parsed.camera.min_zoom}
              nodeTypes={NODE_TYPES}
              nodes={visibleNodes}
              nodesConnectable={false}
              nodesDraggable={false}
              nodesFocusable={false}
              onEdgeClick={(_, edge) => setFocusedId(edge.id)}
              onInit={setFlow}
              onNodeClick={(_, node) => setFocusedId(node.id)}
              onlyRenderVisibleElements={false}
              panOnDrag
              preventScrolling
              proOptions={{ hideAttribution: true }}
              zoomOnDoubleClick={false}
            >
              <Background color="#cbd4dd" gap={28} size={1} variant={BackgroundVariant.Dots} />
              <div className="architecture-minimap-shell" data-architecture-minimap="">
                <MiniMap
                  ariaLabel="Architecture minimap"
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

        <aside aria-label="Architecture inspector" className="architecture-inspector" data-architecture-inspector="">
          <span className="architecture-kicker">Inspector</span>
          {focusedNode ? (
            <>
              <h3>{focusedNode.label}</h3>
              <dl>
                <div><dt>Type</dt><dd>{titleCaseType(focusedNode.type)}</dd></div>
                <div><dt>Owner</dt><dd>{boundaryById.get(focusedNode.owner_id)?.label ?? focusedNode.owner_id}</dd></div>
                <div><dt>Change</dt><dd>{titleCaseType(focusedNode.change)}</dd></div>
              </dl>
            </>
          ) : focusedBoundary ? (
            <>
              <h3>{focusedBoundary.label}</h3>
              <dl>
                <div><dt>Kind</dt><dd>Ownership boundary</dd></div>
                <div><dt>Parent</dt><dd>{focusedBoundary.parent_id ? boundaryById.get(focusedBoundary.parent_id)?.label : "Root"}</dd></div>
              </dl>
            </>
          ) : (
            <>
              <h3>Topology detail</h3>
              <p>Select a focus target or topology element.</p>
            </>
          )}
          {activeScenario ? (
            <div className="architecture-scenario-summary">
              <Route aria-hidden="true" size={15} />
              <p><strong>{activeScenario.label}</strong>{activeScenario.description}</p>
            </div>
          ) : null}
        </aside>
      </div>
    </section>
  );
}
