---
description: Draft or update .pair/plan.md for the agentic pair-programming workflow. Produces a stream-based implementation plan with review boundaries, acceptance criteria, and risks. Writes the plan file and does not implement code.
---

# Pair Plan

**Before doing anything else, read `.pair/status.json` now and check `waiting_for`.**

## If `waiting_for = "plan-update"` — revise existing plan

1. Read `.pair/review.md` — identify every BLOCKER and IMPORTANT finding
2. Read `.pair/plan.md` — understand the current plan
3. Revise `.pair/plan.md` to address all BLOCKER and IMPORTANT findings; preserve LGTM sections
4. Signal: run `bash ~/.dotfiles/scripts/pair-signal.sh plan-review`

## If `waiting_for` is anything else — draft new plan

1. Ask the user for the task description if not already provided in the command arguments
2. Analyze the codebase and draft `.pair/plan.md` with parallel streams
3. Do **not** signal — orchestrator handles auto-progression in auto mode; human triggers challenge otherwise

## Output Contract (`.pair/plan.md`)

- `# Task: ...`
- `## Context`
- `## Stream Graph` — which streams can run in parallel vs sequential
- `## Streams`
- `### Stream N: ...` with `**Depends on:** none | Stream X` header
- task checkboxes with likely file paths
- `**Review boundary**` for each stream
- `## Acceptance Criteria`
- `## Risks & Decisions Needed`

## Important

- Do **not** implement code.
- If `.pair/plan.md` already exists, update it carefully instead of blindly overwriting useful details.
- Prefer explicit assumptions over vague wording.