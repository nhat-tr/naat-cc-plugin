import { FileCode2, Files, GitPullRequestArrow } from "lucide-react";
import { useMemo, useRef, useState, type KeyboardEvent } from "react";

import type {
  ReviewAcceptanceCriterion,
  ReviewFileReview,
  ReviewNavigationSelection,
  ReviewSlice,
  ReviewSourceContext,
} from "./FeatureReviewWorkbench";

interface ReviewNavigatorProps {
  acceptanceCriteria: ReviewAcceptanceCriterion[];
  expectedFiles: string[];
  fileReviews: ReviewFileReview[];
  fileStates: Record<string, ReviewFileReview>;
  onAcceptanceCriterionSelect: (id: string) => void;
  onSelection: (selection: ReviewNavigationSelection) => void;
  reviewSlices: ReviewSlice[];
  selectedAcceptanceCriterionId: string;
  selectedTargetId: string;
  sources: ReviewSourceContext[];
  unmappedPaths: string[];
}

interface NavigationFile {
  expected: boolean;
  path: string;
  review?: ReviewFileReview;
  sources: ReviewSourceContext[];
  unmapped: boolean;
}

interface NavigationGroup {
  files: NavigationFile[];
  id: string;
  label: string;
  slice?: ReviewSlice;
}

function safeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/gu, "-");
}

function fileTargetId(path: string): string {
  return `file:${path}`;
}

function sourceTargetId(source: ReviewSourceContext): string {
  return `source:${source.identity}`;
}

function visibleTreeItems(tree: HTMLElement): HTMLElement[] {
  return Array.from(tree.querySelectorAll<HTMLElement>("[role='treeitem']"))
    .filter(item => item.getClientRects().length > 0 && !item.closest("[hidden]"));
}

function childGroup(item: HTMLElement): HTMLElement | null {
  return item.parentElement?.querySelector<HTMLElement>(":scope > [role='group']") ?? null;
}

function parentTreeItem(item: HTMLElement): HTMLElement | null {
  const group = item.parentElement?.closest<HTMLElement>("[role='group']");
  return group?.parentElement?.querySelector<HTMLElement>(":scope > [role='treeitem']") ?? null;
}

function fileSelection(file: NavigationFile): ReviewNavigationSelection {
  const source = file.sources[0];
  return source
    ? { id: sourceTargetId(source), path: file.path, sourceIdentity: source.identity }
    : { id: fileTargetId(file.path), path: file.path };
}

function navigationGroups(
  criterionId: string,
  reviewSlices: ReviewSlice[],
  files: NavigationFile[],
): NavigationGroup[] {
  const fileByPath = new Map(files.map(file => [file.path, file]));
  const assigned = new Set<string>();
  const groups: NavigationGroup[] = [];
  const relevantSlices = reviewSlices.filter(slice => slice.acceptance_criteria.includes(criterionId));

  for (const slice of relevantSlices) {
    const paths = [
      ...slice.expected_files,
      ...files.filter(file => file.sources.some(source => (
        source.reviewSliceIds.includes(slice.task_id)
      ))).map(file => file.path),
    ];
    const sliceFiles: NavigationFile[] = [];
    for (const path of paths) {
      if (assigned.has(path)) continue;
      const file = fileByPath.get(path);
      if (!file) continue;
      assigned.add(path);
      sliceFiles.push(file);
    }
    groups.push({
      files: sliceFiles,
      id: `slice:${criterionId}:${slice.task_id}`,
      label: slice.title,
      slice,
    });
  }

  const remaining = files.filter(file => !assigned.has(file.path));
  if (remaining.length > 0) {
    groups.push({
      files: remaining,
      id: `other:${criterionId}`,
      label: "Other Patch Set files",
    });
  }
  return groups;
}

export function ReviewNavigator({
  acceptanceCriteria,
  expectedFiles,
  fileReviews,
  fileStates,
  onAcceptanceCriterionSelect,
  onSelection,
  reviewSlices,
  selectedAcceptanceCriterionId,
  selectedTargetId,
  sources,
  unmappedPaths,
}: ReviewNavigatorProps) {
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set());
  const [focusedItemId, setFocusedItemId] = useState("");
  const typeahead = useRef({ at: 0, query: "" });
  const unmapped = useMemo(() => new Set(unmappedPaths), [unmappedPaths]);
  const expected = useMemo(() => new Set(expectedFiles), [expectedFiles]);
  const files = useMemo(() => {
    const sourcesByPath = new Map<string, ReviewSourceContext[]>();
    for (const source of sources) {
      const current = sourcesByPath.get(source.path) ?? [];
      current.push(source);
      sourcesByPath.set(source.path, current);
    }
    const paths = new Set([
      ...fileReviews.map(file => file.path),
      ...expectedFiles,
      ...sources.map(source => source.path),
    ]);
    return [...paths].map((path): NavigationFile => ({
      expected: expected.has(path),
      path,
      review: fileStates[path],
      sources: sourcesByPath.get(path) ?? [],
      unmapped: unmapped.has(path),
    }));
  }, [expected, expectedFiles, fileReviews, fileStates, sources, unmapped]);
  const groups = useMemo(() => navigationGroups(
    selectedAcceptanceCriterionId,
    reviewSlices,
    files,
  ), [files, reviewSlices, selectedAcceptanceCriterionId]);

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    let next: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % acceptanceCriteria.length;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      next = (index - 1 + acceptanceCriteria.length) % acceptanceCriteria.length;
    }
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = acceptanceCriteria.length - 1;
    if (next == null) return;

    event.preventDefault();
    const criterion = acceptanceCriteria[next];
    if (!criterion) return;
    onAcceptanceCriterionSelect(criterion.id);
    const tablist = event.currentTarget.closest<HTMLElement>("[role='tablist']");
    tablist?.querySelectorAll<HTMLButtonElement>("[role='tab']")[next]?.focus();
  };

  const setCollapsed = (id: string, collapsed: boolean): void => {
    setCollapsedIds(current => {
      const next = new Set(current);
      if (collapsed) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const focusItem = (item: HTMLElement | undefined | null): void => {
    if (!item) return;
    setFocusedItemId(item.dataset.treeItemId ?? "");
    item.focus();
  };

  const onTreeKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    const tree = event.currentTarget;
    const target = (event.target as HTMLElement).closest<HTMLElement>("[role='treeitem']");
    if (!target || !tree.contains(target)) return;
    const items = visibleTreeItems(tree);
    const current = items.indexOf(target);
    if (current < 0) return;

    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      let next = current;
      if (event.key === "ArrowDown") next = Math.min(items.length - 1, current + 1);
      if (event.key === "ArrowUp") next = Math.max(0, current - 1);
      if (event.key === "Home") next = 0;
      if (event.key === "End") next = items.length - 1;
      event.preventDefault();
      focusItem(items[next]);
      return;
    }

    if (event.key === "ArrowRight") {
      const group = childGroup(target);
      if (!group) return;
      event.preventDefault();
      const id = target.dataset.treeItemId ?? "";
      if (target.getAttribute("aria-expanded") === "false") {
        setCollapsed(id, false);
      } else {
        focusItem(visibleTreeItems(group)[0]);
      }
      return;
    }

    if (event.key === "ArrowLeft") {
      const group = childGroup(target);
      if (group && target.getAttribute("aria-expanded") === "true") {
        event.preventDefault();
        setCollapsed(target.dataset.treeItemId ?? "", true);
        return;
      }
      const parent = parentTreeItem(target);
      if (parent) {
        event.preventDefault();
        focusItem(parent);
      }
      return;
    }

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      target.click();
      return;
    }

    if (event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey) {
      const now = Date.now();
      const query = now - typeahead.current.at < 700
        ? `${typeahead.current.query}${event.key.toLocaleLowerCase()}`
        : event.key.toLocaleLowerCase();
      typeahead.current = { at: now, query };
      const ordered = [...items.slice(current + 1), ...items.slice(0, current + 1)];
      const match = ordered.find(item => item.textContent?.trim().toLocaleLowerCase().startsWith(query));
      if (match) {
        event.preventDefault();
        focusItem(match);
      }
    }
  };

  const nodeIds = groups.flatMap(group => [
    group.id,
    ...group.files.flatMap(file => [
      fileTargetId(file.path),
      ...(file.sources.length > 1 ? file.sources.map(sourceTargetId) : []),
    ]),
  ]);
  const effectiveFocusId = nodeIds.includes(focusedItemId) ? focusedItemId : nodeIds[0] ?? "";

  const treeItemProps = (id: string, viewed: boolean) => ({
    "aria-selected": selectedTargetId === id,
    "data-tree-item-id": id,
    "data-viewed": String(viewed),
    onFocus: () => setFocusedItemId(id),
    role: "treeitem" as const,
    tabIndex: effectiveFocusId === id ? 0 : -1,
  });

  return (
    <aside aria-label="Review navigator" className="review-navigator-pane" data-review-navigator="">
      <header className="review-pane-heading">
        <span className="review-pane-icon"><GitPullRequestArrow aria-hidden="true" size={16} /></span>
        <div>
          <h3>Intent navigator</h3>
          <p>Acceptance Criteria and Review Slices</p>
        </div>
      </header>

      <div aria-label="Acceptance Criteria" className="review-ac-tabs" role="tablist">
        {acceptanceCriteria.map((criterion, index) => {
          const selected = criterion.id === selectedAcceptanceCriterionId;
          const id = safeId(criterion.id);
          return (
            <button
              aria-controls={`review-ac-panel-${id}`}
              aria-selected={selected}
              data-acceptance-criterion={criterion.id}
              id={`review-ac-tab-${id}`}
              key={criterion.id}
              onClick={() => onAcceptanceCriterionSelect(criterion.id)}
              onKeyDown={event => onTabKeyDown(event, index)}
              role="tab"
              tabIndex={selected ? 0 : -1}
              type="button"
            >
              {criterion.id}
            </button>
          );
        })}
      </div>

      {acceptanceCriteria.map(criterion => {
        const selectedCriterion = criterion.id === selectedAcceptanceCriterionId;
        const id = safeId(criterion.id);
        return (
          <section
            aria-labelledby={`review-ac-tab-${id}`}
            className="review-ac-panel"
            data-acceptance-criterion-panel={criterion.id}
            hidden={!selectedCriterion}
            id={`review-ac-panel-${id}`}
            key={criterion.id}
            role="tabpanel"
          >
            <strong className="review-criterion-title">{criterion.title}</strong>
            {selectedCriterion ? (
              <div
                aria-label={`${criterion.id} Review Slice source tree`}
                className="review-source-tree"
                data-review-tree=""
                onKeyDown={onTreeKeyDown}
                role="tree"
              >
                {groups.map((group, groupIndex) => {
                  const collapsed = collapsedIds.has(group.id);
                  const firstFile = group.files.find(file => file.sources.length > 0) ?? group.files[0];
                  return (
                    <div className="review-tree-branch" key={group.id} role="none">
                      <div
                        {...treeItemProps(group.id, false)}
                        aria-expanded={!collapsed}
                        aria-level={1}
                        aria-posinset={groupIndex + 1}
                        aria-setsize={groups.length}
                        className="review-slice-row"
                        data-review-slice={group.slice?.task_id ?? "other"}
                        onClick={() => firstFile && onSelection(fileSelection(firstFile))}
                      >
                        <span className="review-tree-icon">
                          {group.slice
                            ? <GitPullRequestArrow aria-hidden="true" size={14} />
                            : <Files aria-hidden="true" size={14} />}
                        </span>
                        <span>
                          <strong>{group.slice?.task_id ?? "Patch Set"}</strong>
                          {group.label}
                        </span>
                        <span className="review-tree-count">{group.files.length}</span>
                      </div>
                      <div hidden={collapsed} role="group">
                        {group.files.map((file, fileIndex) => {
                          const viewed = file.review?.viewed === true;
                          const onlySource = file.sources.length === 1 ? file.sources[0] : undefined;
                          const fileId = fileTargetId(file.path);
                          const fileSelected = selectedTargetId === fileId
                            || (onlySource ? selectedTargetId === sourceTargetId(onlySource) : false);
                          const fileProps = treeItemProps(fileId, viewed);
                          return (
                            <div className="review-tree-branch" key={file.path} role="none">
                              <div
                                {...fileProps}
                                aria-expanded={file.sources.length > 1 ? !collapsedIds.has(fileId) : undefined}
                                aria-level={2}
                                aria-posinset={fileIndex + 1}
                                aria-selected={fileSelected}
                                aria-setsize={group.files.length}
                                className="review-source-row"
                                data-expected-file={file.expected ? file.path : undefined}
                                data-expected-file-state={String(file.expected)}
                                data-file-review={file.review ? "" : undefined}
                                data-file-viewed={file.review ? String(viewed) : undefined}
                                data-source-path={file.path}
                                data-unmapped={String(file.unmapped)}
                                onClick={() => onSelection(fileSelection(file))}
                              >
                                <span className="review-tree-icon"><FileCode2 aria-hidden="true" size={14} /></span>
                                <span className="review-source-row-label">{file.path}</span>
                                <span className={`review-viewed-state ${viewed ? "is-viewed" : "is-unviewed"}`}>
                                  {file.review
                                    ? viewed ? "Viewed" : "Not viewed"
                                    : file.expected ? "Expected only" : "Not reviewed"}
                                </span>
                              </div>
                              {file.sources.length > 1 ? (
                                <div hidden={collapsedIds.has(fileId)} role="group">
                                  {file.sources.map((source, sourceIndex) => {
                                    const sourceId = sourceTargetId(source);
                                    return (
                                      <div
                                        {...treeItemProps(sourceId, viewed)}
                                        aria-level={3}
                                        aria-posinset={sourceIndex + 1}
                                        aria-setsize={file.sources.length}
                                        className="review-hunk-row"
                                        data-hunk-id={source.hunkId}
                                        data-source-evidence-id={source.sourceEvidenceId}
                                        data-source-path={source.path}
                                        key={source.identity}
                                        onClick={() => onSelection({
                                          id: sourceId,
                                          path: source.path,
                                          sourceIdentity: source.identity,
                                        })}
                                      >
                                        <span className="review-tree-icon"><FileCode2 aria-hidden="true" size={13} /></span>
                                        <span>Hunk {source.hunkId.slice(0, 12)}</span>
                                        <span className="review-tree-count">{source.symbols.length}</span>
                                      </div>
                                    );
                                  })}
                                </div>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : null}
          </section>
        );
      })}
    </aside>
  );
}
