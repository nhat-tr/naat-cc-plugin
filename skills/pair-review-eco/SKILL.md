---
name: pair-review-eco
description: Token-efficient stream review using diff-first analysis. Same BLOCKER/IMPORTANT/NIT quality as pair-review but skips language skill file, stream-log, and speculative source reads. Use for S/M-complexity streams — refactors, config changes, mechanical additions. Not for new behavior or cross-cutting changes.
---

# Pair Review (Eco)

Review only. NEVER implement code. NEVER run builds or tests. Your deliverable is `.pair/review.md`.

**Bash:** only for `git diff`. No builds, no tests.

## Eco Scope Check (do this first)

**Eco is appropriate when ALL are true:**
- Stream is S or M complexity (1–3 files, no new cross-cutting patterns)
- Changes are mechanical: refactor, rename, config, wiring, tests for existing behavior
- No new public APIs, interfaces, or data contracts
- No new async patterns, DI registrations, or EF query shapes

**Stop and recommend full `$pair-review` if ANY are true:**
- Stream is L or XL
- New behavior introduced (new endpoints, new DB writes, new auth logic)
- Cross-cutting concerns touched (middleware, DI setup, global error handling)
- Diff is >300 lines of non-trivial logic

If stopping: write a brief message explaining why. Do not write `.pair/review.md`.

## Required Inputs (minimal)

Read in this order — nothing more unless the diff forces a targeted lookup:

1. `git diff` against the relevant base — **primary input**
2. `.pair/plan.md` — **review boundary and acceptance criteria only**
3. `CLAUDE.md` in the project root — **skim only**: test patterns, naming conventions
4. `.pair/review.md` — **only if in a fix cycle**

**Do not read:** language skill files, stream-log, or source files speculatively. Only make a targeted read if the diff shows something you cannot evaluate from context alone.

## Diff-First Review Protocol

1. Read the full `git diff`. Form a mental model of what changed.
2. For each changed file, evaluate against known patterns:
   - **C# async:** `async void`, `.Result`/`.Wait()`, missing `CancellationToken`
   - **C# DI:** captive dependencies, `DbContext` as singleton
   - **C# EF:** N+1, `FromSqlRaw` with concatenation, missing `AsNoTracking` on reads
   - **Security:** injection, exposed secrets, hardcoded credentials
   - **Tests:** new behavior without test coverage
3. If a finding needs confirmation, make **one targeted read** of the specific file/line — no browsing.
4. Cross-check changed items against the plan's acceptance criteria.

## Confidence Gate

- Only flag issues you are >80% confident are real.
- Infer conventions from the diff itself — how does the existing code in the same file handle it?
- Consolidate similar issues — "3 methods missing null checks" not 3 separate findings.
- State what you verified and what you couldn't check.

## Severity

- `BLOCKER` — must fix before proceeding: security, data loss, `async void`, captive DI, `IDisposable` leaks, N+1 EF, sync-over-async (`.Result`/`.Wait()`)
- `IMPORTANT` — should fix in this stream: missing tests, dead code, missing `AsNoTracking` on read queries
- `NIT` — optional / later: style, naming, optional modernization

## `.pair/review.md` Format

```markdown
# Review: [Stream label]

**Reviewer:** `codex / <model>`
**Date:** `YYYY-MM-DD HH:MM UTC`
**Mode:** eco

## Summary
[2-3 sentences on overall quality. Note areas not checkable from diff alone.]

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

If no findings: keep `## Findings`, state none found, note what eco review cannot verify.

## Steps

1. Run the eco scope check — stop if stream is out of scope
2. Read the minimal inputs
3. Apply diff-first review protocol
4. Write `.pair/review.md`
5. Update `.pair/stream-log.md` — append `### YYYY-MM-DD HH:MM UTC — Review (eco): <stream>` with:
   - **Agent:** `codex / <model>`
   - stream reviewed, BLOCKER/IMPORTANT/NIT counts, files inspected (diff + targeted reads only), verdict
6. **Signal readiness**:
   ```bash
   jq -r '.dispatch_id' .pair/status.json > .pair/.ready
   ```
   The orchestrator reads `review.md` for BLOCKERs. Do not call `pair-signal.sh`.
7. **Reply briefly** — blocker count, important count, verdict, any areas eco could not verify
