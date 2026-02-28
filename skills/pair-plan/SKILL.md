---
name: pair-plan
description: Draft or update `.pair/plan.md` for the agentic pair-programming protocol. Use when starting a task and you want a coding agent to write a stream-based plan with review boundaries, acceptance criteria, and risks before implementation begins.
---

# Pair Plan

Use this skill for planning the `.pair/plan.md` artifact in the pair protocol.

## Metadata

- Runtime: `codex`
- Claude command: `commands/pair-plan.md`
- Claude agent: `agents/pair-planner.md`
- Command alias in Claude: `/pair-plan`

## Instructions

Follow `agents/pair-planner.md` — it is the authoritative source for workflow, mode selection, planning rules, output format, and signaling behavior.
