---
description: Draft or update .pair/plan.md for the agentic pair-programming workflow. Produces a stream-based implementation plan with review boundaries, acceptance criteria, and risks. Writes the plan file and does not implement code.
---

# Pair Plan

Create or update `.pair/plan.md` using the **pair-planner** agent.

## What This Command Does

1. **Restates the task** — clarifies scope and assumptions
2. **Analyzes the codebase** — finds relevant files, patterns, and constraints
3. **Designs streams** — independent workstreams with explicit review boundaries
4. **Writes `.pair/plan.md`** — in the pair protocol format
5. **Reports back briefly** — summarizes streams and open questions

## When to Use

- Starting work in the pair protocol and you need `.pair/plan.md`
- Re-planning after scope changes
- Breaking a vague request into implementable streams for Codex
- Creating a reviewable plan before implementation begins

## Usage

```text
/pair-plan Add clearer login error handling
/pair-plan Refactor invoice export flow with stream boundaries
/pair-plan Rework search indexing pipeline for background jobs
```

## Output Contract (`.pair/plan.md`)

The plan should use this structure:

- `# Task: ...`
- `## Context`
- `## Streams`
- `### Stream N: ...`
- task checkboxes with likely file paths
- `**Review boundary**` for each stream
- `## Acceptance Criteria`
- `## Risks & Decisions Needed`

## Important

- Do **not** implement code.
- If `.pair/plan.md` already exists, update it carefully instead of blindly overwriting useful details.
- Prefer explicit assumptions over vague wording.
