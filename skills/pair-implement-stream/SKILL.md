---
name: pair-implement-stream
description: Implement the current stream from `.pair/plan.md` in the agentic pair-programming protocol. Use when the implementation agent owns `waiting_for=implement` and should make code changes, run targeted verification, and update `.pair/stream-log.md`.
---

# Pair Implement Stream

Use this skill when the implementation agent owns the current stream.

## Metadata

- Runtime: `codex`
- Claude command: `commands/pair-implement-stream.md`
- Claude agent: `agents/pair-stream-implementer.md`
- Command alias in Claude: `/pair-implement-stream`

## Workflow

1. Load source docs:
   - `../../commands/pair-implement-stream.md`
   - `../../agents/pair-stream-implementer.md`
2. Read `.pair/plan.md` (required) and `.pair/status.json` if present.
3. Implement tasks for the current stream up to the next `**Review boundary**`.
4. Run targeted verification when feasible.
5. Append a concise update to `.pair/stream-log.md`.

## Rules

- Implement code; do not write review findings to `.pair/review.md`.
- Keep changes scoped to the current stream unless a dependency forces an exception (log it).
- If the plan is ambiguous or infeasible, stop and report the gap clearly.
