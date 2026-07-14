import { Download, RefreshCw } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";

import { FeedbackPanel, type FeedbackComponentOption, type PresentedFeedbackThread } from "../shared/FeedbackPanel";
import { PaneSeparator } from "../shared/PaneSeparator";
import {
  type Annotation,
  type FeedbackDraft,
  type FeedbackThread,
  type FeedbackThreadStatus,
  type SessionEvent,
  type SessionSnapshot,
  annotationSummary,
  computeComponentChanges,
  createClientTurnId,
  deriveCommittedChoices,
  deriveFeedbackThreadState,
  emptySessionSnapshot,
  groupAnnotationsByComponent,
  mergeChoiceState,
  normalizeFeedbackDraft,
  readResponseError,
  reconcileChoices,
} from "./feedback-store";
import {
  type DeliveryConnection,
  type DeliveryEvidence,
  connectVisualSessionEvents,
  deriveBrowserDeliveryState,
  loadVisualSessionState,
} from "./session-client";
import {
  WorkspaceHost,
  embeddedLegacyDocument,
  type LegacyVisualDocument,
  type WorkspaceEnvelope,
} from "./WorkspaceHost";

type VisualDocument = WorkspaceEnvelope | LegacyVisualDocument;
type Density = "comfortable" | "compact";

const INTERACTIVE_DESCENDANT_SELECTOR = [
  "button",
  "a[href]",
  "input",
  "select",
  "textarea",
  "summary",
  '[contenteditable="true"]',
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="tab"]',
  '[role="treeitem"]',
].join(", ");

interface EmbeddedVisualState {
  screen: unknown;
  session: unknown;
  readOnly?: boolean;
}

declare global {
  interface Window {
    __BRAINSTORM_EMBEDDED__?: EmbeddedVisualState;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asVisualDocument(value: unknown): VisualDocument {
  if (!isRecord(value)) throw new TypeError("Visual Document response must be an object");
  if (value.version === 1 && typeof value.title === "string" && Array.isArray(value.sections)) {
    return value as unknown as LegacyVisualDocument;
  }
  if (
    value.version === 2
    && typeof value.work_id === "string"
    && typeof value.workspace_kind === "string"
    && typeof value.title === "string"
    && typeof value.revision === "string"
    && Array.isArray(value.frames)
    && Array.isArray(value.components)
    && Array.isArray(value.decisions)
    && Array.isArray(value.feedback_threads)
    && isRecord(value.content)
  ) {
    return value as unknown as WorkspaceEnvelope;
  }
  throw new TypeError("Visual Document response has an unsupported version or shape");
}

function asSessionSnapshot(value: unknown): SessionSnapshot {
  if (!isRecord(value) || !Array.isArray(value.events)) return emptySessionSnapshot();
  return { events: value.events.filter(isRecord) as SessionEvent[] };
}

function legacyRevision(value: LegacyVisualDocument): string {
  const json = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < json.length; index += 1) {
    hash ^= json.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function documentRevision(value: VisualDocument): string {
  return value.version === 2 ? value.revision : legacyRevision(value);
}

function titleCase(value: string): string {
  return value.length > 0 ? value[0]!.toUpperCase() + value.slice(1) : value;
}

function workspaceFrames(value: VisualDocument): Array<{ id: string; title: string; component_ids: string[] }> {
  if (value.version === 2) return value.frames;
  return value.sections.map(section => ({
    id: typeof section.id === "string" ? section.id : "frame",
    title: typeof section.title === "string" ? section.title : "Frame",
    component_ids: [],
  }));
}

function componentOptions(value: VisualDocument): FeedbackComponentOption[] {
  if (value.version === 2) return value.components.map(component => ({ id: component.id, label: component.label }));
  const result: FeedbackComponentOption[] = [];
  for (const section of value.sections) {
    const sectionId = typeof section.id === "string" ? section.id : "";
    const sectionTitle = typeof section.title === "string" ? section.title : sectionId;
    if (sectionId) result.push({ id: sectionId, label: sectionTitle });
    for (const collection of [section.items, section.nodes, section.regions, section.options]) {
      if (!Array.isArray(collection)) continue;
      for (const child of collection) {
        if (!isRecord(child) || typeof child.id !== "string") continue;
        const label = typeof child.title === "string" ? child.title : typeof child.label === "string" ? child.label : child.id;
        result.push({ id: child.id, label });
        if (Array.isArray(child.points)) {
          child.points.forEach((_point, index) => result.push({
            id: `${child.id}-p${index + 1}`,
            label: `${label} · point ${index + 1}`,
          }));
        }
        if (Array.isArray(child.elements)) {
          child.elements.forEach((element, index) => result.push({
            id: `${child.id}-e${index + 1}`,
            label: `${label} · ${isRecord(element) && typeof element.kind === "string" ? element.kind : "element"} ${index + 1}`,
          }));
        }
      }
    }
  }
  return result;
}

function choiceGroupModes(value: VisualDocument | null): Record<string, boolean> {
  const modes: Record<string, boolean> = {};
  if (!value) return modes;
  if (value.version === 2) {
    for (const decision of value.decisions) modes[decision.id] = decision.multiselect;
  }
  const legacy = embeddedLegacyDocument(value);
  for (const section of legacy?.sections ?? []) {
    if (section.kind !== "decision") continue;
    const groupId = typeof section.groupId === "string"
      ? section.groupId
      : typeof section.id === "string" ? section.id : "";
    if (groupId) modes[groupId] = section.multiselect === true;
  }
  return modes;
}

function feedbackThreads(value: VisualDocument): FeedbackThread[] {
  if (value.version !== 2) return [];
  return value.feedback_threads.flatMap(candidate => {
    if (!isRecord(candidate)) return [];
    const status = candidate.status;
    if (status !== "open" && status !== "resolved" && status !== "outdated") return [];
    if (
      typeof candidate.id !== "string"
      || typeof candidate.component_id !== "string"
      || typeof candidate.revision !== "string"
      || typeof candidate.type !== "string"
      || typeof candidate.comment !== "string"
      || !Array.isArray(candidate.replies)
    ) return [];
    return [{
      id: candidate.id,
      component_id: candidate.component_id,
      revision: candidate.revision,
      type: candidate.type,
      status,
      comment: candidate.comment,
      replies: candidate.replies.flatMap(reply => {
        if (!isRecord(reply)) return [];
        if (typeof reply.id !== "string" || typeof reply.author !== "string" || typeof reply.text !== "string" || typeof reply.recorded_at !== "string") return [];
        return [{ id: reply.id, author: reply.author, text: reply.text, recorded_at: reply.recorded_at }];
      }),
    }];
  });
}

function browserStorage(kind: "localStorage" | "sessionStorage"): Storage | null {
  try {
    return globalThis.window?.[kind] ?? null;
  } catch {
    return null;
  }
}

function safeStorageGet(kind: "localStorage" | "sessionStorage", key: string): string | null {
  try {
    return browserStorage(kind)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function safeStorageSet(kind: "localStorage" | "sessionStorage", key: string, value: string): void {
  try {
    browserStorage(kind)?.setItem(key, value);
  } catch {
    // Persistence is best-effort when the browser blocks storage for local files.
  }
}

const WORKSPACE_SPLIT_BREAKPOINT = 980;
const WORKSPACE_CANVAS_MIN = 320;
const WORKSPACE_FEEDBACK_DEFAULT = 352;
const WORKSPACE_FEEDBACK_MIN = 256;
const WORKSPACE_SEPARATOR_WIDTH = 12;

interface WorkspaceCanvasBounds {
  defaultValue: number;
  max: number;
  min: number;
}

type WorkspaceStyle = CSSProperties & { "--workspace-canvas-width": string };

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function subscribeToViewportWidth(onChange: () => void): () => void {
  globalThis.window?.addEventListener("resize", onChange);
  return () => globalThis.window?.removeEventListener("resize", onChange);
}

function viewportWidthSnapshot(): number {
  return globalThis.window?.innerWidth ?? 1_280;
}

function serverViewportWidthSnapshot(): number {
  return 1_280;
}

function workspaceCanvasBounds(viewportWidth: number): WorkspaceCanvasBounds {
  const max = Math.max(
    WORKSPACE_CANVAS_MIN,
    viewportWidth - WORKSPACE_FEEDBACK_MIN - WORKSPACE_SEPARATOR_WIDTH,
  );
  return {
    defaultValue: clamp(
      viewportWidth - WORKSPACE_FEEDBACK_DEFAULT - WORKSPACE_SEPARATOR_WIDTH,
      WORKSPACE_CANVAS_MIN,
      max,
    ),
    max,
    min: WORKSPACE_CANVAS_MIN,
  };
}

export function VisualCompanionApp() {
  const embedded = globalThis.window?.__BRAINSTORM_EMBEDDED__;
  const initialDocument = embedded ? asVisualDocument(embedded.screen) : null;
  const basePath = document.body.dataset.basePath || "/";
  const viewportWidth = useSyncExternalStore(
    subscribeToViewportWidth,
    viewportWidthSnapshot,
    serverViewportWidthSnapshot,
  );
  const canvasBounds = workspaceCanvasBounds(viewportWidth);
  const [documentValue, setDocumentValue] = useState<VisualDocument | null>(initialDocument);
  const [session, setSession] = useState<SessionSnapshot>(() => embedded ? asSessionSnapshot(embedded.session) : emptySessionSnapshot());
  const [activeFrameId, setActiveFrameId] = useState(() => initialDocument ? workspaceFrames(initialDocument)[0]?.id ?? "" : "");
  const [changes, setChanges] = useState(() => computeComponentChanges(null, initialDocument));
  const [draft, setDraftState] = useState<FeedbackDraft>(() => normalizeFeedbackDraft());
  const [density, setDensityState] = useState<Density>("comfortable");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [deliveryEvidence, setDeliveryEvidence] = useState<DeliveryEvidence>({
    connection: embedded ? "closed" : "reconnecting",
    listening: false,
    durableSeq: null,
    deliveredThrough: 0,
    acknowledgedThrough: 0,
  });
  const [presentedComponents, setPresentedComponents] = useState<{ identity: string; ids: string[] }>({
    identity: "",
    ids: [],
  });
  const [annotationComponentId, setAnnotationComponentId] = useState("");
  const [workspaceCanvasWidth, setWorkspaceCanvasWidth] = useState(canvasBounds.defaultValue);
  const previousDocument = useRef<VisualDocument | null>(null);
  const workspaceCanvas = useRef<HTMLElement>(null);

  const identity = documentValue?.version === 2
    ? `${documentValue.work_id}:${location.origin}${basePath}`
    : `${location.origin}${basePath}`;
  const densityKey = `visual-density:${identity}`;
  const feedbackKey = `visual-feedback:${identity}`;
  const workspaceSplitKey = `visual-workspace-split:${identity}`;
  const readOnly = embedded?.readOnly === true || (documentValue?.version === 2 && documentValue.read_only);
  const frames = documentValue ? workspaceFrames(documentValue) : [];
  const effectiveFrameId = frames.some(frame => frame.id === activeFrameId)
    ? activeFrameId
    : frames[0]?.id ?? "";
  const presentationIdentity = documentValue?.version === 2
    ? `${documentValue.revision}:${effectiveFrameId}`
    : "";
  const allOptions = documentValue ? componentOptions(documentValue) : [];
  const activeComponentIds = documentValue?.version === 2
    ? new Set(documentValue.frames.find(frame => frame.id === effectiveFrameId)?.component_ids ?? [])
    : null;
  const reportedComponentIds = documentValue && embeddedLegacyDocument(documentValue)
    ? activeComponentIds ?? new Set<string>()
    : presentedComponents.identity === presentationIdentity
      ? new Set(presentedComponents.ids)
      : new Set<string>();
  const options = activeComponentIds
    ? allOptions.filter(component => activeComponentIds.has(component.id) && reportedComponentIds.has(component.id))
    : allOptions;
  const presentedAnnotationComponentId = options.some(component => component.id === annotationComponentId)
    ? annotationComponentId
    : "";
  const reportPresentedComponentIds = useCallback((componentIds: string[]): void => {
    const ids = [...new Set(componentIds)];
    setPresentedComponents(current => (
      current.identity === presentationIdentity
      && current.ids.length === ids.length
      && current.ids.every((id, index) => id === ids[index])
        ? current
        : { identity: presentationIdentity, ids }
    ));
  }, [presentationIdentity]);

  useEffect(() => {
    setAnnotationComponentId("");
  }, [presentationIdentity]);

  useEffect(() => {
    if (annotationComponentId && !presentedAnnotationComponentId) {
      setAnnotationComponentId("");
    }
  }, [annotationComponentId, presentedAnnotationComponentId]);

  useEffect(() => {
    const root = workspaceCanvas.current;
    if (!root) return;
    const applySelection = (): void => {
      root.querySelectorAll<HTMLElement>("[data-annotation-selected]")
        .forEach(element => element.removeAttribute("data-annotation-selected"));
      if (!presentedAnnotationComponentId) return;
      const selected = [...root.querySelectorAll<HTMLElement>("[data-brainstorm-id]")]
        .find(element => (
          element.dataset.brainstormId === presentedAnnotationComponentId
          && !element.closest("[hidden]")
        ));
      selected?.setAttribute("data-annotation-selected", "true");
    };
    applySelection();
    if (!presentedAnnotationComponentId) return;
    // React Flow replaces SVG edge children after click selection; reapply the shared marker.
    const observer = new MutationObserver(applySelection);
    observer.observe(root, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      root.querySelectorAll<HTMLElement>("[data-annotation-selected]")
        .forEach(element => element.removeAttribute("data-annotation-selected"));
    };
  }, [documentValue, effectiveFrameId, presentedAnnotationComponentId, presentedComponents]);

  useEffect(() => {
    const root = workspaceCanvas.current;
    if (!root) return;

    const clearMarkers = (): void => {
      root.querySelectorAll("[data-annotation-badge]").forEach(element => element.remove());
      root.querySelectorAll<HTMLElement | SVGElement>(".has-annotations").forEach(element => {
        element.classList.remove(
          "has-annotations",
          "has-pending-annotations",
          "has-committed-annotations",
        );
        element.removeAttribute("data-annotation-count");
        const originalTitle = element.getAttribute("data-annotation-original-title");
        if (originalTitle === null) element.removeAttribute("title");
        else element.setAttribute("title", originalTitle);
        element.removeAttribute("data-annotation-original-title");
      });
    };

    clearMarkers();
    const submitted = session.events.flatMap((event): Annotation[] => (
      event.role === "user" && Array.isArray(event.annotations) ? event.annotations : []
    ));
    const pendingByComponent = groupAnnotationsByComponent(draft.annotations);
    const submittedByComponent = groupAnnotationsByComponent(submitted);
    const componentIds = new Set([...submittedByComponent.keys(), ...pendingByComponent.keys()]);

    for (const componentId of componentIds) {
      const target = [...root.querySelectorAll<HTMLElement | SVGGraphicsElement>("[data-brainstorm-id]")]
        .find(element => element.dataset.brainstormId === componentId && !element.closest("[hidden]"));
      if (!target) continue;
      const pending = pendingByComponent.get(componentId) ?? [];
      const combined = [...(submittedByComponent.get(componentId) ?? []), ...pending];
      const summary = annotationSummary(combined);
      const originalTitle = target.getAttribute("title");
      if (originalTitle !== null) target.setAttribute("data-annotation-original-title", originalTitle);
      target.classList.add(
        "has-annotations",
        pending.length > 0 ? "has-pending-annotations" : "has-committed-annotations",
      );
      target.setAttribute("data-annotation-count", String(combined.length));
      target.setAttribute("title", summary);

      if (target instanceof SVGGraphicsElement) {
        const bounds = target.getBBox();
        const marker = document.createElementNS("http://www.w3.org/2000/svg", "g");
        marker.classList.add("annotation-badge-svg");
        marker.setAttribute("data-annotation-badge", "true");
        marker.setAttribute("aria-label", summary);
        marker.setAttribute("transform", `translate(${bounds.x + bounds.width}, ${bounds.y})`);
        const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        circle.setAttribute("r", "10");
        const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
        label.textContent = String(combined.length);
        marker.append(circle, label);
        target.append(marker);
      } else {
        const marker = document.createElement("span");
        marker.className = `annotation-badge${pending.length > 0 ? "" : " committed"}`;
        marker.dataset.annotationBadge = "true";
        marker.setAttribute("aria-label", summary);
        marker.textContent = String(combined.length);
        target.append(marker);
      }
    }

    return clearMarkers;
  }, [documentValue, draft.annotations, effectiveFrameId, presentedComponents, session.events]);

  const applyDocument = useCallback((next: VisualDocument): void => {
    setChanges(computeComponentChanges(previousDocument.current, next));
    previousDocument.current = next;
    setDocumentValue(next);
    setError(null);
  }, []);

  const loadState = useCallback(async (): Promise<void> => {
    if (embedded) return;
    const state = await loadVisualSessionState(basePath);
    applyDocument(asVisualDocument(state.screen));
    setSession(asSessionSnapshot(state.session));
    setDeliveryEvidence(current => ({
      ...state.deliveryEvidence,
      connection: current.connection,
    }));
  }, [applyDocument, basePath, embedded]);

  const refresh = useCallback((): void => {
    if (embedded) return;
    void loadState().catch(cause => {
      setError(cause instanceof Error ? cause.message : "Visual Session refresh failed");
    });
  }, [embedded, loadState]);

  useEffect(() => {
    if (location.search) history.replaceState(null, "", basePath);
    if (embedded) {
      previousDocument.current = initialDocument;
      return;
    }
    refresh();
    return connectVisualSessionEvents(basePath, {
      onConnection: (connection: DeliveryConnection) => {
        setDeliveryEvidence(current => ({ ...current, connection }));
        if (connection === "closed") setError("Visual Session delivery closed");
      },
      onReconcile: refresh,
    });
  }, [basePath, embedded, initialDocument, refresh]);

  useEffect(() => {
    if (!documentValue) return;
    const profile = documentValue.version === 1
      ? documentValue.profile
      : embeddedLegacyDocument(documentValue)?.profile ?? documentValue.workspace_kind;
    document.body.dataset.profile = profile;
    document.body.dataset.density = density;
  }, [density, documentValue]);

  useEffect(() => {
    const savedDensity = safeStorageGet("localStorage", densityKey) ?? safeStorageGet("sessionStorage", densityKey);
    setDensityState(savedDensity === "compact" ? "compact" : "comfortable");
    const savedDraft = safeStorageGet("sessionStorage", feedbackKey);
    try {
      setDraftState(normalizeFeedbackDraft(savedDraft ? JSON.parse(savedDraft) as unknown : {}));
    } catch {
      setDraftState(normalizeFeedbackDraft());
    }
  }, [densityKey, feedbackKey]);

  useEffect(() => {
    const storedRatio = Number.parseFloat(safeStorageGet("localStorage", workspaceSplitKey) ?? "");
    const restored = Number.isFinite(storedRatio) && storedRatio > 0 && storedRatio < 1
      ? viewportWidth * storedRatio
      : canvasBounds.defaultValue;
    setWorkspaceCanvasWidth(clamp(restored, canvasBounds.min, canvasBounds.max));
  }, [canvasBounds.defaultValue, canvasBounds.max, canvasBounds.min, viewportWidth, workspaceSplitKey]);

  useEffect(() => {
    const shortcut = (event: globalThis.KeyboardEvent): void => {
      if (readOnly || !(event.metaKey || event.ctrlKey) || event.key !== "Enter") return;
      event.preventDefault();
      const button = document.querySelector<HTMLButtonElement>(".feedback-panel .primary-button");
      button?.click();
    };
    document.addEventListener("keydown", shortcut);
    return () => document.removeEventListener("keydown", shortcut);
  }, [readOnly]);

  const setDensity = (next: Density): void => {
    setDensityState(next);
    safeStorageSet("localStorage", densityKey, next);
    safeStorageSet("sessionStorage", densityKey, next);
  };

  const setDraft = (next: FeedbackDraft): void => {
    setDraftState(next);
    safeStorageSet("sessionStorage", feedbackKey, JSON.stringify(next));
  };

  const clearDraft = (): void => setDraft(normalizeFeedbackDraft());

  const groupModes = useMemo(() => choiceGroupModes(documentValue), [documentValue]);
  const committedChoices = useMemo(
    () => deriveCommittedChoices(session.events, groupModes),
    [groupModes, session.events],
  );
  const displayedChoices = useMemo(
    () => mergeChoiceState(committedChoices, draft.choices),
    [committedChoices, draft.choices],
  );

  const selectChoice = (choice: Parameters<typeof reconcileChoices>[1], selected: boolean, multiselect: boolean): void => {
    const sameGroup = (candidate: Parameters<typeof reconcileChoices>[1]): boolean => choice.groupId
      ? candidate.groupId === choice.groupId
      : candidate.componentId === choice.componentId;
    const draftOwnsGroup = draft.choices.some(sameGroup);
    if (!selected && !draftOwnsGroup && committedChoices.some(candidate => candidate.componentId === choice.componentId)) return;
    const groupBase = (draftOwnsGroup ? draft.choices : displayedChoices).filter(sameGroup);
    const nextGroup = reconcileChoices(groupBase, choice, { selected, multiselect });
    setDraft({
      ...draft,
      choices: [...draft.choices.filter(candidate => !sameGroup(candidate)), ...nextGroup],
    });
  };

  const submit = async (): Promise<void> => {
    if (readOnly || submitting || !documentValue) return;
    const clientTurnId = draft.clientTurnId ?? createClientTurnId();
    const retryableDraft = { ...draft, clientTurnId };
    setDraft(retryableDraft);
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`${basePath}api/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientTurnId,
          message: draft.message.trim(),
          annotations: draft.annotations,
          choices: draft.choices,
          screen: {
            id: documentValue.version === 2 ? documentValue.workspace_kind : "screen",
            file: documentValue.version === 2 ? "workspace.json" : "screen.json",
            revision: documentRevision(documentValue),
          },
        }),
      });
      if (!response.ok) throw new Error(await readResponseError(response, `feedback request failed: ${response.status}`));
      clearDraft();
      await loadState();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Feedback could not be saved");
    } finally {
      setSubmitting(false);
    }
  };

  const saveStandalone = async (): Promise<void> => {
    if (readOnly) return;
    try {
      const response = await fetch(`${basePath}api/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!response.ok) throw new Error(await readResponseError(response, `save failed: ${response.status}`));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Standalone export could not be saved");
    }
  };

  const presentedThreads = useMemo<PresentedFeedbackThread[]>(() => {
    if (!documentValue) return [];
    const activeFrame = documentValue.version === 2
      ? documentValue.frames.find(frame => frame.id === effectiveFrameId)
      : null;
    const activeIds = new Set(activeFrame?.component_ids ?? componentOptions(documentValue).map(component => component.id));
    return feedbackThreads(documentValue)
      .filter(thread => activeIds.has(thread.component_id))
      .map(thread => ({
        ...thread,
        presentedStatus: deriveFeedbackThreadState(
          thread,
          documentRevision(documentValue),
          changes,
        ) satisfies FeedbackThreadStatus,
      }));
  }, [changes, documentValue, effectiveFrameId]);

  if (!documentValue) {
    return <main className="visual-shell loading-shell"><p>{error ?? "Loading Visual Companion…"}</p></main>;
  }

  const legacy = embeddedLegacyDocument(documentValue);
  const descriptor = documentValue.version === 2
    ? titleCase(documentValue.workspace_kind)
    : titleCase(documentValue.profile);
  const summary = documentValue.version === 1 ? documentValue.summary : legacy?.summary;
  const evidence = documentValue.version === 2 ? documentValue.evidence_refs : [];
  const selectAnnotationComponent = (componentId: string): void => {
    if (readOnly) return;
    if (!componentId) {
      setAnnotationComponentId("");
      return;
    }
    if (!options.some(component => component.id === componentId)) return;
    setAnnotationComponentId(componentId);
  };
  const selectClickedComponent = (event: ReactMouseEvent<HTMLElement>): void => {
    if (readOnly || !(event.target instanceof Element)) return;
    const component = event.target.closest("[data-brainstorm-id]");
    const interactiveDescendant = event.target.closest(INTERACTIVE_DESCENDANT_SELECTOR);
    const componentId = component?.getAttribute("data-brainstorm-id");
    if (!component || !event.currentTarget.contains(component) || !componentId) return;
    if (interactiveDescendant
      && interactiveDescendant !== component
      && component.contains(interactiveDescendant)) return;
    selectAnnotationComponent(componentId);
  };
  const latestFeedbackSeq = session.events.reduce<number | null>((latest, event) => (
    event.type === "user.turn" && Number.isInteger(event.seq)
      ? Math.max(latest ?? 0, event.seq as number)
      : latest
  ), null);
  const presentedDeliveryEvidence: DeliveryEvidence = {
    ...deliveryEvidence,
    durableSeq: deliveryEvidence.durableSeq ?? (deliveryEvidence.listening ? null : latestFeedbackSeq),
  };
  const desktopWorkspaceSplit = viewportWidth > WORKSPACE_SPLIT_BREAKPOINT;
  const boundedCanvasWidth = Math.round(clamp(
    workspaceCanvasWidth,
    canvasBounds.min,
    canvasBounds.max,
  ));
  const feedbackPanelWidth = Math.max(
    WORKSPACE_FEEDBACK_MIN,
    viewportWidth - boundedCanvasWidth - WORKSPACE_SEPARATOR_WIDTH,
  );
  const workspaceStyle: WorkspaceStyle = {
    "--workspace-canvas-width": `${boundedCanvasWidth}px`,
  };
  const commitWorkspaceCanvasWidth = (value: number): void => {
    safeStorageSet("localStorage", workspaceSplitKey, String(value / viewportWidth));
  };

  return (
    <div className="visual-shell">
      <header className="page-header">
        <div className="page-heading">
          <div className="eyebrow"><span>{descriptor}</span>{documentValue.version === 1 && documentValue.audience ? <span>For {documentValue.audience}</span> : null}</div>
          <h1>{documentValue.title}</h1>
          {summary ? <p>{summary}</p> : null}
          {evidence.length > 0 ? (
            <ul className="evidence-list" aria-label="Evidence">
              {evidence.map(reference => <li className="evidence-chip" data-primitive="chip" key={reference.id}>{reference.label}</li>)}
            </ul>
          ) : null}
        </div>
        <div className="title-block" aria-label="Document status">
          <span className="title-block-rev">rev {documentRevision(documentValue)}</span>
          <span className="title-block-meta">{frames.length} {frames.length === 1 ? "Frame" : "Frames"}</span>
          <div className="density-control" aria-label="Reading density">
            <button aria-pressed={density === "comfortable"} className="density-button" onClick={() => setDensity("comfortable")} type="button">Comfortable</button>
            <button aria-pressed={density === "compact"} className="density-button" onClick={() => setDensity("compact")} type="button">Compact</button>
          </div>
          <div className="document-actions">
            <button className="icon-button" disabled={readOnly} onClick={() => void saveStandalone()} title="Save standalone export" type="button"><Download aria-hidden="true" size={17} /><span className="sr-only">Save standalone export</span></button>
            <button className="icon-button" disabled={Boolean(embedded)} onClick={refresh} title="Refresh Visual Session" type="button"><RefreshCw aria-hidden="true" size={17} /><span className="sr-only">Refresh Visual Session</span></button>
          </div>
        </div>
      </header>

      <div className="workspace" data-density={density} style={workspaceStyle}>
        <main
          aria-live="polite"
          className="workspace-canvas"
          id="workspace-canvas"
          onClickCapture={selectClickedComponent}
          ref={workspaceCanvas}
        >
          <WorkspaceHost
            activeFrameId={effectiveFrameId}
            changes={changes}
            choices={displayedChoices}
            documentValue={documentValue}
            onChoice={selectChoice}
            onFrameSelect={setActiveFrameId}
            onPresentedComponentIdsChange={reportPresentedComponentIds}
            readOnly={Boolean(readOnly)}
          />
        </main>
        {desktopWorkspaceSplit ? (
          <PaneSeparator
            aria-controls="workspace-canvas"
            className="workspace-pane-separator"
            label="Workspace canvas width"
            max={canvasBounds.max}
            min={canvasBounds.min}
            onChange={setWorkspaceCanvasWidth}
            onCommit={commitWorkspaceCanvasWidth}
            orientation="vertical"
            resizeSide="before"
            value={boundedCanvasWidth}
            valueText={`Workspace canvas ${boundedCanvasWidth} pixels; Feedback panel ${Math.round(feedbackPanelWidth)} pixels`}
          />
        ) : null}
        <FeedbackPanel
          annotationComponentId={presentedAnnotationComponentId}
          components={options}
          deliveryState={deriveBrowserDeliveryState(presentedDeliveryEvidence)}
          draft={draft}
          error={error}
          events={session.events}
          onAnnotationComponentSelect={selectAnnotationComponent}
          onClear={clearDraft}
          onDraftChange={setDraft}
          onRefresh={refresh}
          onSubmit={() => void submit()}
          readOnly={Boolean(readOnly)}
          submitting={submitting}
          threads={presentedThreads}
        />
      </div>
    </div>
  );
}
