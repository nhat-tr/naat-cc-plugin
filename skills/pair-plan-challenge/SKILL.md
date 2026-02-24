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

## Workflow

1. Load source docs:
   - `../../commands/pair-plan-challenge.md`
   - `../../agents/pair-plan-challenger.md`
2. Read `.pair/plan.md` and optional context files (`ARCHITECTURE.md` / `CLAUDE.md`).
3. Verify assumptions against repo files only when needed.
4. Write plan-challenge feedback to `.pair/review.md`.
5. Respond briefly with blocker/important counts and the top changes needed.

## Rules

- Review the plan only. Do not implement code.
- Write structured findings to `.pair/review.md`.
- Prioritize execution clarity and sequencing risk over wording nits.
