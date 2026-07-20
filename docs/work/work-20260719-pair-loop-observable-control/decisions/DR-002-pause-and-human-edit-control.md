# DR-002: Exact-phase pause and human edit control

- **Schema:** 1
- **Status:** accepted
- **Work ID:** `work-20260719-pair-loop-observable-control`
- **Origin Spec:** `docs/work/work-20260719-pair-loop-observable-control/spec.md`
- **Acceptance Criteria:** AC-3, AC-4, AC-8, AC-9, AC-10, AC-14
- **Supersedes:** none
- **Superseded By:** none

## Context

The canonical specification requires resumable attempts, explicit pause, and preserved green work, but does not define pause boundaries or a safe path for manual plan and code changes. The current workflow treats pause like stop-and-restart, cannot pause review independently, and risks invalidating or duplicating evidence when a human edits files outside the agent turn. Cheap deterministic plan defects also consume reviewer tokens before an agent can assess semantics.

## Decision

Make pause, resume, validation, and human edits explicit states in the repository projection.

- Pause applies during plan review, implementation, implementation review, and cumulative review. It stops new dispatch after the next completed model or tool boundary, persists the exact active phase, and leaves the tmux-hosted process available.
- Resume dispatches to the saved phase and attempt. It never defaults to a generic ready state or opens a new Review Slice while an attempt remains actionable.
- `Cancel now` aborts only the in-flight request and resumes from the last completed checkpoint. Pair does not freeze an HTTP request with `SIGSTOP` and does not discard repository changes.
- A human edit begins only after pause records the plan and patch base digests and grants the human exclusive edit control.
- A plan save runs deterministic parsing, task-marker normalization, invariant validation, repository-confined path resolution, pre-existing-path checks, and semantic-digest calculation before review. A semantic change invalidates exact-digest approval; marker-only progress changes do not.
- A code save records before and after patch digests, marks only affected evidence stale, reruns required verification, and sends the complete preserved patch to visible independent review.
- Out-of-band edits produce a warning and enter the same reconciliation path; Pair never silently restores them.

## Rationale

Persisting the exact phase makes process exit and pause recoverable without inventing failure. A controlled human-edit state preserves user agency while keeping approval and evidence honest. Deterministic validation rejects reproducible structural defects before spending review tokens, leaving the Review Session to judge semantics and implementation quality.

## Alternatives Rejected

- **Terminate and restart every paused phase (2/10):** expensive and loses exact review or implementation continuity.
- **Freeze an in-flight request with `SIGSTOP` (3/10):** can convert pause into a transport timeout and leaves no safe application boundary.
- **Allow ad-hoc edits with no exclusive state (2/10):** makes patch attribution and evidence freshness race-dependent.
- **Let reviewers repair malformed plans (4/10):** spends model tokens on deterministic defects and mixes validation with semantic judgment.

## Consequences

- Repository state must represent plan validation, plan review, implementation, verification, implementation review, cumulative review, paused, human editing, recovery, and terminal Work states explicitly.
- Every pause records a Resume Checkpoint and the saved active phase; every resume emits an observable dispatch reason.
- Review approval is valid only for the exact semantic plan or complete-patch digest it reviewed.
- Human edits never bypass verification, independent review, complete-patch attribution, or the Engineering Quality Contract.
- Failure to launch verification or review preserves the current phase, patch, and green evidence and resumes that evidence phase later.

## Evidence

- Approved Architecture Canvas Revision: `57462d46`
- Current plan validator already rejects unknown AC references, path escapes, slice-budget excess, missing test ownership, and absent integration proof
- Codex and Claude hooks expose `session_id` and `cwd`, allowing owner-scoped continuation
- Current reviewers disable session persistence and cannot resume the saved review phase
- Canonical decisions: `docs/work/work-20260719-pair-loop-observable-control/spec.md#d-2-attempts-survive-processes-and-resume-phases`

## Implementation

- Base: not started
- Changes: not started

## Outcomes

None yet.

## Learning

Pause is a durable state transition at an application boundary, not a process signal; human editing is an ownership transfer with explicit evidence invalidation, not an exceptional escape hatch.
