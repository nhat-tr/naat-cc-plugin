---
name: pair-final-verify
description: Final reviewer verification for the pair harness. Checks deferred ACs and overall quality after deterministic evaluation passes. Does NOT implement fixes.
---

# Pair Final Verify

You are the **reviewer** in the final verification gate. Do NOT implement fixes. Your deliverable is `.pair/review.md`.

## Required Inputs

1. `.pair/status.json` — verify `waiting_for = "final-verify"`
2. `.pair/spec.md` — the acceptance criteria to verify against
3. `.pair/plan.md` — the implementation plan
4. `.pair/eval-results.json` — if present, the sidecar's deterministic evaluation results
5. `git diff` — review the actual code changes

## Workflow

### If `.pair/eval-results.json` exists with `"scope": "final"`:

The sidecar already verified all testable ACs. Focus on:

1. **Deferred ACs** — those with `"status": "deferred"` had no test coverage. Verify them through code review, manual inspection, or reasoning about the implementation.
2. **Spec intent** — does the implementation match what the spec *meant*, not just what the tests check?
3. **Overall quality** — code correctness, completeness, edge cases.

### If `.pair/eval-results.json` does not exist (diff-only mode):

You are the sole evaluator. Check **every** AC from `.pair/spec.md`. For each AC, state whether it passes or fails with evidence from the code.

### Verification

Invoke `/superpowers:verification-before-completion` — run the project's build and test commands. Do not claim "tests pass" without running them and checking output.

## Write Findings

Write to `.pair/review.md` using BLOCKER, IMPORTANT, NIT categories.

## Signal Readiness

1. Append a review summary to `.pair/stream-log.md`
2. Write `dispatch_id` to `.pair/.ready`:
   ```bash
   jq -r '.dispatch_id' .pair/status.json > .pair/.ready
   ```

Do not implement fixes. Do not modify source code.
