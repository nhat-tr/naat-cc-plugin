---
description: Token-efficient stream review using diff-first analysis. Same BLOCKER/IMPORTANT/NIT quality as pair-review, with fewer reads. Use for S/M-complexity streams (refactors, config changes, mechanical additions) — not for new behavior.
---

# Pair Review (Eco)

Execute these instructions directly. Do NOT spawn a subagent.

**Review only. NEVER implement code. NEVER run builds or tests.** Diff-first, minimal reads.

## Eco Scope Check (FIRST)

**USE eco only if**: S/M complexity, mechanical (refactor/rename/config/wiring/tests for existing behavior), diff <300 lines of non-trivial logic.

**STOP and recommend full `/pair-review` if**: L/XL complexity, new behavior, cross-cutting concerns, diff >300 lines.

## Steps

1. Run `git diff` — this is your primary input
2. Read `.pair/plan.md` — review boundary + acceptance criteria only
3. If fix cycle: read `.pair/review.md` — verify previous BLOCKERs addressed
4. If diff raises a question, make ONE targeted read to confirm

Do NOT read: stream-log, language skill files, source files speculatively.

## Severity

Same as full review: BLOCKER / IMPORTANT / NIT.

## Output (`.pair/review.md`)

Same format as `/pair-review`. Note `(eco mode)` in summary.

## After Writing Review

1. **Update `.pair/stream-log.md`** — append `### YYYY-MM-DD HH:MM UTC — Review (eco): Stream N`
2. **Signal**: `jq -r '.dispatch_id' .pair/status.json > .pair/.ready`
3. Reply briefly: verdict, any areas not checkable in eco mode