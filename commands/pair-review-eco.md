---
description: Token-efficient stream review using diff-first analysis. Same BLOCKER/IMPORTANT/NIT quality as pair-review, with fewer reads. Use for S/M-complexity streams (refactors, config changes, mechanical additions) — not for new behavior.
---

# Pair Review (Eco)

Use the **pair-reviewer-eco** agent via the Agent tool (`subagent_type: "pair-reviewer-eco"`).

The agent checks eco scope first — if the stream is L/XL or introduces new behavior, it will recommend switching to the full `pair-reviewer`. Otherwise it reviews diff-first with minimal reads and writes `.pair/review.md`.

## When to Use

- `.pair/status.json` says `waiting_for = "review"`
- Stream is S or M complexity: refactor, rename, config, wiring, tests for existing behavior
