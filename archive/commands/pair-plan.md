---
description: Draft or update .pair/plan.md for the agentic pair-programming workflow. Routes to the sketcher (direction) or planner (detail) based on current phase.
---

# Pair Plan

Execute these instructions directly. Do NOT spawn a subagent.

**Read `.pair/status.json` and check `waiting_for` and `.pair/plan.md` before doing anything.**

## Routing

### `waiting_for = "plan-update"` → revise the plan

The challenger found blockers. Read `.pair/review.md`, then revise `.pair/plan.md` to address findings. Read codebase as needed. After revising, update `.pair/stream-log.md` and signal: `jq -r '.dispatch_id' .pair/status.json > .pair/.ready`

### `.pair/plan.md` missing or has no `<!-- plan-phase: sketch -->` marker → sketch phase

No sketch exists yet. Write the initial sketch.

**Phase 1 (always first):** Restate the problem + list assumptions. No sketch yet. The human confirms or corrects.
**Phase 2 (after confirmation):** Write the sketch based on confirmed understanding.

Do NOT write `.pair/plan.md` on your first response. Prove understanding first and wait for human validation.

**Sketch phase is multi-turn.** The human confirms understanding, gives feedback, iterates. Stop after each response.

### `.pair/plan.md` has `<!-- plan-phase: sketch -->` + explicit expand signal → detail phase

Expand signals: "expand", "go to detail", "looks good", "proceed", "done".

Read the codebase, fill in tasks + file hints + complexity estimates, and write the full detailed plan. May stop to ask follow-up questions if stream-shaping decisions are unresolved.

### `.pair/plan.md` has `<!-- plan-phase: sketch -->`, no expand signal → continue sketch iteration

Keep clarifying or update the sketch based on feedback. Do NOT expand to detail.

## Rules

- Do **not** implement code.
- The sketch phase does NOT read the codebase. The detail phase does.
- Sketch phase ends only when the human says so.
- Only edit files under `.pair/`. No builds or tests.