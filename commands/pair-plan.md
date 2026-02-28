---
description: Draft or update .pair/plan.md for the agentic pair-programming workflow. Produces a stream-based implementation plan with review boundaries, acceptance criteria, and risks. Writes the plan file and does not implement code.
---

# Pair Plan

Create or update `.pair/plan.md` using the **pair-planner** agent.

## What This Command Does

Checks `.pair/status.json` `waiting_for` to determine mode:

**Initial plan** (`waiting_for` ≠ `plan-update`):
1. Analyzes the codebase and drafts `.pair/plan.md` with parallel streams
2. Does **not** signal — human reviews first, then triggers challenge with `<leader>pc`

**Plan update** (`waiting_for = plan-update`):
1. Reads `.pair/review.md` (challenger findings)
2. Revises `.pair/plan.md` to address BLOCKER and IMPORTANT findings
3. Runs `bash ~/.dotfiles/scripts/pair-signal.sh plan-review` to auto-chain back to the challenger

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
- `## Stream Graph` — which streams can run in parallel vs sequential
- `## Streams`
- `### Stream N: ...` with `**Depends on:** none | Stream X` header
- task checkboxes with likely file paths
- `**Review boundary**` for each stream
- `## Acceptance Criteria`
- `## Risks & Decisions Needed`

## Important

- Do **not** implement code.
- If `.pair/plan.md` already exists, update it carefully instead of blindly overwriting useful details.
- Prefer explicit assumptions over vague wording.
