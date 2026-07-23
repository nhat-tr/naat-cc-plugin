import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
} from "react";

import { FrameNavigator, type WorkspaceFrame } from "../shared/FrameNavigator";
import { InlineText } from "../shared/InlineText";
import {
  type ChangeFlags,
  type Choice,
  isChoiceSelected,
} from "./feedback-store";
import { workspaceCompositionMap } from "./workspace-map";

export interface WorkspaceComponent {
  id: string;
  frame_id: string;
  label: string;
}

export interface WorkspaceDecision {
  id: string;
  title: string;
  multiselect: boolean;
  option_component_ids: string[];
}

export interface EvidenceReference {
  id: string;
  label: string;
}

export interface WorkspaceEnvelope {
  version: 2;
  work_id: string;
  workspace_kind: "product" | "architecture" | "research" | "business" | "review" | "uml";
  title: string;
  evidence_refs: EvidenceReference[];
  revision: string;
  frames: WorkspaceFrame[];
  components: WorkspaceComponent[];
  decisions: WorkspaceDecision[];
  feedback_threads: unknown[];
  content: Record<string, unknown>;
  read_only: boolean;
}

export interface LegacyVisualDocument {
  version: 1;
  profile: string;
  audience?: string;
  title: string;
  summary?: string;
  sections: Array<Record<string, unknown>>;
}

interface WorkspaceHostProps {
  activeFrameId: string;
  changes: ChangeFlags;
  choices: Choice[];
  documentValue: WorkspaceEnvelope | LegacyVisualDocument;
  onChoice: (choice: Choice, selected: boolean, multiselect: boolean) => void;
  onFrameSelect: (frameId: string) => void;
  onPresentedComponentIdsChange: (componentIds: string[]) => void;
  readOnly: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function bool(value: unknown): boolean {
  return value === true;
}

function titleCase(value: string): string {
  return value.length > 0 ? value[0]!.toUpperCase() + value.slice(1) : value;
}

function inline(value: string, copyFileReferences = true): ReactNode {
  return <InlineText copyFileReferences={copyFileReferences} value={value} />;
}

function ComponentChangeFlag({ changes, id }: { changes: ChangeFlags; id: string }) {
  const state = changes.added.includes(id) ? "new" : changes.updated.includes(id) ? "updated" : null;
  return state
    ? <span className={`component-flag flag-${state}`} data-primitive="flag">{state}</span>
    : null;
}

function WorkspaceDecisions({
  activeComponentIds,
  choices,
  components,
  decisions,
  onChoice,
  readOnly,
}: {
  activeComponentIds: Set<string>;
  choices: Choice[];
  components: WorkspaceComponent[];
  decisions: WorkspaceDecision[];
  onChoice: (choice: Choice, selected: boolean, multiselect: boolean) => void;
  readOnly: boolean;
}) {
  const componentById = new Map(components.map(component => [component.id, component]));
  const firstDecisionByOption = new Map<string, string>();
  for (const decision of decisions) {
    for (const componentId of decision.option_component_ids) {
      if (!firstDecisionByOption.has(componentId)) firstDecisionByOption.set(componentId, decision.id);
    }
  }
  const visibleDecisions = decisions.map(decision => ({
    decision,
    optionIds: decision.option_component_ids.filter(componentId => activeComponentIds.has(componentId)),
  })).filter(entry => entry.optionIds.length > 0);
  if (visibleDecisions.length === 0) return null;

  return (
    <section className="decisions" aria-label="Decisions">
      {visibleDecisions.map(({ decision, optionIds }) => (
        <div className="decision-group" key={decision.id}>
          <h2>{decision.title}</h2>
          <div className="decision-options">
            {optionIds.map(componentId => {
              const component = componentById.get(componentId);
              if (!component) return null;
              const ownsComponentIdentity = firstDecisionByOption.get(componentId) === decision.id;
              const selected = isChoiceSelected(choices, component.id, decision.id);
              const choose = (): void => onChoice({
                groupId: decision.id,
                componentId: component.id,
                value: component.id,
                label: component.label,
              }, !selected, decision.multiselect);
              return (
                <button
                  aria-pressed={selected}
                  className={`decision-option${selected ? " selected" : ""}`}
                  data-brainstorm-id={ownsComponentIdentity ? component.id : undefined}
                  data-brainstorm-label={component.label}
                  data-choice-component-id={!ownsComponentIdentity ? component.id : undefined}
                  disabled={readOnly}
                  key={component.id}
                  onClick={choose}
                  type="button"
                >
                  {component.label}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </section>
  );
}

function ToneLabel({ tone }: { tone: string }) {
  return tone !== "neutral"
    ? <span className="tone-label" data-primitive="flag">{titleCase(tone)}</span>
    : null;
}

interface SelectableProps {
  children: ReactNode;
  className: string;
  id: string;
  label: string;
  tone?: string;
}

function Selectable({ children, className, id, label, tone = "neutral" }: SelectableProps) {
  return (
    <article
      className={`${className} tone-${tone}`}
      data-brainstorm-id={id}
      data-brainstorm-label={label}
      data-primitive="tone"
      data-tone={tone}
    >
      {children}
    </article>
  );
}

function Points({ changes, copyFileReferences = true, ownerId, ownerTitle, points }: {
  changes: ChangeFlags;
  copyFileReferences?: boolean;
  ownerId: string;
  ownerTitle: string;
  points: string[];
}) {
  if (points.length === 0) return null;
  return (
    <div className="point-list" role="list">
      {points.map((point, index) => {
        const id = `${ownerId}-p${index + 1}`;
        return (
          <div
            className="point"
            data-brainstorm-id={id}
            data-brainstorm-label={`${ownerTitle} · point ${index + 1}`}
            key={id}
            role="listitem"
          >
            <span className="point-text">{inline(point, copyFileReferences)}</span>
            <ComponentChangeFlag changes={changes} id={id} />
          </div>
        );
      })}
    </div>
  );
}

function ItemCard({ changes, extraClass = "", item }: {
  changes: ChangeFlags;
  extraClass?: string;
  item: Record<string, unknown>;
}) {
  const id = text(item.id);
  const title = text(item.title, id);
  const tone = text(item.tone, "neutral");
  return (
    <Selectable className={`item-card ${extraClass}`.trim()} id={id} label={title} tone={tone}>
      <ToneLabel tone={tone} />
      <h3>{title}</h3>
      {text(item.detail) ? <p>{inline(text(item.detail))}</p> : null}
      <Points changes={changes} ownerId={id} ownerTitle={title} points={strings(item.points)} />
      <ComponentChangeFlag changes={changes} id={id} />
    </Selectable>
  );
}

function TimelineItemCard({ changes, index, item }: {
  changes: ChangeFlags;
  index: number;
  item: Record<string, unknown>;
}) {
  const id = text(item.id);
  const title = text(item.title, id);
  const tone = text(item.tone, "neutral");
  return (
    <Selectable className="item-card timeline-item" id={id} label={title} tone={tone}>
      <span className="timeline-index">{index + 1}</span>
      <div className="timeline-content">
        <ToneLabel tone={tone} />
        <h3>{title}</h3>
        {text(item.detail) ? <p>{inline(text(item.detail))}</p> : null}
        <Points changes={changes} ownerId={id} ownerTitle={title} points={strings(item.points)} />
        <ComponentChangeFlag changes={changes} id={id} />
      </div>
    </Selectable>
  );
}

function ElementView({ element }: { element: Record<string, unknown> }) {
  const kind = text(element.kind, "placeholder");
  if (kind === "heading") return <div className="el-heading">{text(element.text)}</div>;
  if (kind === "text") return <div className="el-text">{text(element.text)}</div>;
  if (kind === "button") return <span className={`el-button el-button-${text(element.variant, "secondary")}`}>{text(element.label)}</span>;
  if (kind === "badge") return <span className={`el-badge tone-${text(element.tone, "neutral")}`}>{text(element.label)}</span>;
  if (kind === "metric") return <div className="el-metric"><span className="el-metric-value">{text(element.value)}</span><span className="el-metric-label">{text(element.label)}</span></div>;
  if (kind === "input") {
    const control = text(element.control, "text");
    return (
      <div className={`el-input el-input-${control}`}>
        {text(element.label) ? <span className="el-input-label">{text(element.label)}</span> : null}
        <span className="el-field">{text(element.value) || text(element.placeholder) || " "}</span>
      </div>
    );
  }
  if (kind === "tabs") {
    const active = number(element.active) ?? 0;
    return <div className="el-tabs">{strings(element.labels).map((label, index) => <span className={`el-tab${index === active ? " active" : ""}`} key={label}>{label}</span>)}</div>;
  }
  if (kind === "table") {
    return (
      <table className="el-table">
        <thead><tr>{strings(element.columns).map(column => <th key={column}>{column}</th>)}</tr></thead>
        <tbody>{(Array.isArray(element.rows) ? element.rows : []).map((row, rowIndex) => (
          <tr key={rowIndex}>{strings(row).map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>
        ))}</tbody>
      </table>
    );
  }
  if (kind === "cells") {
    const columns = number(element.columns);
    const style: CSSProperties | undefined = columns ? { gridTemplateColumns: `repeat(${columns}, minmax(30px, 1fr))` } : undefined;
    return <div className="el-cells" style={style}>{records(element.items).map((cell, index) => <span className={`el-cell tone-${text(cell.tone, "neutral")}${bool(cell.filled) ? " filled" : ""}`} key={index}>{text(cell.label)}</span>)}</div>;
  }
  if (kind === "list") {
    return <div className="el-list">{records(element.items).map((item, index) => <div className="el-list-row" key={index}><span>{text(item.title)}</span>{text(item.meta) ? <span>{text(item.meta)}</span> : null}</div>)}</div>;
  }
  return <div className="el-placeholder">{text(element.label)}</div>;
}

function SectionFrame({ children, index, section }: {
  children: ReactNode;
  index: number;
  section: Record<string, unknown>;
}) {
  const id = text(section.id);
  const title = text(section.title, id);
  const kind = text(section.kind);
  return (
    <section className={`visual-section section-${kind}`} data-brainstorm-id={id} data-brainstorm-label={title}>
      <header className="section-header">
        <div className="section-label">
          <span className="section-index">{String(index + 1).padStart(2, "0")}</span>
          <span className="section-kind" data-primitive="chip">{kind}</span>
        </div>
        <h2>{title}</h2>
        {text(section.summary) ? <p>{inline(text(section.summary))}</p> : null}
      </header>
      {children}
    </section>
  );
}

function LegacySection({ changes, choices, index, onChoice, readOnly, section }: {
  changes: ChangeFlags;
  choices: Choice[];
  index: number;
  onChoice: WorkspaceHostProps["onChoice"];
  readOnly: boolean;
  section: Record<string, unknown>;
}) {
  const kind = text(section.kind);
  if (kind === "callout") {
    const tone = text(section.tone, "neutral");
    return (
      <aside className={`visual-section callout tone-${tone}`} data-brainstorm-id={text(section.id)} data-brainstorm-label={text(section.title)} data-primitive="tone" data-tone={tone}>
        <header className="section-header"><span className="section-kind" data-primitive="chip">callout</span><h2>{text(section.title)}</h2><ToneLabel tone={tone} /></header>
        <div className="callout-body"><p>{inline(text(section.body))}</p></div>
      </aside>
    );
  }
  if (kind === "decision") {
    const groupId = text(section.groupId, text(section.id));
    const multiselect = bool(section.multiselect);
    return (
      <SectionFrame index={index} section={section}>
        <div className="decision-options" data-choice-group={groupId} data-multiselect={multiselect || undefined}>
          {records(section.options).map(option => {
            const id = text(option.id);
            const label = text(option.label, id);
            const tone = text(option.tone, "neutral");
            const selected = isChoiceSelected(choices, id, groupId);
            const choose = (): void => onChoice({ groupId, componentId: id, value: id, label }, !selected, multiselect);
            return (
              <button
                aria-pressed={selected}
                className={`decision-option tone-${tone}${selected ? " selected" : ""}`}
                data-brainstorm-id={id}
                data-brainstorm-label={label}
                data-choice={id}
                data-group-id={groupId}
                data-primitive="tone"
                data-tone={tone}
                disabled={readOnly}
                key={id}
                onClick={choose}
                type="button"
              >
                <span className="option-heading"><strong>{label}</strong><ToneLabel tone={tone} /></span>
                {bool(option.recommended) ? <span className="recommended">Recommended</span> : null}
                {number(option.score) != null ? <span className="score">{number(option.score)}/10</span> : null}
                {text(option.detail) ? <span className="option-detail">{inline(text(option.detail), false)}</span> : null}
                <Points changes={changes} copyFileReferences={false} ownerId={id} ownerTitle={label} points={strings(option.points)} />
                <ComponentChangeFlag changes={changes} id={id} />
              </button>
            );
          })}
        </div>
      </SectionFrame>
    );
  }
  if (kind === "flow") {
    return (
      <SectionFrame index={index} section={section}>
        <ol className="pipeline">
          {records(section.nodes).flatMap((item, itemIndex) => {
            const id = text(item.id);
            const title = text(item.title, id);
            const tone = text(item.tone, "neutral");
            const step = <li className={`pipeline-step tone-${tone}`} data-brainstorm-id={id} data-brainstorm-label={title} data-primitive="tone" data-tone={tone} key={id}><ToneLabel tone={tone} /><h3>{title}</h3>{text(item.detail) ? <p>{inline(text(item.detail))}</p> : null}<Points changes={changes} ownerId={id} ownerTitle={title} points={strings(item.points)} /><ComponentChangeFlag changes={changes} id={id} /></li>;
            return itemIndex === 0 ? [step] : [<li aria-hidden="true" className="pipeline-arrow" key={`${id}-arrow`}>→</li>, step];
          })}
        </ol>
      </SectionFrame>
    );
  }
  if (kind === "mockup") {
    return (
      <SectionFrame index={index} section={section}>
        <div className={`mockup mockup-${text(section.device, "desktop")}`}>
          <div className="mockup-bar" aria-hidden="true"><i /><i /><i /></div>
          <div className="mockup-surface">
            {records(section.regions).map(region => {
              const elements = records(region.elements);
              if (elements.length === 0) return <ItemCard changes={changes} extraClass={`mockup-region role-${text(region.role, "content")}`} item={region} key={text(region.id)} />;
              const span = number(region.span);
              return (
                <article className={`mockup-region mockup-panel role-${text(region.role, "content")}`} data-brainstorm-id={text(region.id)} data-brainstorm-label={text(region.title)} key={text(region.id)} style={span ? { gridColumn: `span ${span}` } : undefined}>
                  {elements.map((element, elementIndex) => {
                    const id = `${text(region.id)}-e${elementIndex + 1}`;
                    return <div data-brainstorm-id={id} data-brainstorm-label={`${text(region.title)} · ${text(element.kind)} ${elementIndex + 1}`} key={id}><ElementView element={element} /><ComponentChangeFlag changes={changes} id={id} /></div>;
                  })}
                </article>
              );
            })}
          </div>
        </div>
      </SectionFrame>
    );
  }
  const items = records(section.items);
  return (
    <SectionFrame index={index} section={section}>
      <div className={`${kind}-items`}>
        {items.map((item, itemIndex) => {
          if (kind === "timeline") return <TimelineItemCard changes={changes} index={itemIndex} item={item} key={text(item.id)} />;
          return <ItemCard changes={changes} extraClass={`${kind}-item`} item={item} key={text(item.id)} />;
        })}
      </div>
    </SectionFrame>
  );
}

function LegacyRenderer({ changes, choices, documentValue, onChoice, readOnly }: {
  changes: ChangeFlags;
  choices: Choice[];
  documentValue: LegacyVisualDocument;
  onChoice: WorkspaceHostProps["onChoice"];
  readOnly: boolean;
}) {
  return (
    <div className="legacy-document">
      {documentValue.sections.map((section, index) => (
        <LegacySection changes={changes} choices={choices} index={index} key={text(section.id)} onChoice={onChoice} readOnly={readOnly} section={section} />
      ))}
    </div>
  );
}

export function embeddedLegacyDocument(documentValue: WorkspaceEnvelope | LegacyVisualDocument): LegacyVisualDocument | null {
  if (documentValue.version === 1) return documentValue;
  const candidate = documentValue.content.legacy_document;
  return isRecord(candidate) && candidate.version === 1 ? candidate as unknown as LegacyVisualDocument : null;
}

export function WorkspaceHost({
  activeFrameId,
  changes,
  choices,
  documentValue,
  onChoice,
  onFrameSelect,
  onPresentedComponentIdsChange,
  readOnly,
}: WorkspaceHostProps) {
  const presentedDecisionOptionIds = useMemo(() => {
    if (documentValue.version === 1 || documentValue.workspace_kind === "product") return [];
    const frame = documentValue.frames.find(candidate => candidate.id === activeFrameId)
      ?? documentValue.frames[0];
    if (!frame) return [];
    const frameComponentIds = new Set(frame.component_ids);
    return [...new Set(documentValue.decisions
      .flatMap(decision => decision.option_component_ids)
      .filter(componentId => frameComponentIds.has(componentId)))];
  }, [activeFrameId, documentValue]);
  const showPurposeComposition = useMemo(() => {
    if (documentValue.version === 1 || documentValue.workspace_kind === "product") return true;
    const frame = documentValue.frames.find(candidate => candidate.id === activeFrameId)
      ?? documentValue.frames[0];
    if (!frame) return false;
    const decisionOptionIds = new Set(documentValue.decisions
      .flatMap(decision => decision.option_component_ids));
    return frame.component_ids.some(componentId => !decisionOptionIds.has(componentId));
  }, [activeFrameId, documentValue]);
  const reportPurposeComponentIds = useCallback((componentIds: string[]): void => {
    onPresentedComponentIdsChange([
      ...new Set([...componentIds, ...presentedDecisionOptionIds]),
    ]);
  }, [onPresentedComponentIdsChange, presentedDecisionOptionIds]);

  useEffect(() => {
    if (
      documentValue.version === 2
      && documentValue.workspace_kind !== "product"
      && !showPurposeComposition
    ) {
      reportPurposeComponentIds([]);
    }
  }, [documentValue, reportPurposeComponentIds, showPurposeComposition]);

  const legacy = embeddedLegacyDocument(documentValue);
  if (documentValue.version === 1) {
    return <LegacyRenderer changes={changes} choices={choices} documentValue={documentValue} onChoice={onChoice} readOnly={readOnly} />;
  }
  const activeFrame = documentValue.frames.find(frame => frame.id === activeFrameId) ?? documentValue.frames[0];
  if (!activeFrame) return null;
  const componentById = new Map(documentValue.components.map(component => [component.id, component]));
  const decisionOptionIds = new Set(documentValue.decisions.flatMap(decision => decision.option_component_ids));
  const activeComponentIds = new Set(activeFrame.component_ids);
  const purposePanels = (content: ReactNode): ReactNode => (
    <>
      <section
        aria-labelledby={`frame-tab-${activeFrame.id}`}
        className="frame-panel"
        id={`frame-panel-${activeFrame.id}`}
        key="active-purpose-frame"
        role="tabpanel"
      >
        {content}
      </section>
      {documentValue.frames.filter(frame => frame.id !== activeFrame.id).map(frame => (
        <section
          aria-labelledby={`frame-tab-${frame.id}`}
          className="frame-panel"
          hidden
          id={`frame-panel-${frame.id}`}
          key={`inactive-${frame.id}`}
          role="tabpanel"
        />
      ))}
    </>
  );

  if (!legacy) {
    const composition = workspaceCompositionMap[documentValue.workspace_kind]({
      activeFrameId: activeFrame.id,
      choices,
      documentValue,
      onChoice,
      onFrameSelect,
      onPresentedComponentIdsChange: reportPurposeComponentIds,
      readOnly,
    });
    return (
      <div className="workspace-host" data-workspace-kind={documentValue.workspace_kind}>
        <FrameNavigator activeFrameId={activeFrame.id} frames={documentValue.frames} onSelect={onFrameSelect} />
        {documentValue.workspace_kind === "product" ? composition : purposePanels(
          <>
            <WorkspaceDecisions
              activeComponentIds={activeComponentIds}
              choices={choices}
              components={documentValue.components}
              decisions={documentValue.decisions}
              onChoice={onChoice}
              readOnly={readOnly}
            />
            {showPurposeComposition ? composition : null}
          </>,
        )}
        {changes.removed.length > 0 ? (
          <p className="changes-strip" role="status">Removed in this Revision: {changes.removed.map(item => item.label).join(" · ")}</p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="workspace-host">
      <FrameNavigator activeFrameId={activeFrame.id} frames={documentValue.frames} onSelect={onFrameSelect} />
      {documentValue.frames.map(frame => {
        const selected = frame.id === activeFrame.id;
        const frameComponents = frame.component_ids.flatMap(id => {
          const component = componentById.get(id);
          return component && !decisionOptionIds.has(id) ? [component] : [];
        });
        const legacySectionIndex = legacy?.sections.findIndex(section => section.id === frame.id) ?? -1;
        const legacySection = legacySectionIndex >= 0 ? legacy?.sections[legacySectionIndex] : undefined;
        return (
          <section
            aria-labelledby={`frame-tab-${frame.id}`}
            className="frame-panel"
            hidden={!selected}
            id={`frame-panel-${frame.id}`}
            key={frame.id}
            role="tabpanel"
          >
            {legacy && legacySection
              ? <LegacySection changes={changes} choices={choices} index={legacySectionIndex} onChoice={onChoice} readOnly={readOnly} section={legacySection} />
              : !legacy ? (
                <div className="workspace-slot" data-workspace-kind={documentValue.workspace_kind}>
                  <header><h2>{frame.title}</h2></header>
                  <div className="component-list">
                    {frameComponents.map(component => (
                      <article className="component-card" data-brainstorm-id={component.id} data-brainstorm-label={component.label} key={component.id}>
                        <h3>{component.label}</h3>
                        <ComponentChangeFlag changes={changes} id={component.id} />
                      </article>
                    ))}
                  </div>
                </div>
              ) : null}
          </section>
        );
      })}

      {changes.removed.length > 0 ? (
        <p className="changes-strip" role="status">Removed in this Revision: {changes.removed.map(item => item.label).join(" · ")}</p>
      ) : null}
    </div>
  );
}
