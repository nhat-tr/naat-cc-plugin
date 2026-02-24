---
name: pair-fix-review
description: Address review feedback in `.pair/review.md` during the agentic pair-programming protocol. Use when the implementation agent should fix `BLOCKER` and `IMPORTANT` findings, update code and `.pair/stream-log.md`, and prepare the stream for re-review.
---

# Pair Fix Review

Use this skill when the implementation agent is fixing reviewer feedback.

## Metadata

- Runtime: `codex`
- Claude command: `commands/pair-fix-review.md`
- Claude agent: `agents/pair-review-fixer.md`
- Command alias in Claude: `/pair-fix-review`

## Workflow

1. Load source docs:
   - `../../commands/pair-fix-review.md`
   - `../../agents/pair-review-fixer.md`
2. Read `.pair/review.md` and `.pair/plan.md` (required).
3. Fix `BLOCKER` and `IMPORTANT` findings first.
4. Run targeted verification when feasible.
5. Append a fix summary to `.pair/stream-log.md`.

## Rules

- Fix review findings; do not rewrite `.pair/review.md` unless explicitly asked.
- Stay within the stream scope unless a fix requires a documented exception.
- Be explicit about deferred or disputed findings.
