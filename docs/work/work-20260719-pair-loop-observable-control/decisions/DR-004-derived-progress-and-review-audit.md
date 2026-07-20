# DR-004: Derived progress and review audit

- **Schema:** 1
- **Status:** accepted
- **Work ID:** `work-20260719-pair-loop-observable-control`
- **Origin Spec:** `docs/work/work-20260719-pair-loop-observable-control/spec.md`
- **Acceptance Criteria:** AC-1, AC-2, AC-5, AC-9, AC-13, AC-14
- **Supersedes:** none
- **Superseded By:** none

## Context

The accepted Architecture Canvas defines several observable details that are easy to lose in a generic “visible coordinator” implementation: short task markers must remain derived rather than becoming a second state store, exact-digest approval needs a complete readable review history, and one Review Session must remain recognizable across plan, implementation, and cumulative review. The event schema must also leave a stable seam for the explicitly deferred worktree extension without implementing that extension now.

## Decision

- Treat `[ ]` as queued, `[-]` as active, and `[x]` as accepted. Only this short marker changes in `.pair/plan.md`; phase detail remains in repository status.
- Normalize all three markers when computing the semantic plan digest, so derived progress never invalidates exact-digest approval.
- Persist `.pair/plan-reviews/summary.md` with every plan review, finding, resolution patch reference, reviewer model and effort, token totals, approval kind, and final reason.
- Reuse the same visible, controllable, read-only Review Session for plan review, Review Slice review, and the final complete-Work-patch review.
- Reserve nullable `worktree_id` and base-digest fields in repository events. They are compatibility seams only: this Work starts no implementation worker or worktree.

## Rationale

Derived markers make the plan readable without splitting authority between checkboxes and the reducer. A complete plan-review summary lets a human approve the exact digest with enough context to understand the residual risk. Reusing the Review Session keeps independent-review identity and history visible. Reserving two inert event fields prevents a later worktree Work from replacing the reducer contract while preserving the approved no-worker baseline.

## Alternatives Rejected

- **Status only, with no short task marker (6/10):** authoritative but makes the plan harder to scan during active Work.
- **Write phase detail into task prose (3/10):** mutates the reviewed contract and invalidates approval for bookkeeping changes.
- **Keep only the latest plan verdict (4/10):** hides prior findings, resolutions, cost, and the basis for a human override.
- **Start a fresh reviewer for every phase (5/10):** preserves independence but loses the visible continuity the user selected.
- **Implement worktree workers now (2/10):** expands scope before the single-writer visible baseline is proven.

## Consequences

- Plan validation, progress updates, and approval checks share one marker-normalization function.
- The plan-review summary is repository-local Pair state and is updated atomically from immutable review events.
- Review Session identity and the digest under review are visible in status and evidence.
- Future worktree fields remain null in this Work and cannot activate routing or ownership behavior.

## Evidence

- Approved Architecture Canvas Revision: `57462d46`
- Canvas states “Treat `[ ]` queued, `[-]` active, and `[x]` accepted as derived progress that never changes the semantic plan digest.”
- Canvas plan approval links `plan-reviews/summary.md` with every review, finding, resolution, model/effort/tokens, and final reason.
- Canvas repository state reserves `worktree_id` and base digest while placing parallel worktrees explicitly out of scope.

## Implementation

- Base: not started
- Changes: not started

## Outcomes

None yet.

## Learning

Human-readable progress and auditability remain trustworthy only when they are projections of immutable events, not competing sources of workflow truth.
