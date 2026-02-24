---
description: Address review findings in `.pair/review.md` (prioritizing BLOCKER/IMPORTANT), update code, run targeted verification, and append a fix summary to `.pair/stream-log.md`.
---

# Pair Fix Review

Fix review feedback using the **pair-review-fixer** agent.

## What This Command Does

1. Reads `.pair/review.md` and `.pair/plan.md`
2. Fixes `BLOCKER` and `IMPORTANT` findings first
3. Runs targeted checks when feasible
4. Updates `.pair/stream-log.md`
5. Responds briefly with resolved/deferred findings and re-review readiness

## When to Use

- `.pair/status.json` says `waiting_for = "fix"`
- The reviewer produced `.pair/review.md` findings for the current stream

## Usage

```text
/pair-fix-review
/pair-fix-review Address blockers and important findings in .pair/review.md
```

## Important

- Do **not** rewrite `.pair/review.md` unless explicitly asked.
- Keep scope aligned with the current stream and the review findings.
