import {
  AlertTriangle,
  CheckCircle2,
  FileCheck2,
  GitBranch,
  Scale,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { ReviewNavigator } from "./ReviewNavigator";
import { ReviewPoints, reviewPointComponentIds } from "./ReviewPoints";
import { SourceEvidencePanel } from "./SourceEvidencePanel";

export interface ReviewAcceptanceCriterion {
  component_id: string;
  id: string;
  points?: string[];
  title: string;
}

export interface ReviewActualChange {
  acceptance_criteria: string[];
  claimed_by: string[];
  component_id: string;
  evidence_ids: string[];
  hunk_id: string;
  path: string;
  source_preview: {
    end_line: number;
    lines: string[];
    start_line: number;
  };
  symbols: string[];
}

export interface ReviewSlice {
  acceptance_criteria: string[];
  actual_changes: ReviewActualChange[];
  component_id: string;
  expected_files: string[];
  finding_ids: string[];
  points?: string[];
  stream_id: string;
  task_id: string;
  title: string;
  verification: string[];
  verification_command: string;
}

export interface ReviewSourceEvidence {
  component_id: string;
  end_line: number;
  hunk_id: string;
  id: string;
  path: string;
  start_line: number;
  symbols: string[];
}

export interface ReviewSourceContext {
  acceptanceCriteria: string[];
  componentId: string;
  evidenceIds: string[];
  hunkId: string;
  identity: string;
  path: string;
  reviewSliceIds: string[];
  sourceEvidenceId: string;
  sourceEvidenceState: "linked" | "missing";
  sourcePreview: {
    endLine: number;
    lines: string[];
    startLine: number;
  };
  symbols: string[];
}

export interface ReviewFileReview {
  acceptance_criteria: string[];
  patch_digest: string;
  path: string;
  viewed: boolean;
  viewed_patch_set_id: string | null;
}

export interface ReviewNavigationSelection {
  id: string;
  path: string;
  sourceIdentity?: string;
}

interface ReviewVerificationEvidence {
  acceptance_criteria: string[];
  evidence_ref: string;
  patch_set_id: string;
  status: "current" | "outdated";
}

interface ReviewPatchSetInvalidation {
  affected_acceptance_criteria: string[];
  current_patch_set_id: string;
  id: string;
  path: string;
  previous_patch_set_id: string;
  reason: string;
}

interface ReviewContent {
  canonical_spec: {
    acceptance_criteria: ReviewAcceptanceCriterion[];
    digest: string;
    path: string;
  };
  cross_slice_changes: Array<{ claimed_by: string[]; hunk_id: string; path: string }>;
  decision_records: Array<Record<string, unknown>>;
  evidence_records: Array<Record<string, unknown>>;
  findings: Array<Record<string, unknown>>;
  outcomes: Array<Record<string, unknown>>;
  patch_set: {
    files: Array<Record<string, unknown>>;
    patch_set_id: string;
  };
  patch_set_invalidations: ReviewPatchSetInvalidation[];
  patch_set_review: {
    acceptance_evidence: Record<string, Record<string, unknown>>;
    can_approve: boolean;
    file_reviews: ReviewFileReview[];
    patch_set_id: string;
    viewed_progress: { total: number; viewed: number };
    whole_feature_verdict: null | {
      acceptance_criteria: string[];
      evidence_ids: string[];
      patch_set_id: string;
      verdict: "approved" | "rejected";
    };
  };
  quality_contract: {
    canClose: boolean;
    obligations: Array<Record<string, unknown>>;
  };
  review_slices: ReviewSlice[];
  source_evidence: ReviewSourceEvidence[];
  unmapped_changes: Array<{ hunk_id: string; path: string }>;
  verification_evidence: ReviewVerificationEvidence[];
}

interface FeatureReviewWorkbenchProps {
  content: Record<string, unknown>;
  onPresentedComponentIdsChange: (componentIds: string[]) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function reviewContent(value: Record<string, unknown>): ReviewContent | null {
  if (!isRecord(value.canonical_spec)
    || !Array.isArray(value.review_slices)
    || !isRecord(value.patch_set)
    || !isRecord(value.patch_set_review)
    || !isRecord(value.quality_contract)
    || !Array.isArray(value.evidence_records)
    || !Array.isArray(value.source_evidence)
    || !Array.isArray(value.verification_evidence)
    || !Array.isArray(value.findings)
    || !Array.isArray(value.decision_records)
    || !Array.isArray(value.outcomes)
    || !Array.isArray(value.patch_set_invalidations)
    || !Array.isArray(value.cross_slice_changes)
    || !Array.isArray(value.unmapped_changes)) return null;
  return value as unknown as ReviewContent;
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function statusText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return "Recorded";
  for (const key of ["status", "verdict", "result", "choice"]) {
    if (typeof value[key] === "string") return String(value[key]);
  }
  return "Recorded";
}

function titleCase(value: string): string {
  return value.length > 0 ? value[0]!.toUpperCase() + value.slice(1).replaceAll("_", " ") : value;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function sourceIdentity(evidenceId: string, hunkId: string): string {
  return `${evidenceId}:${hunkId}`;
}

function sourceContexts(
  slices: ReviewSlice[],
  sourceEvidence: ReviewSourceEvidence[],
): ReviewSourceContext[] {
  const evidenceByComponent = new Map<string, ReviewSourceEvidence[]>();
  for (const evidence of sourceEvidence) {
    const current = evidenceByComponent.get(evidence.component_id) ?? [];
    current.push(evidence);
    evidenceByComponent.set(evidence.component_id, current);
  }

  const sources = new Map<string, ReviewSourceContext>();
  for (const slice of slices) {
    for (const change of slice.actual_changes) {
      const candidates = evidenceByComponent.get(change.component_id) ?? [];
      const evidence = candidates.find(candidate => (
        candidate.path === change.path && candidate.hunk_id === change.hunk_id
      ));
      const evidenceId = evidence?.id ?? change.component_id;
      const hunkId = evidence?.hunk_id ?? change.hunk_id;
      const identity = sourceIdentity(evidenceId, hunkId);
      const existing = sources.get(identity);
      if (existing) {
        existing.acceptanceCriteria = unique([...existing.acceptanceCriteria, ...change.acceptance_criteria]);
        existing.evidenceIds = unique([...existing.evidenceIds, ...change.evidence_ids]);
        existing.reviewSliceIds = unique([
          ...existing.reviewSliceIds,
          slice.task_id,
          ...change.claimed_by,
        ]);
        continue;
      }
      sources.set(identity, {
        acceptanceCriteria: unique(change.acceptance_criteria),
        componentId: change.component_id,
        evidenceIds: unique(change.evidence_ids),
        hunkId,
        identity,
        path: evidence?.path ?? change.path,
        reviewSliceIds: unique([slice.task_id, ...change.claimed_by]),
        sourceEvidenceId: evidenceId,
        sourceEvidenceState: evidence ? "linked" : "missing",
        sourcePreview: {
          endLine: evidence?.end_line ?? change.source_preview.end_line,
          lines: change.source_preview.lines,
          startLine: evidence?.start_line ?? change.source_preview.start_line,
        },
        symbols: evidence?.symbols ?? change.symbols,
      });
    }
  }
  return [...sources.values()];
}

function LineageGroup({ items, kind }: { items: Array<Record<string, unknown>>; kind: "decision" | "outcome" }) {
  return (
    <div className="review-lineage-list">
      {items.map(item => {
        const id = text(item.id);
        const componentId = text(item.component_id);
        const label = text(item.title, text(item.result, id));
        const attribute = kind === "decision" ? { "data-decision-record": id } : { "data-outcome-record": id };
        return (
          <article
            {...attribute}
            className="review-lineage-item"
            data-brainstorm-id={componentId || undefined}
            data-brainstorm-label={label}
            key={id}
          >
            <strong>{id}</strong>
            <span>{text(item.title, text(item.result, statusText(item.status)))}</span>
            <span className="review-status-label">{titleCase(statusText(item.status ?? item.result))}</span>
            <ReviewPoints label={label} owner={item} />
          </article>
        );
      })}
    </div>
  );
}

function ReviewEvidencePanel({ content, selectedCriterionId, selectedSource }: {
  content: ReviewContent;
  selectedCriterionId: string;
  selectedSource: ReviewSourceContext | null;
}) {
  const verificationById = new Map(content.verification_evidence.map(item => [item.evidence_ref, item]));
  const evidence = content.evidence_records.filter(record => {
    const evidenceId = text(record.id);
    const criteria = unique([
      ...strings(record.acceptance_criteria),
      ...(verificationById.get(evidenceId)?.acceptance_criteria ?? []),
    ]);
    return criteria.includes(selectedCriterionId)
      || (selectedSource?.evidenceIds.includes(evidenceId) ?? false);
  });
  const obligations = content.quality_contract.obligations;
  const acceptanceEvidence = Object.entries(content.patch_set_review.acceptance_evidence);

  return (
    <aside
      aria-labelledby="review-evidence-heading"
      className="review-evidence-pane"
      data-review-evidence=""
      tabIndex={0}
    >
      <header className="review-pane-heading">
        <span className="review-pane-icon"><Scale aria-hidden="true" size={16} /></span>
        <div><h3 id="review-evidence-heading">Verification and governance</h3><p>Evidence, findings, and lineage</p></div>
      </header>

      <section className="review-evidence-section">
        <div className="review-section-title"><FileCheck2 aria-hidden="true" size={15} /><h4>Verification evidence</h4></div>
        <div className="review-evidence-list">
          {evidence.map(record => {
            const evidenceId = text(record.id);
            const verification = verificationById.get(evidenceId);
            const result = verification?.status ?? "unverified";
            const negative = result !== "current";
            return (
              <article
                data-evidence-id={evidenceId}
                data-evidence-patch-set-id={verification?.patch_set_id ?? ""}
                data-evidence-state={result}
                data-verification-evidence={evidenceId}
                key={evidenceId}
              >
                {negative ? <AlertTriangle aria-hidden="true" size={15} /> : <CheckCircle2 aria-hidden="true" size={15} />}
                <span><strong>{evidenceId}</strong>{text(record.kind)}</span>
                <span className={`review-status-label ${negative ? "is-warning" : "is-positive"}`}>{titleCase(result)}</span>
              </article>
            );
          })}
          {acceptanceEvidence.map(([criterion, state]) => {
            const status = text(state.status);
            return (
              <article
                data-acceptance-evidence={criterion}
                data-evidence-state={status}
                key={`acceptance-${criterion}`}
              >
                {status === "current" ? <CheckCircle2 aria-hidden="true" size={15} /> : <AlertTriangle aria-hidden="true" size={15} />}
                <span><strong>{criterion}</strong>Acceptance evidence</span>
                <span className={`review-status-label ${status === "current" ? "is-positive" : "is-warning"}`}>{titleCase(status)}</span>
              </article>
            );
          })}
        </div>
      </section>

      <section className="review-evidence-section">
        <div className="review-section-title"><ShieldCheck aria-hidden="true" size={15} /><h4>Quality obligations</h4></div>
        <div className="review-quality-list">
          {obligations.map(obligation => {
            const status = text(obligation.status, "open");
            const exclusion = isRecord(obligation.exclusion) ? obligation.exclusion : null;
            const reviewer = exclusion ? text(exclusion.reviewer) : "";
            const componentId = text(obligation.component_id);
            return (
              <article
                data-brainstorm-id={componentId || undefined}
                data-brainstorm-label={titleCase(text(obligation.quality))}
                data-quality-obligation={text(obligation.id)}
                key={text(obligation.id)}
              >
                <span>
                  <strong>{text(obligation.id)}</strong>
                  {titleCase(text(obligation.quality))}
                  {reviewer ? <small>{reviewer}</small> : null}
                </span>
                <span className={`review-status-label status-${status}`}>{titleCase(status)}</span>
                <ReviewPoints label={titleCase(text(obligation.quality))} owner={obligation} />
              </article>
            );
          })}
        </div>
      </section>

      <section className="review-evidence-section">
        <div className="review-section-title"><AlertTriangle aria-hidden="true" size={15} /><h4>Findings</h4></div>
        <div className="review-finding-list">
          {content.findings.map(finding => (
            <article
              data-brainstorm-id={text(finding.component_id) || undefined}
              data-brainstorm-label={text(finding.title, text(finding.id))}
              data-finding={text(finding.id)}
              key={text(finding.id)}
            >
              <span className="review-finding-icon"><AlertTriangle aria-hidden="true" size={15} /></span>
              <div><strong>{text(finding.title, text(finding.id))}</strong><p>{text(finding.detail, text(finding.summary))}</p></div>
              <span className={`review-status-label severity-${text(finding.severity, "medium")}`}>
                {titleCase(text(finding.severity, "medium"))} · {titleCase(text(finding.status))}
              </span>
              <ReviewPoints label={text(finding.title, text(finding.id))} owner={finding} />
            </article>
          ))}
        </div>
      </section>

      <section className="review-evidence-section">
        <div className="review-section-title"><GitBranch aria-hidden="true" size={15} /><h4>Decisions and outcomes</h4></div>
        <LineageGroup items={content.decision_records} kind="decision" />
        <LineageGroup items={content.outcomes} kind="outcome" />
      </section>
    </aside>
  );
}

function PatchSetInvalidations({ invalidations }: { invalidations: ReviewPatchSetInvalidation[] }) {
  if (invalidations.length === 0) return null;
  return (
    <section aria-label="Patch Set invalidations" className="review-invalidation-list">
      {invalidations.map(invalidation => (
        <article data-patch-set-invalidation={invalidation.id} key={invalidation.id}>
          <AlertTriangle aria-hidden="true" size={15} />
          <div>
            <strong>{invalidation.path}</strong>
            <p>{invalidation.reason}</p>
            <div className="review-chip-row">
              {invalidation.affected_acceptance_criteria.map(criterion => (
                <span data-primitive="chip" key={criterion}>{criterion}</span>
              ))}
            </div>
          </div>
        </article>
      ))}
    </section>
  );
}

function defaultSelection(
  sources: ReviewSourceContext[],
  fileReviews: ReviewFileReview[],
  expectedFiles: string[],
): ReviewNavigationSelection | null {
  const source = sources[0];
  if (source) return { id: `source:${source.identity}`, path: source.path, sourceIdentity: source.identity };
  const path = fileReviews[0]?.path ?? expectedFiles[0];
  return path ? { id: `file:${path}`, path } : null;
}

export function FeatureReviewWorkbench({
  content,
  onPresentedComponentIdsChange,
}: FeatureReviewWorkbenchProps) {
  const parsed = reviewContent(content);
  const [selectedCriterionId, setSelectedCriterionId] = useState("");
  const [selection, setSelection] = useState<ReviewNavigationSelection | null>(null);

  const sources = useMemo(() => (
    parsed ? sourceContexts(parsed.review_slices, parsed.source_evidence) : []
  ), [parsed]);
  const expectedFiles = useMemo(() => (
    parsed ? unique(parsed.review_slices.flatMap(slice => slice.expected_files)) : []
  ), [parsed]);
  const fileStates = useMemo(() => (
    parsed ? Object.fromEntries(parsed.patch_set_review.file_reviews.map(file => [file.path, file])) : {}
  ), [parsed]);
  const acceptanceCriteria = parsed?.canonical_spec.acceptance_criteria ?? [];
  const activeCriterionId = acceptanceCriteria.some(item => item.id === selectedCriterionId)
    ? selectedCriterionId
    : acceptanceCriteria[0]?.id ?? "";
  const validSelection = parsed && selection && (
    selection.sourceIdentity
      ? sources.some(source => source.identity === selection.sourceIdentity)
      : parsed.patch_set_review.file_reviews.some(file => file.path === selection.path)
        || expectedFiles.includes(selection.path)
  ) ? selection : null;
  const activeSelection = parsed
    ? validSelection ?? defaultSelection(sources, parsed.patch_set_review.file_reviews, expectedFiles)
    : null;
  const selectedSource = activeSelection?.sourceIdentity
    ? sources.find(source => source.identity === activeSelection.sourceIdentity) ?? null
    : null;
  const selectedPath = activeSelection?.path ?? "";
  const presentedComponentIds = useMemo(() => {
    if (!parsed) return [];
    const activeCriterion = acceptanceCriteria.find(criterion => criterion.id === activeCriterionId);
    const relevantSlices = parsed.review_slices.filter(slice => slice.acceptance_criteria.includes(activeCriterionId));
    const governanceRecords = [
      ...parsed.findings,
      ...parsed.quality_contract.obligations,
      ...parsed.decision_records,
      ...parsed.outcomes,
    ];
    return unique([
      activeCriterion?.component_id ?? "",
      ...reviewPointComponentIds(activeCriterion),
      ...relevantSlices.map(slice => slice.component_id),
      ...relevantSlices.flatMap(slice => reviewPointComponentIds(slice)),
      selectedSource?.componentId ?? "",
      ...governanceRecords.map(record => text(record.component_id)),
      ...governanceRecords.flatMap(record => reviewPointComponentIds(record)),
    ].filter(id => id.length > 0));
  }, [acceptanceCriteria, activeCriterionId, parsed, selectedSource]);

  useEffect(() => {
    onPresentedComponentIdsChange(presentedComponentIds);
  }, [onPresentedComponentIdsChange, presentedComponentIds]);

  if (!parsed) return <p className="workspace-error" role="alert">Review Workspace content is invalid.</p>;

  const verdict = parsed.patch_set_review.whole_feature_verdict;
  const verdictText = verdict?.verdict ?? "open";
  const changedFileCount = parsed.patch_set_review.file_reviews.length;
  const patchSetCurrent = parsed.patch_set.patch_set_id === parsed.patch_set_review.patch_set_id
    && (!verdict || verdict.patch_set_id === parsed.patch_set_review.patch_set_id);
  const selectCriterion = (criterionId: string): void => {
    setSelectedCriterionId(criterionId);
    const slices = parsed.review_slices.filter(slice => slice.acceptance_criteria.includes(criterionId));
    const sliceIds = new Set(slices.map(slice => slice.task_id));
    const selectionStillRelevant = selectedSource
      ? selectedSource.reviewSliceIds.some(sliceId => sliceIds.has(sliceId))
      : slices.some(slice => slice.expected_files.includes(selectedPath))
        || fileStates[selectedPath]?.acceptance_criteria.includes(criterionId) === true;
    if (selectionStillRelevant) return;

    const source = sources.find(candidate => candidate.reviewSliceIds.some(sliceId => sliceIds.has(sliceId)));
    if (source) {
      setSelection({ id: `source:${source.identity}`, path: source.path, sourceIdentity: source.identity });
      return;
    }
    const path = slices[0]?.expected_files[0]
      ?? parsed.patch_set_review.file_reviews.find(file => file.acceptance_criteria.includes(criterionId))?.path;
    if (path) setSelection({ id: `file:${path}`, path });
  };

  return (
    <section
      className="feature-review-workbench"
      data-changed-file-count={changedFileCount}
      data-review-workbench=""
    >
      <header className="review-status-bar">
        <div className="review-status-primary">
          <span className="review-kicker">Feature Review Workbench</span>
          <h2>Whole-feature review</h2>
        </div>
        <div className="review-patch-state" data-patch-set-status={patchSetCurrent ? "current" : "stale"}>
          <GitBranch aria-hidden="true" size={15} />
          <span><strong>{patchSetCurrent ? "Current patch set" : "Stale patch set"}</strong>{parsed.patch_set.patch_set_id.slice(0, 8)}</span>
          <span>{changedFileCount} files</span>
        </div>
        <div
          aria-label={`File Viewed ${parsed.patch_set_review.viewed_progress.viewed} of ${parsed.patch_set_review.viewed_progress.total}; whole feature ${verdictText}`}
          className="review-progress-state"
          data-can-approve={String(parsed.patch_set_review.can_approve)}
          data-review-progress=""
          role="group"
        >
          <div
            data-total={parsed.patch_set_review.viewed_progress.total}
            data-viewed={parsed.patch_set_review.viewed_progress.viewed}
            data-viewed-progress=""
          >
            <span>File Viewed</span>
            <strong>{parsed.patch_set_review.viewed_progress.viewed} of {parsed.patch_set_review.viewed_progress.total}</strong>
          </div>
          <div className={`verdict-${verdictText}`} data-whole-feature-verdict={verdictText}>
            {verdictText === "approved"
              ? <CheckCircle2 aria-hidden="true" size={16} />
              : verdictText === "rejected" ? <XCircle aria-hidden="true" size={16} /> : <Scale aria-hidden="true" size={16} />}
            <span>Whole feature</span>
            <strong>{titleCase(verdictText)}</strong>
          </div>
        </div>
      </header>

      {(parsed.cross_slice_changes.length > 0 || parsed.unmapped_changes.length > 0 || parsed.patch_set_invalidations.length > 0) ? (
        <div className="review-attention-strip" role="status">
          <AlertTriangle aria-hidden="true" size={15} />
          <span>{parsed.cross_slice_changes.length} cross-slice</span>
          <span>{parsed.unmapped_changes.length} unmapped</span>
          <span>{parsed.patch_set_invalidations.length} invalidated evidence set</span>
        </div>
      ) : null}
      <PatchSetInvalidations invalidations={parsed.patch_set_invalidations} />

      <div className="review-three-pane">
        <ReviewNavigator
          acceptanceCriteria={acceptanceCriteria}
          expectedFiles={expectedFiles}
          fileReviews={parsed.patch_set_review.file_reviews}
          fileStates={fileStates}
          onAcceptanceCriterionSelect={selectCriterion}
          onSelection={setSelection}
          reviewSlices={parsed.review_slices}
          selectedAcceptanceCriterionId={activeCriterionId}
          selectedTargetId={activeSelection?.id ?? ""}
          sources={sources}
          unmappedPaths={parsed.unmapped_changes.map(item => item.path)}
        />
        <SourceEvidencePanel
          expectedFiles={expectedFiles}
          fileState={selectedPath ? fileStates[selectedPath] : undefined}
          selectedPath={selectedPath}
          source={selectedSource}
          unmappedPaths={parsed.unmapped_changes.map(item => item.path)}
        />
        <ReviewEvidencePanel
          content={parsed}
          selectedCriterionId={activeCriterionId}
          selectedSource={selectedSource}
        />
      </div>
    </section>
  );
}
