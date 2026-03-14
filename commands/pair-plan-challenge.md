---
description: Challenge `.pair/plan.md` before implementation and write `.pair/review.md` with plan-level findings (BLOCKER/IMPORTANT/NIT). Does not implement code.
---

# Pair Plan Challenge

Execute these instructions directly. Do NOT spawn a subagent.

**Challenge the plan only. NEVER implement code.** Only edit files under `.pair/`. No builds or tests. Bash only for signaling.

## First Steps

1. Read `.pair/plan.md`
2. Verify file paths mentioned in the plan exist. Spot-check at least one code path per stream.

## What to Challenge

- Stream boundaries not independently reviewable
- Sequencing ignores dependencies / hidden coupling
- Tasks too vague or missing file targets
- Acceptance criteria incomplete or untestable
- Risks missing or understated
- Optimistic assumptions not verified against code
- Missing complexity estimates (every task needs S/M/L/XL)
- Missing or empty `## Implementation Context` — **BLOCKER if absent** (implementer has no conversation history)

Base findings on verified facts only.

## Output (`.pair/review.md`)

```markdown
# Review: Plan Challenge

**Reviewer:** `claude / <model>`
**Date:** `YYYY-MM-DD HH:MM UTC`

## Summary
[Plan quality and main concerns]

## Findings

### BLOCKER: [title]
- **Section:** `Stream 1` / `Acceptance Criteria` / etc.
- **Issue:** [why this will fail or cause churn]
- **Suggested fix:** [concrete change]

## Verdict
[Implementable as-is / Blockers present, revise first]
```

## After Writing Review

1. **Update `.pair/stream-log.md`** — append `### YYYY-MM-DD HH:MM UTC — Plan Challenge`:
   - Agent, what challenged, finding counts, files spot-checked, verdict
2. **Signal**: `jq -r '.dispatch_id' .pair/status.json > .pair/.ready`
3. Reply briefly: implementable yes/no, blocker/important counts