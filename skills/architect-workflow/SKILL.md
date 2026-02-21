---
name: architect-workflow
description: System design and architecture decision workflow. Use when the user asks for architecture options, tradeoff analysis, component boundaries, or technology decisions.
---

# Architect Workflow

Use this skill for architecture-focused sessions.

## Metadata

- Runtime: `codex`
- Claude command: `commands/architect.md`
- Claude agent: `agents/architect.md`
- Command alias in Claude: `/architect`

## Workflow

1. Load source docs:
   - `../../commands/architect.md`
   - `../../agents/architect.md`
2. Map current architecture and constraints.
3. Propose options with tradeoffs and recommendations.
4. Produce ADR for significant decisions; otherwise provide concise decision note.

## Rules

- Use shell tooling when useful for dependency graph signals.
- Ground decisions in repository evidence and migration cost.
- Prefer simpler solutions unless complexity is justified.
