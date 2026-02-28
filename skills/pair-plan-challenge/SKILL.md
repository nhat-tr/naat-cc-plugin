---
name: pair-plan-challenge
description: Challenge and refine `.pair/plan.md` in the agentic pair-programming protocol. Use when the challenger agent should review the plan for missing dependencies, poor stream boundaries, risky sequencing, hidden coupling, and unclear acceptance criteria, then write feedback to `.pair/review.md`.
---

# Pair Plan Challenge

Use this skill when the challenger reviews the plan before implementation.

## Metadata

- Runtime: `codex`
- Claude command: `commands/pair-plan-challenge.md`
- Claude agent: `agents/pair-plan-challenger.md`
- Command alias in Claude: `/pair-plan-challenge`

## Instructions

Follow `agents/pair-plan-challenger.md` — it is the authoritative source for challenge criteria, severity model, output format, and signaling behavior.
