---
name: pair-implement
description: Implement the current stream from `.pair/plan.md` or fix review findings from `.pair/review.md`. Reads `.pair/status.json` to determine mode (implement or fix). Runs targeted verification and updates `.pair/stream-log.md`.
---

# Pair Implement

Implement code or fix review findings. Do not act as reviewer. Your deliverables are code changes plus `.pair/stream-log.md` updates.

## Metadata

- Claude command: `commands/pair-implement.md`
- Claude agent: `agents/pair-implementer.md`

## Mode Selection

Read `.pair/status.json` field `waiting_for`:

- **`implement`**: Implement tasks from `.pair/plan.md` for the current stream up to the next `**Review boundary**`.
- **`fix`**: Address `BLOCKER` and `IMPORTANT` findings in `.pair/review.md`. Prioritize BLOCKER > IMPORTANT > NIT (NITs are optional unless cheap).

## Required Inputs

Read in order before starting:

1. `CLAUDE.md` in the project root (build commands, conventions, project structure)
2. `.pair/status.json` (determines mode)
3. `.pair/plan.md`
4. `.pair/review.md` (required if `waiting_for = "fix"`)
5. Relevant source/test files for the stream

## Workflow

1. Read `.pair/status.json` to determine mode.
2. In **implement** mode: identify the **first stream whose tasks are not yet all checked off** in `.pair/plan.md`. Output a single header line:
   ```
   ## Stream N: [stream name]
   ```
   Implement tasks up to the `**Review boundary**`. Mark each completed task done as you finish it:
   ```bash
   bash ~/.dotfiles/scripts/pair-check.sh "10.1"
   ```
3. In **fix** mode: parse `.pair/review.md` findings into fix actions. Apply BLOCKER and IMPORTANT fixes.
4. Keep changes scoped to the current stream; log required scope exceptions.
5. Run targeted verification using the right command for the language:
   - **C#**: `dotnet build`, then `dotnet test --filter <relevant filter>`
   - **TypeScript**: `tsc --noEmit`, then detect test runner from config (jest/vitest/playwright)
   - **Rust**: `cargo check`, `cargo test`, `cargo clippy`
   - **Python**: `pytest <path>`, `mypy` or `pyright` if configured
   If unable to run, state the reason explicitly in the stream log.
6. **Run `/simplify`** once you are done editing.
7. **Update `.pair/stream-log.md`** before signaling. Append a heading `### YYYY-MM-DD HH:MM UTC — Stream N: implement` with:
   - **Agent:** `codex / <model>`
   - stream/task identifier
   - what changed (or findings addressed/deferred)
   - files touched
   - key decisions/tradeoffs
   - verification run and result (or why skipped)
   - blockers/questions (if any)
8. **Signal readiness** — read `dispatch_id` from `.pair/status.json`, then write it to `.pair/.ready`:
   ```bash
   jq -r '.dispatch_id' .pair/status.json > .pair/.ready
   ```
   The orchestrator watches for this file and handles all signaling. Do not call `pair-signal.sh`.

**Do not write `.ready` before updating the stream log.**

## When Verification Fails

1. Read the error message fully — most errors state exactly what's wrong.
2. Check the specific file and line referenced.
3. Fix the root cause, not the symptom.
4. If stuck after 2 attempts, step back and reconsider the approach — do not brute-force.
5. Log the failure in the stream log and flag it as a blocker if unresolved.

## Guardrails

- Do not write `.pair/status.json` directly. Only `pair-signal.sh` may update it.
- Do not write reviewer findings to `.pair/review.md`.
- If the plan is ambiguous or infeasible, stop and report the gap clearly.
- Avoid unrelated refactors unless required for the stream (and log them).
- Make one focused change at a time; verify before moving to the next task.
- No optimistic assumptions: if unsure about behavior, read the code first. Log what you verified and what you couldn't.

## Response After Completing

Reply briefly with:

- mode used (implement or fix)
- stream/tasks completed or findings resolved
- files changed
- verification run (or why not)
- whether the stream is ready for review