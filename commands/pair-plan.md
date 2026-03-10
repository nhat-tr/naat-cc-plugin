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

The sketcher will:
1. Read `.pair/context.md` and the task description
2. Write a short sketch (approach + stream names + questions) to `.pair/plan.md`
3. Stop — the human iterates in conversation

**Sketch phase is multi-turn.** The human asks questions and gives feedback; the sketcher updates `.pair/plan.md` and stops again. This repeats until the human explicitly says to expand.

### `.pair/plan.md` has `<!-- plan-phase: sketch -->` + explicit expand signal → use `pair-planner`

Expand signals: "expand", "go to detail", "looks good", "proceed", "done".

Invoke the `pair-planner` agent to read the codebase, fill in tasks + file hints + complexity estimates, and write the full detailed plan.

### `.pair/plan.md` has `<!-- plan-phase: sketch -->`, no expand signal → continue sketch iteration

The human is still in sketch phase. Update the sketch based on their feedback. Do NOT invoke `pair-planner`. Do NOT expand to detail.

## Important

- Do **not** implement code.
- The sketcher does NOT read the codebase. The planner does.
- Sketch phase ends only when the human says so.