---
name: pair-plan-challenge
description: Challenge and refine `.pair/plan.md` in the agentic pair-programming protocol. Use when the challenger agent should review the plan for missing dependencies, poor stream boundaries, risky sequencing, hidden coupling, and unclear acceptance criteria, then write feedback to `.pair/review.md`.
---

# Pair Plan Challenge

Challenge the plan only. NEVER implement code. Your deliverable is `.pair/review.md`.

**Constraints:** Only edit files under `.pair/`. No builds or tests. Bash only for signaling.

## Steps

0. **Clear context** — run `/clear` to start fresh
1. **Read required inputs** in order:
   - `.pair/plan.md` (required)
   - `CLAUDE.md` or `ARCHITECTURE.md` if present
   - Verify all file paths mentioned in the plan exist; spot-check at least one code path per stream
   - Existing `.pair/review.md` if present
2. **Challenge** — stress-test for: stream boundaries not independently reviewable, sequencing ignores dependencies, hidden coupling, vague tasks missing file targets, incomplete/untestable acceptance criteria, missing S/M/L/XL sizing per task and stream total, optimistic assumptions not verified against actual code, unanswered open questions that block implementation
3. **Write `.pair/review.md`** using the format below
4. **Update `.pair/stream-log.md`** — append a heading `### YYYY-MM-DD HH:MM UTC — Plan Challenge` with:
   - **Agent:** `codex / <model>`
   - what was challenged, BLOCKER/IMPORTANT/NIT counts, files spot-checked, verdict
5. **Signal readiness**: write the current `dispatch_id` to `.pair/.ready`:
   ```bash
   jq -r '.dispatch_id' .pair/status.json > .pair/.ready
   ```
   The orchestrator reads `review.md` for BLOCKERs and handles all signaling. Do not call `pair-signal.sh`.
6. **Reply briefly** — whether plan is implementable as-is, blocker/important counts, top changes needed

## Severity

- `BLOCKER` — will cause churn or a failed review: bad sequencing, missing dependency, unverified assumption, missing sizing
- `IMPORTANT` — should fix before starting: vague task, weak acceptance criteria
- `NIT` — optional clarity improvement

## `.pair/review.md` Format

```markdown
# Review: Plan Challenge

**Reviewer:** `codex / <model>`
**Date:** `YYYY-MM-DD HH:MM UTC`

## Summary
[Short summary of plan quality and main concerns]

## Findings

### BLOCKER: [short title]
- **Section:** `Stream 1` / `Acceptance Criteria` / etc.
- **Issue:** [why this will fail or cause churn]
- **Suggested fix:** [concrete change to the plan]

### IMPORTANT: [short title]
- **Section:** ...
- **Issue:** ...
- **Suggested fix:** ...

### NIT: [short title]
- **Issue:** ...

## Verdict
[e.g. "No blockers. Plan is implementable." / "Blockers present; revise before implementation."]
```