import {
  Accessibility,
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  Code2,
  Inbox,
  LoaderCircle,
  Monitor,
  Smartphone,
  Sparkles,
} from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";

import type { WorkspaceDecision } from "../../app/WorkspaceHost";
import type { Choice } from "../../app/feedback-store";
import { ConceptWall, type DifferenceDimension } from "./ConceptWall";
import {
  PrototypeFrame,
  type ProductConcept,
  type PrototypeState,
  type ResponsiveState,
} from "./PrototypeFrame";

interface ProductWorkspaceContent {
  layout_direction: {
    id: string;
    mobile: "three_up";
    desktop: "stacked_with_difference_lens";
    evidence_ref: string;
  };
  fixture: {
    id: string;
    device: string;
    scope: string;
    fidelity: string;
    data: Record<string, unknown>;
  };
  recommendation: {
    concept_id: string;
    disclosure: "after_inspection_or_provisional_choice";
    rationale: string[];
  };
  concepts: ProductConcept[];
  difference_lens: {
    title: string;
    dimensions: DifferenceDimension[];
  };
}

interface ProductConceptStudioProps {
  activeFrameId: string;
  choices: Choice[];
  content: Record<string, unknown>;
  decisions: WorkspaceDecision[];
  onChoice: (choice: Choice, selected: boolean, multiselect: boolean) => void;
  onFrameSelect: (frameId: string) => void;
  readOnly: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function productContent(value: Record<string, unknown>): ProductWorkspaceContent | null {
  if (!isRecord(value.layout_direction) || !isRecord(value.fixture) || !isRecord(value.recommendation)) return null;
  if (!Array.isArray(value.concepts) || value.concepts.length !== 3 || !isRecord(value.difference_lens)) return null;
  if (!value.concepts.every(concept => isRecord(concept) && typeof concept.id === "string" && typeof concept.title === "string")) return null;
  if (!Array.isArray(value.difference_lens.dimensions)) return null;
  return value as unknown as ProductWorkspaceContent;
}

function subscribeToMobileLayout(onChange: () => void): () => void {
  const query = globalThis.matchMedia("(max-width: 620px)");
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function mobileLayoutSnapshot(): boolean {
  return globalThis.matchMedia("(max-width: 620px)").matches;
}

function serverMobileLayoutSnapshot(): boolean {
  return false;
}

function DetailList({ items }: { items: string[] }) {
  return <ul>{items.map(item => <li key={item}>{item}</li>)}</ul>;
}

function stateIcon(state: PrototypeState["id"]) {
  if (state === "loading") return <LoaderCircle aria-hidden="true" size={17} />;
  if (state === "empty") return <Inbox aria-hidden="true" size={17} />;
  if (state === "error") return <AlertTriangle aria-hidden="true" size={17} />;
  return <CheckCircle2 aria-hidden="true" size={17} />;
}

function FocusView({ concept, focusRequest, onBack }: {
  concept: ProductConcept;
  focusRequest: number;
  onBack: () => void;
}) {
  const [stateId, setStateId] = useState<PrototypeState["id"]>("default");
  const [viewport, setViewport] = useState<ResponsiveState["viewport"]>("desktop");
  const backButton = useRef<HTMLButtonElement>(null);
  const stateTabs = useRef(new Map<string, HTMLButtonElement>());
  const activeState = concept.focus.states.find(state => state.id === stateId) ?? concept.focus.states[0]!;
  const responsiveState = concept.focus.responsive.find(state => state.viewport === viewport) ?? concept.focus.responsive[0]!;

  useEffect(() => {
    if (focusRequest > 0) backButton.current?.focus();
  }, [focusRequest]);

  const selectStateAt = (index: number): void => {
    const state = concept.focus.states[index];
    if (!state) return;
    setStateId(state.id);
    stateTabs.current.get(state.id)?.focus();
  };

  const onStateKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (index + 1) % concept.focus.states.length;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (index - 1 + concept.focus.states.length) % concept.focus.states.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = concept.focus.states.length - 1;
    if (nextIndex == null) return;
    event.preventDefault();
    selectStateAt(nextIndex);
  };

  return (
    <div className="product-focus" data-concept-id={concept.id} data-product-focus="">
      <header className="product-focus-heading">
        <button className="product-back-button" onClick={onBack} ref={backButton} type="button">
          <ChevronLeft aria-hidden="true" size={17} />
          <span>Back to comparison</span>
        </button>
        <div>
          <span className="product-focus-eyebrow">Focused concept</span>
          <h2>{concept.title}</h2>
          <p>{concept.strategy.summary}</p>
        </div>
      </header>

      <div className="product-focus-grid">
        <section className="product-focus-section product-focus-states" data-brainstorm-id="focus-states" data-brainstorm-label="Interaction states">
          <header>
            <h3>Interaction states</h3>
            <p>Review failure and progress behavior before handoff.</p>
          </header>
          <div aria-label="Prototype states" className="product-state-tabs" role="tablist">
            {concept.focus.states.map((state, index) => (
              <button
                aria-controls={`product-state-${concept.id}`}
                aria-selected={state.id === activeState.id}
                id={`product-state-tab-${concept.id}-${state.id}`}
                key={state.id}
                onClick={() => setStateId(state.id)}
                onKeyDown={event => onStateKeyDown(event, index)}
                ref={element => {
                  if (element) stateTabs.current.set(state.id, element);
                  else stateTabs.current.delete(state.id);
                }}
                role="tab"
                tabIndex={state.id === activeState.id ? 0 : -1}
                type="button"
              >
                {state.label}
              </button>
            ))}
          </div>
          <div
            aria-live="polite"
            aria-labelledby={`product-state-tab-${concept.id}-${activeState.id}`}
            className="product-focus-state"
            data-product-focus-state=""
            id={`product-state-${concept.id}`}
            role="tabpanel"
          >
            <span className={`product-state-icon state-${activeState.id}`}>{stateIcon(activeState.id)}</span>
            <div>
              <strong>{activeState.label}</strong>
              <p>{activeState.detail}</p>
            </div>
          </div>
        </section>

        <section className="product-focus-section product-focus-responsive" data-brainstorm-id="focus-responsive" data-brainstorm-label="Responsive behavior">
          <header>
            <h3>Responsive behavior</h3>
            <p>Inspect both target widths with the same fixture.</p>
          </header>
          <div aria-label="Responsive preview" className="product-responsive-control" role="group">
            <button aria-pressed={viewport === "desktop"} onClick={() => setViewport("desktop")} type="button">
              <Monitor aria-hidden="true" size={15} /> Desktop
            </button>
            <button aria-pressed={viewport === "mobile"} onClick={() => setViewport("mobile")} type="button">
              <Smartphone aria-hidden="true" size={15} /> Mobile
            </button>
          </div>
          <div className="product-responsive-preview" data-product-responsive-preview="">
            <PrototypeFrame concept={concept} device={viewport} stateLabel={activeState.label} />
            <p>{responsiveState.behavior}</p>
          </div>
        </section>

        <section className="product-focus-section" data-brainstorm-id="focus-accessibility" data-brainstorm-label="Accessibility behavior">
          <header className="product-detail-heading">
            <Accessibility aria-hidden="true" size={18} />
            <h3>Accessibility behavior</h3>
          </header>
          <h4>Keyboard order</h4>
          <DetailList items={concept.focus.accessibility.keyboard_order} />
          <h4>Announcements</h4>
          <DetailList items={concept.focus.accessibility.announcements} />
          <p className="product-detail-note">Reduced motion: {concept.focus.accessibility.reduced_motion}</p>
        </section>

        <section className="product-focus-section" data-brainstorm-id="focus-handoff" data-brainstorm-label="Implementation handoff">
          <header className="product-detail-heading">
            <Code2 aria-hidden="true" size={18} />
            <h3>Implementation handoff</h3>
          </header>
          <h4>Component boundaries</h4>
          <DetailList items={concept.focus.handoff.component_boundaries} />
          <h4>Data contracts</h4>
          <DetailList items={concept.focus.handoff.data_contracts} />
          <p className="product-detail-note">{concept.focus.handoff.implementation_notes[0]}</p>
        </section>
      </div>
    </div>
  );
}

export function ProductConceptStudio({
  activeFrameId,
  choices,
  content,
  decisions,
  onChoice,
  onFrameSelect,
  readOnly,
}: ProductConceptStudioProps) {
  const parsed = productContent(content);
  const mobile = useSyncExternalStore(subscribeToMobileLayout, mobileLayoutSnapshot, serverMobileLayoutSnapshot);
  const [focusedConceptId, setFocusedConceptId] = useState<string | null>(null);
  const [inspectedConceptIds, setInspectedConceptIds] = useState<Set<string>>(() => new Set());
  const [inspectFocusRequest, setInspectFocusRequest] = useState(0);
  const inspectOrigin = useRef<HTMLButtonElement | null>(null);
  const restoreInspectFocus = useRef(false);
  const showFocus = activeFrameId === "focus";

  useEffect(() => {
    if (showFocus || !restoreInspectFocus.current) return;
    restoreInspectFocus.current = false;
    inspectOrigin.current?.focus();
  }, [showFocus]);

  if (!parsed) {
    return <p className="workspace-error" role="alert">Product Workspace content is invalid.</p>;
  }

  const decision = decisions.find(candidate => candidate.option_component_ids.every(id => parsed.concepts.some(concept => concept.id === id)));
  const decisionId = decision?.id ?? "product-concept-choice";
  const selectedConceptId = choices.find(choice => choice.groupId === decisionId)?.componentId ?? null;
  const focusedConcept = parsed.concepts.find(concept => concept.id === focusedConceptId)
    ?? parsed.concepts.find(concept => concept.id === selectedConceptId)
    ?? parsed.concepts[0]!;
  const recommendation = parsed.concepts.find(concept => concept.id === parsed.recommendation.concept_id);
  const recommendationVisible = inspectedConceptIds.size > 0 || selectedConceptId !== null;

  const inspectConcept = (concept: ProductConcept, origin: HTMLButtonElement): void => {
    inspectOrigin.current = origin;
    setFocusedConceptId(concept.id);
    setInspectedConceptIds(current => new Set(current).add(concept.id));
    setInspectFocusRequest(current => current + 1);
    onFrameSelect("focus");
  };

  const returnToComparison = (): void => {
    restoreInspectFocus.current = true;
    onFrameSelect("compare");
  };

  return (
    <div className="product-concept-studio" data-product-concept-studio="">
      <section
        aria-labelledby="frame-tab-compare"
        hidden={showFocus}
        id="frame-panel-compare"
        role="tabpanel"
      >
        <ConceptWall
          choices={choices}
          concepts={parsed.concepts}
          decisionId={decisionId}
          differenceLens={parsed.difference_lens}
          layout={mobile ? "mobile-three-up" : "desktop-stacked"}
          onChoice={onChoice}
          onInspect={inspectConcept}
          readOnly={readOnly}
        />
      </section>
      <section
        aria-labelledby="frame-tab-focus"
        hidden={!showFocus}
        id="frame-panel-focus"
        role="tabpanel"
      >
        <FocusView
          concept={focusedConcept}
          focusRequest={inspectFocusRequest}
          onBack={returnToComparison}
        />
      </section>

      {recommendationVisible && recommendation ? (
        <aside className="product-recommendation" data-product-recommendation="">
          <Sparkles aria-hidden="true" size={18} />
          <div>
            <strong>Recommended: {recommendation.title}</strong>
            <p>{parsed.recommendation.rationale.join(" ")}</p>
          </div>
        </aside>
      ) : null}
    </div>
  );
}
