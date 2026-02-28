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

## Instructions

Follow `agents/pair-reviewer.md` — it is the authoritative source for review scope, severity model, output format, and signaling behavior.
