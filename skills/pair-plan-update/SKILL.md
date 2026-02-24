---
name: pair-plan-update
description: Revise `.pair/plan.md` using feedback in `.pair/review.md` for the agentic pair-programming protocol. Use when plan review feedback exists and Claude Code should update the plan instead of rewriting the prompt manually.
---

# Pair Plan Update

Use this skill when Claude Code should apply plan feedback from `.pair/review.md` into `.pair/plan.md`.

## Metadata

- Runtime: `codex`
- Claude command: `commands/pair-plan-update.md`
- Claude agent: `agents/pair-plan-updater.md`
- Command alias in Claude: `/pair-plan-update`

## Workflow

1. Load source docs:
   - `../../commands/pair-plan-update.md`
   - `../../agents/pair-plan-updater.md`
2. Read `.pair/plan.md` and `.pair/review.md`.
3. Read `ARCHITECTURE.md` or `CLAUDE.md` if present.
4. Update `.pair/plan.md` to address plan feedback.
5. Reply with a short summary of what changed and what remains unresolved.

## Rules

- Plan only. Do not implement code.
- Update `.pair/plan.md` directly.
- Prioritize `BLOCKER` and `IMPORTANT` findings.
- Preserve stream boundaries and the pair-plan format.
