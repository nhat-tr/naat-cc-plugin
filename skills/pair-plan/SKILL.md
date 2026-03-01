---
name: pair-plan
description: Draft or update `.pair/plan.md` for the agentic pair-programming protocol. Use when starting a task and you want a coding agent to write a stream-based plan with review boundaries, acceptance criteria, and risks before implementation begins.
---

# Pair Plan

Plan only. NEVER implement code. Your primary deliverable is `.pair/plan.md`.

**Constraints:** Only edit files under `.pair/`. No builds or tests. Read and search freely to understand the codebase.

## Metadata

- Claude command: `commands/pair-plan.md`
- Claude agent: `agents/pair-planner.md`

## Mode Selection

Read `.pair/status.json` field `waiting_for`:

- **`plan-update`**: Challenger found blockers. Read `.pair/review.md`, address all BLOCKER and IMPORTANT findings in `.pair/plan.md`, then signal.
- **anything else / initial**: Draft the plan from scratch or update it based on user input. Do NOT signal after writing — the human reviews the plan first.

## Required Inputs

1. `.pair/status.json` (determines mode)
2. `.pair/plan.md` if it already exists
3. `.pair/review.md` if in `plan-update` mode (required)
4. `ARCHITECTURE.md` or `CLAUDE.md` if present
5. Relevant code paths in the repository

## Workflow

**If you have must-know questions, STOP. Do not write the plan. Ask and wait for answers.**

1. Read the codebase: project structure, existing patterns, relevant files.
2. Identify likely files/modules to change; find existing patterns to follow.
3. Design streams so they are independently reviewable and parallelizable where possible.
4. Write `.pair/plan.md` using the format below.
5. Update `.pair/stream-log.md` (see below).
6. Signal only in `plan-update` mode (see below).

## Plan Format (`.pair/plan.md`)

```markdown
# Task: [title]

## Context
Why we're doing this. Links to relevant code.

## Stream Graph
Streams 1, 2 → parallel (no shared files)
Stream 3 → after Stream 1 (depends on X)

## Streams

### Stream 1: [name] — complexity: M
**Depends on:** none
- [ ] Task 1.1: [description] — files: `path/to/file` — **S**
- [ ] Task 1.2: [description] — files: `path/to/file` — **M**
- **Review boundary**

### Stream 2: [name] — complexity: S
**Depends on:** none
- [ ] Task 2.1: [description] — files: `path/to/file` — **S**
- **Review boundary**

## Open Questions
- [question] — impact: [which stream/task]

## Acceptance Criteria
- [ ] Tests pass (relevant scope)
- [ ] No new lint errors
- [ ] [domain-specific criterion]

## Risks & Decisions Needed
- Risk: [risk] -> mitigation: [mitigation]
```

**Complexity scale:** S = <15 min, M = 15–60 min, L = 1–3 hours, XL = needs splitting.

## Stream Log Update (REQUIRED)

Append to `.pair/stream-log.md` with heading `### YYYY-MM-DD HH:MM UTC — Plan: initial` (or `plan-update`):

- **Agent:** `codex / <model>`
- mode (initial plan / plan-update)
- what changed in the plan
- open questions and resolution status
- key decisions made

## Signal Readiness

- **`plan-update` mode only**: write the current `dispatch_id` to `.pair/.ready`:
  ```bash
  jq -r '.dispatch_id' .pair/status.json > .pair/.ready
  ```
  The orchestrator chains back to the challenger. Do not call `pair-signal.sh`.
- **Initial plan**: do NOT write `.ready`. Stop — the human reviews first.

## Response After Writing

- Mode used (initial or plan-update)
- Streams created/updated
- Key changes made (if plan-update)
- Key risks/unknowns

Do not paste the entire plan unless asked.