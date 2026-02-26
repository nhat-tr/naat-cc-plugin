---
name: pair-review
description: Review the current stream implementation and write structured findings to `.pair/review.md`. Use when a stream hits a review boundary and the reviewer agent should check implementation quality before the next stream starts.
---

# Pair Review

Use this skill at a stream review boundary.

## Metadata

- Runtime: `codex`
- Claude command: `commands/pair-review.md`
- Claude agent: `agents/pair-reviewer.md`
- Command alias in Claude: `/pair-review`

## Workflow

1. Load source docs:
   - `../../commands/pair-review.md`
   - `../../agents/pair-reviewer.md`
2. Read `.pair/plan.md`, `.pair/stream-log.md`, and existing `.pair/review.md` if present.
3. Review the current stream diff and touched files.
4. Write structured findings to `.pair/review.md`.
5. **Signal next agent**: if any BLOCKER found, run `bash ~/.dotfiles/scripts/pair-signal.sh fix`. If no blockers, do NOT signal (human decides next step).
6. Return a brief verdict and call out blockers clearly.

## Rules

- Review only (no code changes).
- Write findings to `.pair/review.md`, not chat-only output.
- Prioritize correctness/regression risk over style.
- Use `BLOCKER`, `IMPORTANT`, and `NIT` severities.
