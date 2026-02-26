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

## Workflow

1. Load source docs:
   - `../../commands/pair-plan.md`
   - `../../agents/pair-planner.md`
2. Read repository context and existing `.pair/plan.md` (if present).
3. Read `ARCHITECTURE.md` or `CLAUDE.md` if present.
4. Draft or update `.pair/plan.md` with streams, tasks, and review boundaries.
5. Ask only necessary clarifying questions; otherwise proceed with explicit assumptions.

## Rules

- Plan only. Do not implement code.
- Write the plan to `.pair/plan.md` (not chat-only output).
- Prefer concrete tasks with file paths and review boundaries.
- Maximize parallelism: design streams that can be implemented concurrently by separate agents. Only create sequential dependencies when streams truly share state or files.
- Include a `## Stream Graph` showing which streams are parallel vs sequential.
- Each stream must declare `**Depends on:** none | Stream N`.
- Highlight risks, dependencies, and unknowns explicitly.
