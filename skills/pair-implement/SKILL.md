---
name: pair-implement
description: Implement the current stream from `.pair/plan.md` or fix findings from `.pair/review.md`. Reads `.pair/status.json` for mode. Runs layered verification and updates `.pair/stream-log.md`.
---

# Pair Implement

Implement code or fix review findings. Never act as reviewer. Deliverables: code changes + `.pair/stream-log.md` updates.

## Metadata

- Claude command: `commands/pair-implement.md`
- Claude agent: inline in the pane-level Claude (no dedicated agent file)

## Context Hygiene

At the start of a **NEW** stream's implement dispatch, run `/clear` before reading inputs — previous streams' debates are noise.

Do NOT `/clear` during same-stream fix cycles (`waiting_for = "fix"`) — fix mode needs context of what was just implemented.

CLAUDE.md/project rules are re-loaded via `.pair/context.md` at step 1, so `/clear` costs no project knowledge. If orchestrator auto-compaction (`PAIR_COMPACT_THRESHOLD`) just fired, skip the explicit `/clear`.

## Mode Selection

Read `.pair/status.json:waiting_for`:

- **`implement`**: implement tasks from `.pair/plan.md` for the current stream up to the next `**Review boundary**`.
- **`fix`**: address BLOCKER + IMPORTANT findings in `.pair/review.md`. Priority: BLOCKER > IMPORTANT > NIT (NITs only if cheap).

## Frontend Component Requirements

When the current stream's `**Type:**` includes `frontend`, every interactive component MUST be playwright-test-ready. Step 7c verification runs against it — flakiness means a violation here, not an "acceptable-but-slightly-racey" implementation.

Required for every interactive component:

- **Stable selectors** — every interactive element has a `data-testid` OR a semantic role + accessible name that playwright can target via `getByRole()` / `getByLabel()` / `getByTestId()`. Do NOT rely on CSS class names or raw text content that may change.
- **Deterministic state via DOM** — state transitions reflected in attributes (`aria-expanded`, `aria-selected`, `aria-busy`, `aria-invalid`, `aria-checked`), not only in CSS or component-internal state. What the user sees must be readable by playwright without JS introspection.
- **Distinguishable loading / error / success states** — each state identifiable via a role (`role="status"`, `role="alert"`, `aria-busy="true"`) or a stable testid. Not "spinner appears then disappears."
- **Async completion signals** — when async work finishes, something in the DOM changes positively (new element, attribute flip, status message). Playwright's `waitFor` needs a positive signal; absence of a loader is not enough.
- **No timing-based hacks** — no `setTimeout` delays to make tests pass. If the UI genuinely needs to settle, surface that as a visible signal.

These are NOT optional. If a framework or component library fights them, raise it in the stream log as a blocker — do not ship a component that will flake playwright.

## Required Inputs

Read in order:

1. `.pair/context.md` **(required; global rules + project CLAUDE.md + language routing)**. Output: `[context] context.md loaded | language: <detected>`. If missing: halt and log.
2. `.pair/status.json` — mode
3. `.pair/plan.md` — read `## Implementation Context` first
4. `.pair/review.md` (required if `waiting_for = "fix"`)
5. Relevant source/test files

## Workflow

1. Read `.pair/status.json` — mode.
2. **implement**: find the first stream with unchecked tasks in `.pair/plan.md`. Output one line: `## Stream N: [stream name]`. Implement tasks up to `**Review boundary**`. Mark each task done as finished:
   ```bash
   bash ~/.dotfiles/scripts/pair-check.sh "10.1"
   ```
3. **fix**: parse `.pair/review.md` and/or `.pair/eval-results.json` into fix actions. Apply BLOCKER + IMPORTANT.
   - `.pair/eval-results.json` (if present) is primary guide for failed ACs/tests.
   - If `eval_fail_count >= 2`: invoke `/troubleshoot` BEFORE fixing. Do not skip.
4. Keep changes scoped to the current stream; log exceptions.
5. **TDD**: use `/superpowers:test-driven-development` for new functionality — failing test first, then implement. Include AC IDs in test names where framework supports it (e.g. `[TestCase("F1.AC1")]`, `test.describe("F1.AC1: ...")`). Best-effort.
6. For streams with 3+ independent tasks, consider `/superpowers:dispatching-parallel-agents` for non-shared-file work.
7. **Layered verification** — run in order. Stop and fix at the first failing layer.

   **Stream type lookup (first):** read `**Type:**` from the current stream in `.pair/plan.md`. Tags from `{static, service, frontend}`, comma-separated (e.g. `service, frontend`).
   - If missing: halt and flag the plan as defective via stream log. Do NOT guess — wrong classification runs wrong verification. Plan-challenge should have caught it; surface the protocol bug.
   - Run each layer whose tag appears in Type. `static` always runs (baseline).

   **7a. Static (always):**
   - **C#**: `dotnet build` → `dotnet test --filter <filter>`
   - **TypeScript**: `tsc --noEmit` → detect test runner (jest/vitest)
   - **Rust**: `cargo check` → `cargo test` → `cargo clippy`
   - **Python**: `pytest <path>` → `mypy`/`pyright` if configured
   If unable to run: state reason in stream log. Do not skip silently.

   **7b. Service runtime (Type ⊇ `service`):**
   - Invoke `/aspire`. Use `--apphost <path>` if outside the AppHost directory.
   - `aspire start` (or `aspire start --isolated` in worktrees).
   - `aspire wait <resource>` for resources this stream touches.
   - Exercise new behavior via existing test, `curl`, or minimal probe.
   - `aspire otel logs [resource]` — check for errors.
   - `aspire otel traces [resource]` — check for unexpected spans/failures. Pull trace logs via `aspire otel logs --trace-id <id>` if suspicious.
   - `aspire stop`.
   - Log in stream log: what was exercised, what logs/traces showed, pass/fail. Unexplained error-level log lines = verification failure even if tests pass.

   **7c. Frontend (Type ⊇ `frontend`):**
   - **Precondition**: the component is playwright-test-ready per the Frontend Component Requirements section above. If it isn't, playwright will flake — fix the component first, re-run 7c.
   - **Playwright via cost-isolated sub-agent (MANDATORY)**: dispatch Task with `subagent_type=general-purpose`, `model=haiku`. Prompt must include: URL/route, golden-path interactions derived from AC IDs, 1–3 edge cases. Require a compact pass/fail report per behavior with one-line reasons; **explicitly forbid DOM snapshot dumps in the response**. Verbose tool output stays in sub-agent context; only the verdict returns.
   - **Web Interface Guidelines audit (MANDATORY)**: invoke `/web-design-guidelines` on changed UI code. Fix every flagged issue; re-run until clean. Do NOT claim the stream done while any violation remains. If a guideline conflicts with spec's Purpose/RC, log the exception and ask the human to resolve — do not silently skip.
8. Before claiming done, invoke `/superpowers:verification-before-completion` — do not claim success without running the actual verification command and checking output.
9. **Update `.pair/stream-log.md`** before signaling. Append `### YYYY-MM-DD HH:MM UTC — Stream N: implement` with:
   - **Agent:** `codex / <model>`
   - stream/task id, what changed (or findings addressed/deferred), files touched, key decisions/tradeoffs, verification run + result (or why skipped), blockers/questions
10. **Signal**: `jq -r '.dispatch_id' .pair/status.json > .pair/.ready`. Orchestrator handles the rest.

**Never write `.ready` before updating the stream log.**

## When Verification Fails

1. Read the error message fully — most errors state exactly what's wrong.
2. Check the specific file/line referenced.
3. Fix root cause, not symptom.
4. Stuck after 2 attempts: step back, reconsider. Do not brute-force.
5. Log the failure; flag as blocker if unresolved.

## Guardrails

- Do not write `.pair/status.json` directly. Only `pair-signal.sh` may.
- Do not write reviewer findings to `.pair/review.md`.
- Plan ambiguous/infeasible: stop and report the gap.
- No unrelated refactors unless required (log them).
- One focused change at a time; verify before the next.
- No optimistic assumptions: read the code first. Log what you verified and what you couldn't.

## Response After Completing

Brief: mode, stream/tasks done (or findings resolved), files changed, verification run, whether ready for review.
