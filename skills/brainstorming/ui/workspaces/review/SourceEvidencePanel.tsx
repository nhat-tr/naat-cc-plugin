import { Braces, FileDiff, Link2, Unlink } from "lucide-react";

import type { ReviewFileReview, ReviewSourceContext } from "./FeatureReviewWorkbench";

interface SourceEvidencePanelProps {
  expectedFiles: string[];
  fileState?: ReviewFileReview;
  selectedPath: string;
  source: ReviewSourceContext | null;
  unmappedPaths: string[];
}

export function SourceEvidencePanel({
  expectedFiles,
  fileState,
  selectedPath,
  source,
  unmappedPaths,
}: SourceEvidencePanelProps) {
  if (!selectedPath) {
    return (
      <section className="review-source-pane" data-review-source="">
        <p className="review-empty">No Patch Set file is available for review.</p>
      </section>
    );
  }

  const expected = expectedFiles.includes(selectedPath);
  const unmapped = unmappedPaths.includes(selectedPath);

  return (
    <section
      className="review-source-pane"
      data-brainstorm-id={source?.componentId}
      data-brainstorm-label={source ? `Actual change: ${source.path}` : undefined}
      data-review-source=""
    >
      <header className="review-pane-heading review-source-heading" data-source-path={selectedPath}>
        <span className="review-pane-icon"><FileDiff aria-hidden="true" size={16} /></span>
        <div>
          <span className="review-source-kicker">Selected source</span>
          <h3 data-selected-source-path={selectedPath}>{selectedPath}</h3>
        </div>
        <span
          className={`review-viewed-state ${fileState?.viewed ? "is-viewed" : "is-unviewed"}`}
          data-selected-file-viewed=""
        >
          {fileState ? fileState.viewed ? "Viewed" : "Not viewed" : "Not reviewed"}
        </span>
      </header>

      <div className="review-attribution-strip">
        {source ? (
          <span data-actual-change={source.path}>Actual change: {source.path}</span>
        ) : (
          <span className="review-no-actual" data-no-actual-change="">No actual change</span>
        )}
        <span className={expected ? "is-expected" : "is-unmapped"}>
          {expected ? "Expected ownership" : "Unexpected path"}
        </span>
        {unmapped ? <span className="is-unmapped">Unmapped Patch Set file</span> : null}
        {source?.reviewSliceIds.map(sliceId => (
          <span key={sliceId}>Review Slice {sliceId}</span>
        ))}
      </div>

      {source ? (
        <>
          <div
            className={`review-source-evidence is-${source.sourceEvidenceState}`}
            data-source-evidence-id={source.sourceEvidenceId}
            data-source-evidence-state={source.sourceEvidenceState}
          >
            {source.sourceEvidenceState === "linked"
              ? <Link2 aria-hidden="true" size={15} />
              : <Unlink aria-hidden="true" size={15} />}
            <span>
              <strong>Source evidence</strong>
              <code>{source.sourceEvidenceId}</code>
            </span>
            <span>{source.sourceEvidenceState}</span>
          </div>

          <section className="review-source-section" data-hunk-id={source.hunkId}>
            <div className="review-section-title">
              <Braces aria-hidden="true" size={15} />
              <h4>Changed symbols</h4>
            </div>
            <div className="review-symbol-list">
              {source.symbols.length > 0
                ? source.symbols.map(symbol => <code data-source-symbol="" key={symbol}>{symbol}</code>)
                : <span className="review-empty-inline">No symbols recorded</span>}
            </div>
          </section>

          <section className="review-source-section">
            <div className="review-section-title">
              <FileDiff aria-hidden="true" size={15} />
              <h4>Hunk context</h4>
              <code className="review-hunk-id" title={source.hunkId}>{source.hunkId.slice(0, 16)}</code>
            </div>
            <div className="review-source-preview" data-source-context="">
              <div className="review-source-range">
                Lines {source.sourcePreview.startLine}-{source.sourcePreview.endLine}
              </div>
              <ol start={source.sourcePreview.startLine}>
                {source.sourcePreview.lines.map((line, index) => (
                  <li key={`${source.identity}-${source.sourcePreview.startLine + index}`}><code>{line}</code></li>
                ))}
              </ol>
            </div>
          </section>
        </>
      ) : (
        <section className="review-no-source" data-no-matching-actual-change="">
          <Unlink aria-hidden="true" size={18} />
          <div>
            <strong>No matching actual change</strong>
            <p>This path has no linked hunk in the selected Patch Set.</p>
          </div>
        </section>
      )}

      <section className="review-source-section">
        <div className="review-section-title">
          <Link2 aria-hidden="true" size={15} />
          <h4>Acceptance and evidence</h4>
        </div>
        <div className="review-chip-row">
          {(fileState?.acceptance_criteria ?? source?.acceptanceCriteria ?? []).map(id => (
            <span data-primitive="chip" key={id}>{id}</span>
          ))}
          {source?.evidenceIds.map(id => <span data-primitive="chip" key={id}>{id}</span>)}
        </div>
      </section>
    </section>
  );
}
