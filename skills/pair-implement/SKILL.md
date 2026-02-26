---
name: pair-implement
description: Implement the current stream from `.pair/plan.md` or fix review findings from `.pair/review.md`. Reads `.pair/status.json` to determine mode (implement or fix). Runs targeted verification and updates `.pair/stream-log.md`.
---

# Pair Implement

Use this skill when the implementation agent should make code changes — either implementing from the plan or fixing review findings.

## Metadata

- Runtime: `codex`
- Claude command: `commands/pair-implement.md`
- Claude agent: `agents/pair-implementer.md`
- Command alias in Claude: `/pair-implement`

## Workflow

1. Load source docs:
   - `../../commands/pair-implement.md`
   - `../../agents/pair-implementer.md`
2. Read `.pair/status.json` to determine mode (`waiting_for=implement` or `waiting_for=fix`).
3. Read `.pair/plan.md` (required) and `.pair/review.md` (required if fixing).
4. Implement tasks or fix findings for the current stream.
5. Run targeted verification when feasible.
6. **Update `.pair/stream-log.md`** — append: stream/task ID, what changed, files touched, verification result, decisions made.
7. **Signal review**: run `bash ~/.dotfiles/scripts/pair-signal.sh review` so the reviewer agent starts automatically. **Do not signal without updating the stream log first.**

## Rules

- Implement code; do not write review findings to `.pair/review.md`.
- Keep changes scoped to the current stream unless a dependency forces an exception (log it).
- If the plan is ambiguous or infeasible, stop and report the gap clearly.
