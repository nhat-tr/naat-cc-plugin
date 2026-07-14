import {
  Background,
  BackgroundVariant,
  MarkerType,
  MiniMap,
  ReactFlow,
  type ReactFlowInstance,
} from "@xyflow/react";
import {
  ArrowRight,
  Eye,
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

import { PaneSeparator } from "../../shared/PaneSeparator";

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
  type ArchitectureEdgeType,
  type ArchitectureWorkspaceContent,
} from "./architecture-layout";
import {
  architecturePresentation,
  defaultArchitecturePresentationScope,
  type ArchitecturePresentationScope,
} from "./architecture-presentation";

interface ArchitectureCanvasProps {
  content: Record<string, unknown>;
  onPresentedComponentIdsChange?: (componentIds: string[]) => void;
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

const EDGE_COLORS: Record<ArchitectureEdgeType, string> = {
  command: "#356494",
  control: "#87517e",
  data: "#2f7667",
  event: "#8c641b",
  evidence: "#8b4d47",
};
const SCENARIO_EDGE_COLOR = "#bc7900";
const VIEWPORT_HEIGHT_MIN = 320;
const VIEWPORT_HEIGHT_LIMIT = 900;
const VIEWPORT_HEIGHT_STORAGE_KEY = "visual-companion:architecture-viewport-height:v1";

interface ViewportHeightBounds {
  defaultValue: number;
  max: number;
  min: number;
}

interface InitialViewportHeight {
  bounds: ViewportHeightBounds;
  userSized: boolean;
  value: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function viewportHeightBounds(): ViewportHeightBounds {
  const compact = window.matchMedia("(max-width: 760px)").matches;
  const available = window.innerHeight - (compact ? 220 : 180);
  const max = Math.max(VIEWPORT_HEIGHT_MIN, Math.min(VIEWPORT_HEIGHT_LIMIT, Math.round(available)));
  return {
    defaultValue: clamp(
      Math.round(window.innerHeight * (compact ? 0.58 : 0.68)),
      VIEWPORT_HEIGHT_MIN,
      max,
    ),
    max,
    min: VIEWPORT_HEIGHT_MIN,
  };
}

function readStoredViewportHeight(): number | null {
  try {
    const value = Number.parseInt(localStorage.getItem(VIEWPORT_HEIGHT_STORAGE_KEY) ?? "", 10);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function storeViewportHeight(value: number): void {
  try {
    localStorage.setItem(VIEWPORT_HEIGHT_STORAGE_KEY, String(Math.round(value)));
  } catch {
    // Standalone file origins may not expose browser storage.
  }
}

function initialViewportHeight(): InitialViewportHeight {
  const bounds = viewportHeightBounds();
  const stored = readStoredViewportHeight();
  return {
    bounds,
    userSized: stored !== null,
    value: clamp(stored ?? bounds.defaultValue, bounds.min, bounds.max),
  };
}

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

export function ArchitectureCanvas({ content, onPresentedComponentIdsChange }: ArchitectureCanvasProps) {
  const parsed = useMemo(() => architectureContent(content), [content]);
  const [initialViewport] = useState(initialViewportHeight);
  const userSizedViewport = useRef(initialViewport.userSized);
  const [mode, setMode] = useState<ArchitectureMode>(() => parsed?.initial_mode ?? "proposed");
  const [scenarioId, setScenarioId] = useState<string>(() => parsed?.scenarios[0]?.id ?? "");
  const [focusedId, setFocusedId] = useState<string | null>(() => parsed?.focus_targets[0] ?? null);
  const [presentationScope, setPresentationScope] = useState<ArchitecturePresentationScope>(() => (
    parsed ? defaultArchitecturePresentationScope(parsed) : "all"
  ));
  const [flow, setFlow] = useState<ReactFlowInstance<ArchitectureCanvasNode, ArchitectureFlowEdge> | null>(null);
  const [layout, setLayout] = useState<LayoutState>({ status: "loading", result: null, error: null });
  const [viewportBounds, setViewportBounds] = useState(initialViewport.bounds);
  const [viewportHeight, setViewportHeight] = useState(initialViewport.value);
  const modeTabs = useRef(new Map<ArchitectureMode, HTMLButtonElement>());
  const initialViewApplied = useRef(false);

  useEffect(() => {
    const updateBounds = (): void => {
      const next = viewportHeightBounds();
      setViewportBounds(next);
      setViewportHeight(current => clamp(
        userSizedViewport.current ? current : next.defaultValue,
        next.min,
        next.max,
      ));
    };
    window.addEventListener("resize", updateBounds);
    return () => window.removeEventListener("resize", updateBounds);
  }, []);

  useEffect(() => {
    if (!parsed) return;
    setMode(parsed.initial_mode);
    setScenarioId(parsed.scenarios[0]?.id ?? "");
    setFocusedId(parsed.focus_targets[0] ?? null);
    setPresentationScope(defaultArchitecturePresentationScope(parsed));
  }, [parsed]);

  const activeScenario = parsed?.scenarios.find(scenario => scenario.id === scenarioId) ?? null;
  const scenarioPath = activeScenario?.paths[mode] ?? null;
  const scenarioNodeIds = useMemo(() => new Set(scenarioPath?.node_ids ?? []), [scenarioPath]);
  const scenarioEdgeIds = useMemo(() => new Set(scenarioPath?.edge_ids ?? []), [scenarioPath]);
  const scenarioStartId = scenarioPath?.node_ids[0] ?? null;
  const scenarioEndId = scenarioPath?.node_ids.at(-1) ?? null;
  const scenarioPathIdentity = parsed?.annotation_targets.find(id => scenarioEdgeIds.has(id))
    ?? scenarioPath?.edge_ids[0]
    ?? null;
  const presentationFocusedId = presentationScope === "selected" ? focusedId : null;
  const presentation = useMemo(() => (
    parsed
      ? architecturePresentation(parsed, mode, presentationScope, activeScenario, presentationFocusedId)
      : null
  ), [activeScenario, mode, parsed, presentationFocusedId, presentationScope]);
  const layoutContent = presentation?.content ?? null;

  useEffect(() => {
    if (!layoutContent) return;
    initialViewApplied.current = false;
    let active = true;
    setLayout({ status: "loading", result: null, error: null });
    void layoutArchitecture(layoutContent).then(
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
  }, [layoutContent]);

  useEffect(() => {
    const result = layout.result;
    if (
      !flow
      || layout.status !== "ready"
      || initialViewApplied.current
      || !result
    ) return;
    initialViewApplied.current = true;
    const frame = requestAnimationFrame(() => {
      if (presentationScope !== "all") {
        void flow.fitView({
          nodes: result.nodes.map(item => ({ id: item.node.id })),
          padding: 0.35,
          duration: 0,
          maxZoom: 1.1,
        });
        return;
      }
      const target = result.nodes.find(item => item.node.id === parsed?.focus_targets[0]);
      if (!target) return;
      void flow.setCenter(
        target.absolutePosition.x + target.width / 2,
        target.absolutePosition.y + target.height / 2,
        { zoom: parsed?.camera.default_zoom ?? 0.8, duration: 0 },
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [flow, layout.result, layout.status, parsed, presentationScope]);

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
      .map(item => {
        const scenarioStart = item.node.id === scenarioStartId;
        const scenarioEnd = item.node.id === scenarioEndId;
        const endpointLabel = scenarioStart && scenarioEnd
          ? "Scenario start and end"
          : scenarioStart
            ? "Scenario start"
            : scenarioEnd
              ? "Scenario end"
              : null;
        return {
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
            scenarioEnd,
            scenarioStart,
          },
          ariaLabel: [item.node.label, titleCaseType(item.node.type), endpointLabel].filter(Boolean).join(", "),
          focusable: false,
          selectable: true,
          draggable: false,
          style: { width: item.width, height: item.height },
        };
      });
    return [...boundaries, ...nodes];
  }, [
    activeScenario?.id,
    focusedId,
    layout.result,
    mode,
    scenarioEndId,
    scenarioNodeIds,
    scenarioStartId,
  ]);

  const visibleEdges = useMemo<ArchitectureFlowEdge[]>(() => {
    if (!layout.result) return [];
    return layout.result.edges
      .filter(item => item.edge.modes.includes(mode))
      .map(item => {
        const scenario = scenarioEdgeIds.has(item.edge.id);
        return {
          id: item.edge.id,
          type: "architectureEdge",
          source: item.edge.source.node_id,
          sourceHandle: item.edge.source.port_id,
          target: item.edge.target.node_id,
          targetHandle: item.edge.target.port_id,
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: scenario ? SCENARIO_EDGE_COLOR : EDGE_COLORS[item.edge.type],
            width: 14,
            height: 14,
          },
          data: {
            edge: item.edge,
            path: item.path,
            routePoints: item.points.length,
            scenario,
            scenarioId: activeScenario?.id ?? null,
            scenarioPathIdentity: item.edge.id === scenarioPathIdentity,
          },
          ariaLabel: `${item.edge.type} ${item.edge.id}`,
          focusable: false,
          selectable: true,
        };
      });
  }, [activeScenario?.id, layout.result, mode, scenarioEdgeIds, scenarioPathIdentity]);

  const presentedComponentIds = useMemo(() => {
    if (!parsed) return [];
    const annotationTargets = new Set(parsed.annotation_targets);
    const candidates = [activeScenario?.component_id];
    if (layout.status === "ready" && layout.result) {
      candidates.push(
        ...layout.result.boundaries.map(item => item.boundary.component_id),
        ...layout.result.nodes
          .filter(item => item.node.modes.includes(mode))
          .flatMap(item => [
            item.node.component_id,
            ...(item.node.points ?? []).map((_point, index) => `${item.node.component_id}-p${index + 1}`),
          ]),
        ...layout.result.edges
          .filter(item => item.edge.modes.includes(mode))
          .map(item => item.edge.component_id),
      );
    }
    return [...new Set(candidates.filter(
      (id): id is string => typeof id === "string" && annotationTargets.has(id),
    ))].sort();
  }, [activeScenario?.component_id, layout.result, layout.status, mode, parsed]);

  useEffect(() => {
    if (layout.status !== "ready") return;
    onPresentedComponentIdsChange?.(presentedComponentIds);
  }, [layout.status, onPresentedComponentIdsChange, presentedComponentIds]);

  if (!parsed) {
    return <p className="workspace-error" role="alert">Architecture Workspace content is invalid.</p>;
  }

  const nodeById = new Map(parsed.nodes.map(node => [node.id, node]));
  const boundaryById = new Map(parsed.ownership_boundaries.map(boundary => [boundary.id, boundary]));
  const focusedNode = focusedId ? nodeById.get(focusedId) : undefined;
  const focusedBoundary = focusedId ? boundaryById.get(focusedId) : undefined;
  const scenarioStartLabel = scenarioStartId ? nodeById.get(scenarioStartId)?.label ?? scenarioStartId : "Unavailable";
  const scenarioEndLabel = scenarioEndId ? nodeById.get(scenarioEndId)?.label ?? scenarioEndId : "Unavailable";

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
    if (presentationScope !== "scenario") {
      setPresentationScope("scenario");
      return;
    }
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

  const commitViewportHeight = (value: number): void => {
    userSizedViewport.current = true;
    storeViewportHeight(value);
  };

  return (
    <section
      className="architecture-canvas"
      data-architecture-canvas=""
      data-layout-edge-count={parsed.edges.length}
      data-layout-engine={parsed.layout.engine}
      data-layout-node-count={parsed.nodes.length}
      data-layout-status={layout.status}
      data-presentation-scope={presentationScope}
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
        <label className="architecture-show">
          <Eye aria-hidden="true" size={16} />
          <span>Show</span>
          <select
            aria-label="Show"
            onChange={event => setPresentationScope(event.target.value as ArchitecturePresentationScope)}
            value={presentationScope}
          >
            <option value="all">All Components</option>
            <option value="scenario">Scenario Path</option>
            <option value="selected">Selected Component</option>
          </select>
        </label>
        <label className="architecture-scenario">
          <Route aria-hidden="true" size={16} />
          <span>Scenario</span>
          <select
            onChange={event => {
              setScenarioId(event.target.value);
              setPresentationScope("scenario");
            }}
            value={scenarioId}
          >
            {parsed.scenarios.map(scenario => (
              <option key={scenario.id} value={scenario.id}>{scenario.label}</option>
            ))}
          </select>
        </label>
        <div
          aria-label="Scenario Path start and end"
          className="architecture-scenario-direction"
          role="group"
        >
          <span data-scenario-start-id={scenarioStartId ?? undefined}>
            <strong>Start</strong>
            <span title={scenarioStartLabel}>{scenarioStartLabel}</span>
          </span>
          <ArrowRight aria-hidden="true" size={16} />
          <span data-scenario-end-id={scenarioEndId ?? undefined}>
            <strong>End</strong>
            <span title={scenarioEndLabel}>{scenarioEndLabel}</span>
          </span>
        </div>
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
        <div className="architecture-viewport-stack">
          <div
            aria-label="Architecture topology viewport"
            className="architecture-viewport"
            data-architecture-viewport=""
            data-mode={mode}
            id="architecture-topology"
            onKeyDown={handleGraphKeys}
            role="region"
            style={{ height: viewportHeight }}
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
          <PaneSeparator
            aria-controls="architecture-topology"
            className="architecture-viewport-separator"
            label="Architecture viewport height"
            max={viewportBounds.max}
            min={viewportBounds.min}
            onChange={setViewportHeight}
            onCommit={commitViewportHeight}
            orientation="horizontal"
            resizeSide="before"
            value={viewportHeight}
            valueText={`Architecture viewport ${Math.round(viewportHeight)} pixels high`}
          />
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
            <div
              className="architecture-scenario-summary"
              data-brainstorm-id={activeScenario.component_id}
              data-brainstorm-label={activeScenario.label}
            >
              <Route aria-hidden="true" size={15} />
              <p><strong>{activeScenario.label}</strong>{activeScenario.description}</p>
            </div>
          ) : null}
        </aside>
      </div>
    </section>
  );
}
