import {
  AlertTriangle,
  CircleHelp,
  Filter,
  Link2,
  Scale,
  ShieldCheck,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import type { EvidenceReference, WorkspaceComponent } from "../../app/WorkspaceHost";

type Confidence = "high" | "medium" | "low";

interface ResearchClaim {
  component_id: string;
  confidence: Confidence;
  source_refs: string[];
  contradicts?: string[];
  decision_relevance?: string[];
}

interface ResearchUnknown {
  component_id: string;
  note?: string;
  decision_relevance?: string[];
}

interface ResearchContent {
  decision_relevance_options?: string[];
  claims: ResearchClaim[];
  unknowns?: ResearchUnknown[];
}

interface ResearchEvidenceBoardProps {
  components: WorkspaceComponent[];
  content: Record<string, unknown>;
  evidenceRefs: EvidenceReference[];
}

interface ConfidenceDefinition {
  id: Confidence;
  label: string;
  description: string;
  icon: ReactNode;
}

const CONFIDENCE_COLUMNS: ConfidenceDefinition[] = [
  {
    id: "high",
    label: "High confidence",
    description: "Converging source evidence",
    icon: <ShieldCheck aria-hidden="true" size={18} />,
  },
  {
    id: "medium",
    label: "Medium confidence",
    description: "Supported, incomplete, or disputed",
    icon: <Scale aria-hidden="true" size={18} />,
  },
  {
    id: "low",
    label: "Low confidence and unknowns",
    description: "Material uncertainty kept visible",
    icon: <CircleHelp aria-hidden="true" size={18} />,
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function researchContent(value: Record<string, unknown>): ResearchContent | null {
  if (!Array.isArray(value.claims)) return null;
  if (!value.claims.every(claim => (
    isRecord(claim)
    && typeof claim.component_id === "string"
    && ["high", "medium", "low"].includes(String(claim.confidence))
    && Array.isArray(claim.source_refs)
  ))) return null;
  if (value.unknowns !== undefined && !Array.isArray(value.unknowns)) return null;
  return value as unknown as ResearchContent;
}

function relevanceMatches(values: string[] | undefined, filter: string): boolean {
  return filter === "All decisions" || (values ?? []).includes(filter);
}

function relevanceOptions(values: string[] | undefined): string[] {
  return ["All decisions", ...(values ?? []).filter(value => value !== "All decisions")];
}

export function ResearchEvidenceBoard({
  components,
  content,
  evidenceRefs,
}: ResearchEvidenceBoardProps) {
  const parsed = researchContent(content);
  const [relevance, setRelevance] = useState("All decisions");

  if (!parsed) {
    return <p className="workspace-error" role="alert">Research Workspace content is invalid.</p>;
  }

  const componentById = new Map(components.map(component => [component.id, component]));
  const evidenceById = new Map(evidenceRefs.map(reference => [reference.id, reference]));
  const options = relevanceOptions(parsed.decision_relevance_options);
  const selectedRelevance = options.includes(relevance) ? relevance : options[0] ?? "All decisions";
  const claims = parsed.claims.filter(claim => relevanceMatches(claim.decision_relevance, selectedRelevance));
  const unknowns = (parsed.unknowns ?? []).filter(unknown => (
    relevanceMatches(unknown.decision_relevance, selectedRelevance)
  ));

  return (
    <section className="research-evidence-board" data-research-evidence-board="">
      <header className="research-board-header">
        <div>
          <span className="research-kicker">Research Evidence Board</span>
          <h2>Claims by confidence</h2>
        </div>
        <label className="research-filter" data-decision-relevance-filter="">
          <span><Filter aria-hidden="true" size={15} />Decision relevance</span>
          <select
            aria-label="Decision relevance"
            onChange={event => setRelevance(event.target.value)}
            value={selectedRelevance}
          >
            {options.map(option => <option key={option} value={option}>{option}</option>)}
          </select>
        </label>
      </header>

      <div className="research-confidence-columns">
        {CONFIDENCE_COLUMNS.map(column => {
          const columnClaims = claims.filter(claim => claim.confidence === column.id);
          const columnUnknowns = column.id === "low" ? unknowns : [];
          return (
            <section
              aria-label={column.label}
              className={`research-confidence-column confidence-${column.id}`}
              data-confidence={column.id}
              key={column.id}
            >
              <header className="research-confidence-heading">
                <span className="research-confidence-icon">{column.icon}</span>
                <div>
                  <h3>{column.label}</h3>
                  <p>{column.description}</p>
                </div>
                <span className="research-confidence-count">{columnClaims.length + columnUnknowns.length}</span>
              </header>

              <div className="research-claim-list">
                {columnClaims.map(claim => {
                  const component = componentById.get(claim.component_id);
                  const label = component?.label ?? claim.component_id;
                  const contradictions = claim.contradicts ?? [];
                  return (
                    <article
                      className="research-claim"
                      data-brainstorm-id={claim.component_id}
                      data-brainstorm-label={label}
                      key={claim.component_id}
                    >
                      <h4>{label}</h4>
                      {contradictions.length > 0 ? (
                        <div
                          className="research-contradiction"
                          data-flag="contradiction"
                          data-primitive="flag"
                        >
                          <AlertTriangle aria-hidden="true" size={14} />
                          <span>Contradicts {contradictions.map(id => componentById.get(id)?.label ?? id).join(", ")}</span>
                        </div>
                      ) : null}
                      <div className="research-source-group">
                        <span className="research-source-label"><Link2 aria-hidden="true" size={13} />Source evidence</span>
                        <div className="research-source-list">
                          {claim.source_refs.map(sourceId => (
                            <span
                              className="research-source-chip"
                              data-primitive="chip"
                              data-source-ref={sourceId}
                              key={sourceId}
                              title={sourceId}
                            >
                              {evidenceById.get(sourceId)?.label ?? sourceId}
                            </span>
                          ))}
                        </div>
                      </div>
                      {(claim.decision_relevance ?? []).length > 0 ? (
                        <div className="research-relevance-list" aria-label="Decision relevance">
                          {claim.decision_relevance?.map(item => <span key={item}>{item}</span>)}
                        </div>
                      ) : null}
                    </article>
                  );
                })}

                {columnUnknowns.map(unknown => {
                  const component = componentById.get(unknown.component_id);
                  const label = component?.label ?? unknown.component_id;
                  return (
                    <article
                      className="research-unknown"
                      data-brainstorm-id={unknown.component_id}
                      data-brainstorm-label={label}
                      data-unknown="true"
                      key={unknown.component_id}
                    >
                      <div className="research-unknown-label">
                        <CircleHelp aria-hidden="true" size={15} />
                        <span>Unknown</span>
                      </div>
                      <h4>{label}</h4>
                      {unknown.note ? <p>{unknown.note}</p> : null}
                      {(unknown.decision_relevance ?? []).length > 0 ? (
                        <div className="research-relevance-list" aria-label="Decision relevance">
                          {unknown.decision_relevance?.map(item => <span key={item}>{item}</span>)}
                        </div>
                      ) : null}
                    </article>
                  );
                })}

                {columnClaims.length + columnUnknowns.length === 0 ? (
                  <p className="research-empty">No items match this decision.</p>
                ) : null}
              </div>
            </section>
          );
        })}
      </div>
    </section>
  );
}
