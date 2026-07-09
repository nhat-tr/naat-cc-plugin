---
description: Promote a spec (or Claude plan-mode output) into an implementable .pair/plan.md — task checkboxes, file paths, Implementation Context — then validate it.
---

# Pair Promote — Spec → Implementable Plan

A spec says WHAT and WHY. An implementable plan adds WHERE and HOW: task
checkboxes, concrete file paths, and the context an implementer needs when it
runs without this conversation. This command performs that promotion.

## Input resolution (in order)

1. `$ARGUMENTS` — a path to a spec/plan file, if given.
2. `.pair/spec.md` — if it exists with real content.
3. The plan you produced in plan mode earlier in THIS conversation, if any.
4. Otherwise: STOP and ask the user for the spec (do not invent one).

## Steps

1. Read the spec. Extract: goal, constraints, acceptance criteria. If the spec
   has no acceptance criteria, derive them and mark each `(derived)` so the
   user can veto.
2. Explore the codebase — targeted, not exhaustive: locate the files/symbols
   each piece of work touches. Search first; read only the lines you need.
3. Write `.pair/plan.md` (create `.pair/` if needed) in exactly this shape:

   ```markdown
   # Task: <title>

   ## Context
   <why — link the spec, relevant code, decisions>

   ## Implementation Context
   - **Language / Framework:** <e.g. C# / .NET 10, Lua / Neovim>
   - **Key decisions from planning:** <decisions not obvious from code>
   - **Patterns to follow:** <existing file or convention, with path>
   - **Patterns to avoid:** <specific anti-pattern or tool>
   - **Non-obvious constraints:** <compat/runtime constraints>

   ## Streams
   ### Stream 1: <name> — complexity: S|M|L
   **Depends on:** none
   - [ ] Task 1.1 — write failing tests for <behavior> — files: `tests/...` — **S**
   - [ ] Task 1.2 — implement <what> to make the tests pass — files: `path/to/file` — **M**
   - [ ] Task 1.3 — integration test: <end-to-end scenario from the acceptance criteria> — files: `tests/...` — **M**
   - **Review boundary**

   ## Acceptance Criteria
   - [ ] <criterion from spec>
   - [ ] All new behavior covered by tests written BEFORE the implementation
   - [ ] Integration test(s) pass end-to-end; no new lint errors

   ## Open Questions
   - <question> — impact: <which task>
   ```

   Every task MUST name its files in backticks. Complexity tags (S/M/L) are
   mandatory — they drive review mode selection (eco vs full).

   **TDD is mandatory, not stylistic:**
   - Every stream's FIRST task is a failing-test task; implementation tasks
     come after the tests they satisfy. The validator rejects plans that
     schedule implementation before tests.
   - Every plan contains at least one **integration test** task exercising the
     acceptance criteria end-to-end (not a mock-heavy unit test). Match the
     repo's test stack (NUnit + Testcontainers/WebApplicationFactory for C#,
     the repo's e2e/integration setup for TS).
   - If the spec's acceptance criteria cannot be expressed as tests, that is a
     spec problem — stop and ask; do not plan around it.
4. Validate:
   `bash ~/.local/share/my-claude-code/skills/pair-v2/scripts/validate-plan.sh`
   Fix and re-run until it prints OK.
5. Report to the user: stream count, task count, open questions, and any
   `(derived)` acceptance criteria that need their confirmation.

## Rules

- Do NOT implement anything. This command only plans.
- Do NOT copy the spec verbatim into the plan — the plan references the spec
  and adds the implementation layer on top.
- If the input is already a valid plan (validator passes), say so and stop.
