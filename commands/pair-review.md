---
description: Review the current pair-protocol stream implementation and write `.pair/review.md` with structured findings (BLOCKER/IMPORTANT/NIT) and a verdict. Does not implement fixes.
---

# Pair Review

Review the current stream and write `.pair/review.md` using the **pair-reviewer** agent.

## What This Command Does

1. **Loads pair context** — reads `.pair/plan.md`, `.pair/stream-log.md`, and current state
2. **Reviews the stream diff** — focuses on the current stream boundary, not the entire repo
3. **Finds risks and regressions** — correctness, missing handling, contract mismatches, test gaps
4. **Writes `.pair/review.md`** — structured findings and verdict
5. **Signal next agent**: if any BLOCKER found, run `bash ~/.dotfiles/scripts/pair-signal.sh fix` to auto-chain to implementer. If no blockers, do NOT signal (human decides next step).
6. **Responds briefly** — summarizes blockers and next action

## When to Use

- `.pair/status.json` says `waiting_for = "review"`
- The implementer reaches a stream `**Review boundary**`

## Usage

```text
/pair-review
/pair-review Review the current stream diff against the plan
```

## Important

- Do **not** implement code.
- Focus on the current stream, not unrelated repo issues.
- If there are no findings, say so explicitly and note residual risk/testing gaps.
