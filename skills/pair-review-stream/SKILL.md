---
name: pair-review-stream
description: Review the current stream in the agentic pair-programming protocol and write structured findings to `.pair/review.md`. Use when a stream hits a review boundary and the reviewer agent should check implementation quality before the next stream starts.
---

# Pair Review Stream

Use this skill at a stream review boundary.

## Metadata

- Runtime: `codex`
- Claude command: `commands/pair-review-stream.md`
- Claude agent: `agents/pair-stream-reviewer.md`
- Command alias in Claude: `/pair-review-stream`

## Workflow

1. Load source docs:
   - `../../commands/pair-review-stream.md`
   - `../../agents/pair-stream-reviewer.md`
2. Read `.pair/plan.md`, `.pair/stream-log.md`, and existing `.pair/review.md` if present.
3. Review the current stream diff and touched files.
4. Write structured findings to `.pair/review.md`.
5. Return a brief verdict and call out blockers clearly.

## Rules

- Review only (no code changes).
- Write findings to `.pair/review.md`, not chat-only output.
- Prioritize correctness/regression risk over style.
- Use `BLOCKER`, `IMPORTANT`, and `NIT` severities.
