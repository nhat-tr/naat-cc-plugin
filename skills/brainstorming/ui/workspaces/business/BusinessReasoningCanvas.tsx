import {
  AlertTriangle,
  BadgeCheck,
  CircleDollarSign,
  FlaskConical,
  Lightbulb,
  Target,
  UserRound,
} from "lucide-react";
import { useEffect, useMemo, type ReactNode } from "react";

import type { EvidenceReference, WorkspaceComponent } from "../../app/WorkspaceHost";

type BusinessTone = "neutral" | "accent" | "positive" | "warning" | "critical";
type ReasoningKind = "assumption" | "economics" | "risk" | "experiment" | "outcome" | "evidence";

interface NamedEntity {
  id: string;
  label: string;
}

interface ReasoningItem {
  kind: ReasoningKind;
  label: string;
  source_ref?: string;
}

interface BusinessStage {
  component_id: string;
  tone?: BusinessTone;
  actor_id?: string;
  outcome_id?: string;
  items: ReasoningItem[];
}

interface BusinessContent {
  journey_spine?: boolean;
  actors?: NamedEntity[];
  outcomes?: NamedEntity[];
  stages: BusinessStage[];
}

interface BusinessReasoningCanvasProps {
  components: WorkspaceComponent[];
  content: Record<string, unknown>;
  evidenceRefs: EvidenceReference[];
  onPresentedComponentIdsChange: (componentIds: string[]) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function businessContent(value: Record<string, unknown>): BusinessContent | null {
  if (!Array.isArray(value.stages)) return null;
  if (!value.stages.every(stage => (
    isRecord(stage)
    && typeof stage.component_id === "string"
    && Array.isArray(stage.items)
  ))) return null;
  if (value.actors !== undefined && !Array.isArray(value.actors)) return null;
  if (value.outcomes !== undefined && !Array.isArray(value.outcomes)) return null;
  return value as unknown as BusinessContent;
}

function reasoningIcon(kind: ReasoningKind): ReactNode {
  if (kind === "assumption") return <Lightbulb aria-hidden="true" size={16} />;
  if (kind === "economics") return <CircleDollarSign aria-hidden="true" size={16} />;
  if (kind === "risk") return <AlertTriangle aria-hidden="true" size={16} />;
  if (kind === "experiment") return <FlaskConical aria-hidden="true" size={16} />;
  if (kind === "outcome") return <Target aria-hidden="true" size={16} />;
  return <BadgeCheck aria-hidden="true" size={16} />;
}

function titleCase(value: string): string {
  return value.length > 0 ? value[0]!.toUpperCase() + value.slice(1) : value;
}

export function BusinessReasoningCanvas({
  components,
  content,
  evidenceRefs,
  onPresentedComponentIdsChange,
}: BusinessReasoningCanvasProps) {
  const parsed = businessContent(content);
  const presentedComponentIds = useMemo(
    () => parsed?.stages.map(stage => stage.component_id) ?? [],
    [parsed],
  );

  useEffect(() => {
    onPresentedComponentIdsChange(presentedComponentIds);
  }, [onPresentedComponentIdsChange, presentedComponentIds]);

  if (!parsed) {
    return <p className="workspace-error" role="alert">Business Workspace content is invalid.</p>;
  }

  const componentById = new Map(components.map(component => [component.id, component]));
  const actorById = new Map((parsed.actors ?? []).map(actor => [actor.id, actor]));
  const outcomeById = new Map((parsed.outcomes ?? []).map(outcome => [outcome.id, outcome]));
  const evidenceById = new Map(evidenceRefs.map(reference => [reference.id, reference]));
  const hasJourneySpine = parsed.journey_spine !== false;

  return (
    <section className="business-reasoning-canvas" data-business-reasoning-canvas="">
      <header className="business-canvas-header">
        <span className="business-kicker">Business Reasoning Canvas</span>
        <h2>From actor intent to observable outcome</h2>
      </header>

      <div className="business-leads">
        <section aria-labelledby="business-actors-heading" className="business-lead-group">
          <header>
            <UserRound aria-hidden="true" size={17} />
            <h3 id="business-actors-heading">Actors</h3>
          </header>
          <div className="business-entity-list">
            {(parsed.actors ?? []).map(actor => (
              <span className="business-actor" data-actor={actor.id} key={actor.id}>{actor.label}</span>
            ))}
          </div>
        </section>
        <section aria-labelledby="business-outcomes-heading" className="business-lead-group business-outcome-group">
          <header>
            <Target aria-hidden="true" size={17} />
            <h3 id="business-outcomes-heading">Outcomes</h3>
          </header>
          <div className="business-entity-list">
            {(parsed.outcomes ?? []).map(outcome => (
              <span className="business-outcome" data-outcome={outcome.id} key={outcome.id}>{outcome.label}</span>
            ))}
          </div>
        </section>
      </div>

      <div
        className={`business-journey-spine${hasJourneySpine ? "" : " without-journey"}`}
        data-journey-spine={hasJourneySpine ? "true" : "false"}
      >
        {parsed.stages.map((stage, index) => {
          const component = componentById.get(stage.component_id);
          const label = component?.label ?? stage.component_id;
          const actor = stage.actor_id ? actorById.get(stage.actor_id) : undefined;
          const outcome = stage.outcome_id ? outcomeById.get(stage.outcome_id) : undefined;
          return (
            <article
              className={`business-stage tone-${stage.tone ?? "neutral"}`}
              data-brainstorm-id={stage.component_id}
              data-brainstorm-label={label}
              key={stage.component_id}
            >
              <header className={`business-stage-header${hasJourneySpine ? "" : " without-stage-number"}`}>
                {hasJourneySpine ? (
                  <span className="business-stage-number">{String(index + 1).padStart(2, "0")}</span>
                ) : null}
                <div>
                  {hasJourneySpine ? <span className="business-stage-overline">Journey stage</span> : null}
                  <h3>{label}</h3>
                </div>
              </header>

              {actor || outcome ? (
                <div className="business-stage-links">
                  {actor ? <span><UserRound aria-hidden="true" size={13} />{actor.label}</span> : null}
                  {outcome ? <span><Target aria-hidden="true" size={13} />{outcome.label}</span> : null}
                </div>
              ) : null}

              <ul className="business-reasoning-list">
                {stage.items.map((item, itemIndex) => (
                  <li data-kind={item.kind} key={`${stage.component_id}-${item.kind}-${itemIndex}`}>
                    <span className={`business-reasoning-icon reasoning-${item.kind}`}>
                      {reasoningIcon(item.kind)}
                    </span>
                    <div>
                      <span className="business-reasoning-kind">{titleCase(item.kind)}</span>
                      <p>{item.label}</p>
                      {item.source_ref ? (
                        <span
                          className="business-source-chip"
                          data-primitive="chip"
                          data-source-ref={item.source_ref}
                          title={item.source_ref}
                        >
                          <BadgeCheck aria-hidden="true" size={12} />
                          {evidenceById.get(item.source_ref)?.label ?? item.source_ref}
                        </span>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            </article>
          );
        })}
      </div>
    </section>
  );
}
