---
description: Implement the current stream or fix review findings. Reads `.pair/status.json` to determine mode, makes code changes, runs targeted verification, and updates `.pair/stream-log.md`.
---

# Pair Implement

Implement code or fix review findings using the **pair-implementer** agent.

## What This Command Does

1. Reads `.pair/status.json` to determine mode (implement or fix)
2. In **implement** mode: implements plan tasks up to the review boundary
3. In **fix** mode: addresses BLOCKER and IMPORTANT findings from `.pair/review.md`
4. Runs targeted checks when feasible
5. **Updates `.pair/stream-log.md`** — append what changed, files touched, verification result, decisions made
6. **Signal review**: run `bash ~/.dotfiles/scripts/pair-signal.sh review` so the reviewer agent starts automatically. **Do not signal without updating the stream log first.**

## When to Use

- `.pair/status.json` says `waiting_for = "implement"` or `waiting_for = "fix"`
- A stream is approved and ready for implementation, or review findings need fixing

## Usage

```text
/pair-implement
/pair-implement Implement the current stream
```

## Important

- Keep changes scoped to the current stream.
- Do **not** write `.pair/review.md` (reviewer step owns that file).
