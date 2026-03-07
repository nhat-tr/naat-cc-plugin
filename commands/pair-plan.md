---
description: V1.2 Draft or update .pair/plan.md for the agentic pair-programming workflow. Two-phase: Phase 1 writes a high-level draft for human review; Phase 2 expands to full stream detail after confirmation.
---

# Pair Plan

**Before doing anything else, read `.pair/status.json` now and check `waiting_for`.**

## If `waiting_for = "plan-update"` — revise existing plan

1. Read `.pair/review.md` — identify every BLOCKER and IMPORTANT finding
2. Read `.pair/plan.md` — understand the current plan
3. Revise `.pair/plan.md` to address all BLOCKER and IMPORTANT findings; preserve LGTM sections
4. Signal readiness: write the current `dispatch_id` to `.pair/.ready`:
   ```bash
   jq -r '.dispatch_id' .pair/status.json > .pair/.ready
   ```
   The orchestrator chains back to the challenger. Do not call `pair-signal.sh`.

## If `waiting_for = "plan-detail"` — Phase 2: expand to full detail

1. Read the existing high-level `.pair/plan.md`
2. Expand in-place to full detail: Implementation Context, Stream Graph, per-stream task checkboxes with file paths, complexity estimates, Review Boundary, Acceptance Criteria
3. Update `.pair/stream-log.md`
4. Do **not** write `.ready` — stop here; human reviews the full plan then triggers `/pair-plan-challenge`

## If `waiting_for` is anything else — Phase 1: high-level draft

1. Ask the user for the task description if not already provided in the command arguments
2. Read the codebase enough to form a confident approach — stop and ask must-know questions if needed
3. Write `.pair/plan.md` with **high-level content only**: Task, Context, proposed approach (prose), rough stream list (names + one-liner, no file paths), Key Risks & Open Questions
4. Set `waiting_for = "plan-detail"` in `.pair/status.json` **without** incrementing `dispatch_id` (direct jq write, not pair-signal.sh):
   ```bash
   tmp="$(mktemp)" && jq '.waiting_for = "plan-detail"' .pair/status.json > "$tmp" && mv "$tmp" .pair/status.json
   ```
5. Stop — orchestrator will notify human; human re-runs `/pair-plan` to trigger Phase 2

## Output Contract (`.pair/plan.md`)

- `# Task: ...`
- `## Context`

- `## Implementation Context`
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
