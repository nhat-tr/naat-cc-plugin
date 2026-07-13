import { Download, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { FeedbackPanel, type FeedbackComponentOption, type PresentedFeedbackThread } from "../shared/FeedbackPanel";
import {
  type FeedbackDraft,
  type FeedbackThread,
  type FeedbackThreadStatus,
  type SessionEvent,
  type SessionSnapshot,
  computeComponentChanges,
  createClientTurnId,
  deriveCommittedChoices,
  deriveFeedbackThreadState,
  emptySessionSnapshot,
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

export function VisualCompanionApp() {
  const embedded = globalThis.window?.__BRAINSTORM_EMBEDDED__;
  const initialDocument = embedded ? asVisualDocument(embedded.screen) : null;
  const basePath = document.body.dataset.basePath || "/";
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
  const previousDocument = useRef<VisualDocument | null>(null);

  const identity = documentValue?.version === 2
    ? `${documentValue.work_id}:${location.origin}${basePath}`
    : `${location.origin}${basePath}`;
  const densityKey = `visual-density:${identity}`;
  const feedbackKey = `visual-feedback:${identity}`;
  const readOnly = embedded?.readOnly === true || (documentValue?.version === 2 && documentValue.read_only);
  const frames = documentValue ? workspaceFrames(documentValue) : [];
  const effectiveFrameId = frames.some(frame => frame.id === activeFrameId)
    ? activeFrameId
    : frames[0]?.id ?? "";

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
  const allOptions = componentOptions(documentValue);
  const activeComponentIds = documentValue.version === 2
    ? new Set(documentValue.frames.find(frame => frame.id === effectiveFrameId)?.component_ids ?? [])
    : null;
  const options = activeComponentIds
    ? allOptions.filter(component => activeComponentIds.has(component.id))
    : allOptions;
  const latestFeedbackSeq = session.events.reduce<number | null>((latest, event) => (
    event.type === "user.turn" && Number.isInteger(event.seq)
      ? Math.max(latest ?? 0, event.seq as number)
      : latest
  ), null);
  const presentedDeliveryEvidence: DeliveryEvidence = {
    ...deliveryEvidence,
    durableSeq: deliveryEvidence.durableSeq ?? (deliveryEvidence.listening ? null : latestFeedbackSeq),
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

      <div className="workspace" data-density={density}>
        <main aria-live="polite" className="workspace-canvas">
          <WorkspaceHost
            activeFrameId={effectiveFrameId}
            changes={changes}
            choices={displayedChoices}
            documentValue={documentValue}
            onChoice={selectChoice}
            onFrameSelect={setActiveFrameId}
            readOnly={Boolean(readOnly)}
          />
        </main>
        <FeedbackPanel
          components={options}
          deliveryState={deriveBrowserDeliveryState(presentedDeliveryEvidence)}
          draft={draft}
          error={error}
          events={session.events}
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
