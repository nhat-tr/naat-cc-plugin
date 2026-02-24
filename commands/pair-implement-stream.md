---
description: Implement the current stream from `.pair/plan.md`, run targeted verification, and append decisions/progress to `.pair/stream-log.md`. Does not perform reviewer duties.
---

# Pair Implement Stream

Implement the current stream using the **pair-stream-implementer** agent.

## What This Command Does

1. Reads `.pair/plan.md` and current pair context
2. Implements tasks for the current stream up to the next review boundary
3. Runs targeted checks when feasible
4. Updates `.pair/stream-log.md`
5. Responds briefly with files changed and readiness for review

## When to Use

- `.pair/status.json` says `waiting_for = "implement"`
- A stream is approved and ready for implementation

## Usage

```text
/pair-implement-stream
/pair-implement-stream Implement the current stream and update .pair/stream-log.md
```

## Important

- Keep changes scoped to the current stream.
- Do **not** write `.pair/review.md` (reviewer step owns that file).
