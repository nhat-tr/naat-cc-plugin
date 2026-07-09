---
name: pair-plan-challenge
description: Challenge `.pair/plan.md` — stress-test for intent misalignment, missing dependencies, poor boundaries, risky sequencing, hidden coupling, weak acceptance criteria. Write findings to `.pair/review.md`.
---

# Pair Plan Challenge

Challenge only — never implement. Deliverable: `.pair/review.md`.

**Constraints**: edit only under `.pair/`. No builds or tests. Bash only for signaling.

## Steps

0. **Clear context** — run `/clear` to start fresh.
1. **Read inputs** in order:
   - `.pair/context.md` (required — orchestrator-generated). Output `[context] context.md loaded`. If missing: halt and report.
   - `.pair/plan.md` (required)
   - `.pair/spec.md` — **required in enhanced mode** (exists AND has real feature content). Read Core Anchor (`## Purpose`, `## Rejection Criteria`, `## Contrasts`) and ACs. Verify plan streams against the anchor directly, not via the author's citation lines. Classic mode: skip this file and skip intent-alignment below.
   - Verify file paths in the plan exist; spot-check at least one code path per stream.
   - Existing `.pair/review.md` if present.
2. **Challenge** — two axes. **Intent alignment runs FIRST**; if intent is misaligned, downstream coherence doesn't matter — flag BLOCKER and stop deep-analysing that stream.

   **Intent alignment (enhanced mode only):**
   - **Purpose misalignment (BLOCKER)**: any stream pursuing work orthogonal to / beyond / under-shooting spec's Purpose. Read the spec yourself — don't trust the stream's `Serves Purpose` line. A convincing citation aimed at the wrong target is worse than no citation.
   - **Rejection Criterion violation (BLOCKER)**: any stream proposing work that triggers R1/R2/R3 — even if it satisfies an AC ID. AC coverage does not override RCs.
   - **Contrast violation (BLOCKER)**: any stream building what the spec's Contrasts rejected.
   - **Missing anchor citations (BLOCKER)**: any Phase 2 stream lacking `Serves Purpose`, `Respects Rejection Criteria`, or `Does not implement Contrast`.
   - **Tautological citations (IMPORTANT; BLOCKER if combined with vague tasks)**: citations that don't tie concretely to spec wording. Signals the author didn't verify alignment.
   - **Unreferenced AC (BLOCKER)**: any spec AC not covered by a stream's `Satisfies:` line.

   **Internal coherence (both modes):**
   - Missing/empty `## Implementation Context` (BLOCKER — implementer has no conversation history)
   - Missing `**Type:**` on any stream (BLOCKER — implementer can't route verification)
   - Incorrect `**Type:**` (BLOCKER — e.g. marked `static` but touches UI; spot-check against file paths)
   - Stream boundaries not independently reviewable
   - Sequencing ignores dependencies; hidden coupling
   - Vague tasks missing file targets
   - Incomplete/untestable acceptance criteria
   - Missing S/M/L/XL sizing per task and stream total
   - Optimistic assumptions not verified against actual code
   - Unanswered open questions that block implementation
3. **Write `.pair/review.md`** using the format below.
4. **Update `.pair/stream-log.md`** — append `### YYYY-MM-DD HH:MM UTC — Plan Challenge` with:
   - **Agent:** `codex / <model>`
   - what was challenged, BLOCKER/IMPORTANT/NIT counts, files spot-checked, verdict
5. **Signal**: `jq -r '.dispatch_id' .pair/status.json > .pair/.ready`. Orchestrator handles the rest. Do not call `pair-signal.sh`.
6. **Reply briefly** — plan implementable? BLOCKER/IMPORTANT counts, top changes needed.

## Severity

- **BLOCKER** — will cause churn or a failed review: bad sequencing, missing dependency, unverified assumption, missing sizing, intent misalignment.
- **IMPORTANT** — should fix before starting: vague task, weak AC.
- **NIT** — do NOT write to review.md. Ignore for output purposes.

## `.pair/review.md` Format

**If no BLOCKER or IMPORTANT found:** write 1–2 sentences only (e.g. "Plan looks good. No blockers or important issues — continue to implementation."). Do not enumerate findings or checks.

**If findings exist:**

```markdown
# Review: Plan Challenge

**Reviewer:** `codex / <model>`
**Date:** `YYYY-MM-DD HH:MM UTC`

## Findings

### BLOCKER: [short title]
- **Section:** `Stream 1` / `Acceptance Criteria` / etc.
- **Issue:** [why this will fail or cause churn]
- **Suggested fix:** [concrete change]

### IMPORTANT: [short title]
- **Section:** ...
- **Issue:** ...
- **Suggested fix:** ...

## Verdict
[e.g. "No blockers. Plan is implementable." / "Blockers present; revise before implementation."]
```
