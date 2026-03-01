---
description: Review the current pair-protocol stream implementation and write `.pair/review.md` with structured findings (BLOCKER/IMPORTANT/NIT) and a verdict. Does not implement fixes.
---

# Pair Review

Use the **pair-reviewer** agent via the Agent tool (`subagent_type: "pair-reviewer"`).

Pass a brief prompt with any relevant context (e.g. stream name, specific concerns). The agent reads `.pair/plan.md`, `.pair/stream-log.md`, the stream diff, and project `CLAUDE.md`. It writes `.pair/review.md`, updates `.pair/stream-log.md`, and signals readiness.

## When to Use

- `.pair/status.json` says `waiting_for = "review"`