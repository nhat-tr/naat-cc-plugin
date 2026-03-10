---
description: Draft or update .pair/plan.md for the agentic pair-programming workflow. Routes to the sketcher (direction) or planner (detail) based on current phase.
---

# Pair Plan

**Read `.pair/status.json` and check `waiting_for` and `.pair/plan.md` before doing anything.**

## Routing

### `waiting_for = "plan-update"` → use `pair-planner`

The challenger found blockers. Invoke the `pair-planner` agent to revise the plan.

### `.pair/plan.md` missing or has no `<!-- plan-phase: sketch -->` marker → use `pair-sketcher`

No sketch exists yet. Invoke the `pair-sketcher` agent to write the initial sketch.

The sketcher has a two-phase flow:
1. **Phase 1 (always first):** Restate the problem + list assumptions. No sketch yet. The human confirms or corrects.
2. **Phase 2 (after confirmation):** Write the sketch based on confirmed understanding.

The sketcher will NOT write `.pair/plan.md` on its first response. It will prove understanding first and wait for human validation.

**Sketch phase is multi-turn.** The human confirms understanding, gives feedback on the sketch, and iterates. The sketcher stops after each response. This repeats until the human explicitly says to expand.

### `.pair/plan.md` has `<!-- plan-phase: sketch -->` + explicit expand signal → use `pair-planner`

Expand signals: "expand", "go to detail", "looks good", "proceed", "done".

Invoke the `pair-planner` agent to read the codebase, fill in tasks + file hints + complexity estimates, and write the full detailed plan.

The planner may still stop to ask follow-up questions if stream-shaping decisions are unresolved. Expand is approval to detail, not approval to guess.

### `.pair/plan.md` has `<!-- plan-phase: sketch -->`, no expand signal → continue sketch iteration

The human is still in sketch phase. Keep clarifying or update the sketch based on their feedback. Do NOT invoke `pair-planner`. Do NOT expand to detail.

## Important

- Do **not** implement code.
- The sketcher does NOT read the codebase. The planner does.
- Sketch phase ends only when the human says so.
