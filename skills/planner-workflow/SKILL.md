---
name: planner-workflow
description: Create phased implementation plans without writing code. Use when the user asks for planning, architecture-to-implementation breakdown, sequencing, risk assessment, or rollout strategy.
---

# Planner Workflow

Use this skill for planning-only sessions.

## Metadata

- Runtime: `codex`
- Claude command: `commands/planner.md`
- Claude agent: `agents/planner.md`
- Command alias in Claude: `/planner`

## Workflow

1. Load source docs:
   - `../../commands/planner.md`
   - `../../agents/planner.md`
2. Analyze repository context and constraints.
3. Produce phased plan with dependencies, risks, and validation strategy.
4. Ask clarifying questions when ambiguity blocks planning quality.

## Rules

- Do not write code.
- Ground plan in actual repository structure.
- Prefer actionable phases with clear success criteria.
