---
name: pair-spec
description: Generate a product specification with acceptance criteria in `.pair/spec.md` for the pair harness enhanced mode. Invokes brainstorming skill for collaborative spec generation.
---

# Pair Spec

Generate a product specification for the pair harness. Your deliverable is `.pair/spec.md`.

## Required Inputs

1. `.pair/status.json` — verify `waiting_for = "spec"`
2. `AGENTS.md`, `CLAUDE.md` — project conventions
3. Project source code — understand what exists

## Workflow

Invoke `/brainstorming` with these overrides:

- **Skip** the visual companion offer — this is an automated dispatch.
- **Skip** "propose 2-3 approaches" — go directly from clarifying questions to spec generation.
- **Save location**: `.pair/spec.md` (NOT `docs/superpowers/specs/`).
- **Do NOT** commit the spec to git.
- **Do NOT** invoke writing-plans at the end — stop after writing the spec.
- **Do NOT** transition to implementation — the orchestrator handles that.

If `/brainstorming` is not available, generate the spec directly using the template below.

## Spec Template

The spec MUST use this structure:

```markdown
# Spec: [Feature Name]

## Overview
[1-3 sentences: what and why]

## Features
### F1: [Feature Name]
- **Description**: [what this feature does]
- **Acceptance Criteria**:
  - [ ] F1.AC1: [testable criterion]
  - [ ] F1.AC2: [testable criterion]
- **Verification**:
  - F1.AC1: [how to verify — test name pattern, endpoint, or UI action]
  - F1.AC2: [how to verify]
- **Data Model** (if applicable): [describe]

### F2: ...

## Non-Functional Requirements
- [requirement]

## Out of Scope
- [exclusion]
```

Rules:
- Every AC must have a stable ID (`F1.AC1`, `F1.AC2`, `F2.AC1`, etc.)
- Every AC must have a corresponding Verification entry
- Be ambitious but realistic
- Do not implement code

## Signal Readiness

After writing `.pair/spec.md`:
1. Append a stream-log entry to `.pair/stream-log.md`
2. Write the current `dispatch_id` to `.pair/.ready`:
   ```bash
   jq -r '.dispatch_id' .pair/status.json > .pair/.ready
   ```
