---
name: pair-plan
description: Draft or update `.pair/plan.md`. Two phases — sketcher writes a high-level draft; planner expands to full detail after human review.
---

# Pair Plan

Plan only — never implement. Deliverable: `.pair/plan.md`.

**Constraints**: edit only under `.pair/`. No builds or tests. Sketch phase does NOT read the codebase; detail/update phases may.

## Metadata

- Claude command: `commands/pair-plan.md`
- Claude agents: `agents/pair-sketcher.md` (sketch), `agents/pair-planner.md` (detail / update)

## Enhanced Mode Detection

Enhanced mode = `.pair/spec.md` exists AND has real feature content (not `[Feature Name]` placeholders).

In enhanced mode:
- `.pair/spec.md` is source of truth
- Every stream cites AC IDs via `Satisfies: F1.AC1, ...` and every AC is covered
- **Anchor propagation (required)**:
  - Phase 1 Intent Check is derived from the spec's anchor (Outcome ← Purpose, Out-of-scope ← Contrasts, Constraints ← Rejection Criteria)
  - Phase 2 streams each cite `Serves Purpose`, `Respects Rejection Criteria`, `Does not implement Contrast`. Tautological citations fail review.
- Plan-challenge verifies AC coverage + anchor alignment; misses are BLOCKER.

**Stream Type** (required both modes): every Phase 2 stream has a `**Type:**` line with tags from `{static, service, frontend}`, comma-separated. Implementer routes verification from this.

Classic mode (no `.pair/spec.md`): skip AC/anchor requirements; Type still required.

## Mode Selection

Read `.pair/status.json:waiting_for`:

- **`plan`** (enhanced): generate full plan from `.pair/spec.md`. Save to `.pair/plan.md`, no git commit, no execution prompt. Signal.
- **`plan-update`**: read `.pair/review.md`, address BLOCKER + IMPORTANT findings, signal.
- **`plan-detail`**: human approved high-level draft (or brainstorming-seeded sketch). Expand in-place. Do NOT signal.
- **anything else / initial**: Phase 1 sketch. Set `waiting_for = "plan-detail"`. Do NOT signal.

## Required Inputs

1. `.pair/context.md` **(required)** — output `[context] context.md loaded`. If missing: halt and report.
2. `.pair/status.json` — mode
3. `.pair/plan.md` (if exists)
4. `.pair/review.md` (required in plan-update)
5. Relevant code paths

## Workflow

**If must-know questions remain: STOP. Ask (max 3) and wait.**

### Phase 1 (initial — sketcher)

First response is NEVER a sketch. Unconditional — no matter how clear the request seems. It is:

1. Restate the problem in own words (no solution language)
2. List assumptions that would change the approach if wrong
3. State genuine unknowns
4. STOP and wait for human confirmation

After confirmation:

1. Do NOT read the codebase. Use task description + `.pair/context.md` + prior sketch feedback only.
2. Write `.pair/plan.md` high-level only: Task, Intent Check, Proposed Approach (prose), Proposed Streams (names + one-liner, no file paths), Key Risks, Acceptance Criteria.
3. Update `.pair/stream-log.md`.
4. Set `waiting_for = "plan-detail"` via jq (no `pair-signal.sh`). Stop.

### Phase 2 (`plan-detail` — planner)

**If `.pair/plan.md` was seeded by brainstorming** (has stream names but no file paths): treat the stream breakdown as human-approved. Open with one message: list the streams you see and any genuine gaps not covered by the spec or sketch (implementation surface unclear, migration risk, compatibility constraint). Ask max 3 questions; if none, proceed immediately.

**If arriving from Phase 1 sketch**: before expansion, confirm you know: solution direction chosen, surface/owner, user-visible/API/data/migration/compatibility expectations, acceptance proof. If unclear: ask up to 3 concise questions and stop.

1. Read existing `.pair/plan.md`.
2. **Enhanced mode**: also read `.pair/spec.md` (Core Anchor + AC list). Keep anchor in working memory.
3. Expand in-place: Implementation Context, Stream Graph, per-stream task checkboxes with file paths, complexity estimates, Review Boundaries, Acceptance Criteria.
4. Per stream: list real test names (e.g. `Action_WhenScenario_ThenExpectation` for NUnit). No placeholders.
5. **Enhanced mode — per stream (required)**:
   - `**Serves Purpose:**` one sentence (use spec's wording)
   - `**Respects Rejection Criteria:**` `R1: ...; R2: ...` (omit RCs that don't apply)
   - `**Does not implement Contrast:**` confirm
   Tautological citations flagged BLOCKER at challenge.
6. Update `.pair/stream-log.md`. Stop (no signal).

### `plan-update` mode

1. Read `.pair/review.md` + `.pair/plan.md`.
2. Address all BLOCKER + IMPORTANT findings.
3. Update `.pair/stream-log.md`.
4. Signal (see below).

## Plan Format

### Phase 1 — High-level draft

```markdown
# Task: [title]

## Intent Check
- Outcome: [one sentence]
- Primary scenario: [one sentence]
- Out of scope: [one sentence]
- Constraints / preferences: [one sentence or "none stated"]

## Context
Why we're doing this — 2–3 sentences.

## Proposed Approach
Prose. No file paths.

## Rough Stream Breakdown
- Stream 1: [name] — [one-line description]
- Stream 2: [name] — [one-line description]

## Key Risks & Decisions Needed
- [risk or open question]

## Open Questions
- [non-blocking only]
```

### Phase 2 / `plan-update` — Full detail

```markdown
# Task: [title]

## Context
Why we're doing this. Links to relevant code.

## Implementation Context
<!-- REQUIRED — implementer has no conversation history. -->
- **Language / Framework:** (e.g. C# .NET 10 / NUnit)
- **Key decisions from planning:**
- **Patterns to follow:** (e.g. "primary constructors — see UserService.cs")
- **Patterns to avoid:** (e.g. "no AutoMapper, no FluentAssertions")
- **Non-obvious constraints:** (e.g. "MIT/Apache-2 licenses only")

## Stream Graph
Streams 1, 2 → parallel (no shared files)
Stream 3 → after Stream 1

## Streams

### Stream 1: [name] — complexity: M
**Depends on:** none
**Type:** service, frontend

- [ ] Task 1.1: [description] — files: `path/to/file` — **S**
- [ ] Task 1.2: [description] — files: `path/to/file` — **M**
- **Tests:**
  - `MethodName_WhenScenario_ThenExpectation`
- **Satisfies:** F1.AC1, F1.AC2 *(enhanced mode)*
- **Serves Purpose:** [one sentence] *(enhanced mode)*
- **Respects Rejection Criteria:** R1: [why not]; R2: [why not] *(enhanced mode)*
- **Does not implement Contrast:** [confirm] *(enhanced mode)*
- **Review boundary**

### Stream 2: [name] — complexity: S
Same format as Stream 1. `**Type:**` required (e.g. `**Type:** static`).

## Open Questions
- [question] — impact: [which stream/task]

## Acceptance Criteria
- [ ] Tests pass (relevant scope)
- [ ] No new lint errors
- [ ] [domain-specific]

## Risks & Decisions Needed
- Risk: [risk] → mitigation: [mitigation]
```

**Complexity**: S = <15min, M = 15–60min, L = 1–3h, XL = split.

## Stream Log Update (REQUIRED)

Append to `.pair/stream-log.md` with heading `### YYYY-MM-DD HH:MM UTC — Plan: initial` (or `plan-detail` / `plan-update`):

- **Agent:** `codex / <model>`
- mode, what changed, open questions + resolution, key decisions

## Signal Readiness

- **`plan-update`**: `jq -r '.dispatch_id' .pair/status.json > .pair/.ready`. Orchestrator handles the rest.
- **Phase 1 (initial)**: set `waiting_for = "plan-detail"` without bumping `dispatch_id`:
  ```bash
  tmp="$(mktemp)" && jq '.waiting_for = "plan-detail"' .pair/status.json > "$tmp" && mv "$tmp" .pair/status.json
  ```
  Do NOT write `.ready`. Stop.
- **Phase 2 (`plan-detail`)**: do NOT write `.ready`. Stop — human reviews, then triggers challenge.

## Response After Writing

- Mode (Phase 1 / Phase 2 / plan-update)
- Approach (Phase 1) or streams created/updated
- Key changes (plan-update)
- Key risks/unknowns
- Next: "Run `/pair-plan` to expand" (Phase 1) or "Review + `/pair-plan-challenge`" (Phase 2)

Don't paste the whole plan unless asked.
