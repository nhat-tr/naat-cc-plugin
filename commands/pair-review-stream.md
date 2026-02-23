---
description: Review the current pair-protocol stream implementation and write `.pair/review.md` with structured findings (BLOCKER/IMPORTANT/NIT) and a verdict. Does not implement fixes.
---

# Pair Review Stream

Review the current stream and write `.pair/review.md` using the **pair-stream-reviewer** agent.

## What This Command Does

1. **Loads pair context** — reads `.pair/plan.md`, `.pair/stream-log.md`, and current state
2. **Reviews the stream diff** — focuses on the current stream boundary, not the entire repo
3. **Finds risks and regressions** — correctness, missing handling, contract mismatches, test gaps
4. **Writes `.pair/review.md`** — structured findings and verdict
5. **Responds briefly** — summarizes blockers and next action

## When to Use

- `.pair/status.json` says `waiting_for = "review"`
- Codex reaches a stream `**Review boundary**`
- You want Claude to perform the reviewer role in the pair protocol

## Usage

```text
/pair-review-stream Review stream 1 implementation and write .pair/review.md
/pair-review-stream Review the current stream diff against the plan
```

## Output Contract (`.pair/review.md`)

Use this shape:

- `# Review: Stream N` (or current stream label)
- `## Summary`
- `## Findings`
- `### BLOCKER: ...` / `### IMPORTANT: ...` / `### NIT: ...`
- `## Verdict`

Include file paths and line references when possible.

## Important

- Do **not** implement code.
- Focus on the current stream, not unrelated repo issues.
- If there are no findings, say so explicitly and note residual risk/testing gaps.
