---
name: pair-review
description: Review the current stream implementation and write structured findings to `.pair/review.md`. Use when a stream hits a review boundary and the reviewer agent should check implementation quality before the next stream starts.
---

# Pair Review

Review only. NEVER implement code. NEVER run builds or tests. Your deliverable is `.pair/review.md`.

**Constraints:** No `dotnet build`, `npm run`, `cargo`, `pytest`, or any compilation/test command. Build and test verification is the dev agent's responsibility. Bash is only for signaling and `git diff`.

## Steps

0. **Clear context** — run `/clear` to start fresh
1. **Read required inputs** in order:
   - `CLAUDE.md` in the project root (conventions, test patterns)
   - `.pair/plan.md` (stream boundaries and acceptance criteria)
   - `.pair/stream-log.md` (decisions and progress)
   - `.pair/review.md` if present — in a fix cycle, verify each previous BLOCKER was addressed before closing it
   - Current stream diff: `git diff` against the relevant base
2. **Review** — current stream only; do not flag unrelated repo issues. Prioritize: correctness bugs, missing error handling, API/contract mismatches, unsafe assumptions, missing tests, plan drift.
3. **Write `.pair/review.md`** using the format below
4. **Update `.pair/stream-log.md`** — append a heading `### YYYY-MM-DD HH:MM UTC — Review: <stream>` with:
   - **Agent:** `codex / <model>`
   - stream reviewed, BLOCKER/IMPORTANT/NIT counts, files inspected, verdict
5. **Signal readiness**: write the current `dispatch_id` to `.pair/.ready`:
   ```bash
   jq -r '.dispatch_id' .pair/status.json > .pair/.ready
   ```
   The orchestrator reads `review.md` for BLOCKERs and handles all signaling. Do not call `pair-signal.sh`.
6. **Reply briefly** — blocker count, important count, verdict, confidence gaps

## Confidence Gate

- Only flag issues you are >80% confident are real.
- Infer conventions from existing code before flagging style.
- Consolidate similar issues — "3 methods missing null checks" not 3 separate findings.
- State what you verified and what you couldn't check.

## Severity

- `BLOCKER` — must fix before proceeding: security, data loss, `async void`, captive DI, `IDisposable` leaks, N+1 EF queries, sync-over-async (`.Result`/`.Wait()`)
- `IMPORTANT` — should fix in this stream: missing tests, dead code, missing `AsNoTracking` on read queries
- `NIT` — optional / later: style, naming, optional modernization

## `.pair/review.md` Format

```markdown
# Review: [Stream label]

**Reviewer:** `codex / <model>`
**Date:** `YYYY-MM-DD HH:MM UTC`

## Summary
[2-3 sentences on overall quality]

## Findings

### BLOCKER: [short title]
- **File:** `path/to/file:line`
- **Issue:** [what is wrong]
- **Suggested fix:** [specific direction]

### IMPORTANT: [short title]
- **File:** `path/to/file:line`
- **Issue:** ...
- **Suggested fix:** ...

### NIT: [short title]
- **Issue:** ...

## Verdict
[e.g. "No blockers. OK to continue." / "1 blocker must be fixed before proceeding."]
```

If no findings: keep `## Findings`, state explicitly none were found, note residual risk or untested paths.