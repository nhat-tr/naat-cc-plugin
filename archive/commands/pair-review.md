---
description: Review the current pair-protocol stream implementation and write `.pair/review.md` with structured findings (BLOCKER/IMPORTANT/NIT) and a verdict. Does not implement fixes.
---

# Pair Review

Execute these instructions directly. Do NOT spawn a subagent.

**Review only. NEVER implement code. NEVER run builds or tests.** Bash is only for `git diff` and signaling.

## First Steps

1. Read the language skill file from your CLAUDE.md "Global Language Rules" section — all Non-Negotiable Rules are mandatory review criteria
2. Read `.pair/plan.md` — stream boundaries and acceptance criteria
3. Read `.pair/stream-log.md` — **last entry only**: `grep -n "^###" .pair/stream-log.md | tail -1` to get line offset, read from there
4. If fix cycle: read `.pair/review.md` — verify each previous BLOCKER was addressed
5. Get the stream diff: `git diff` against the relevant base
6. **C# only — if JetBrains MCP available**: run `mcp__jetbrains__get_file_problems` on each changed file

## Confidence Gate

- Only flag issues >80% confident are real
- Infer conventions from repo code before flagging style issues
- Consolidate similar issues ("3 methods missing X" not 3 separate findings)
- No optimistic assumptions — state what you verified and what you couldn't

## Severity

| Issue | Severity |
|---|---|
| Security, data loss, async void, sync-over-async, captive DI, resource leaks, N+1 EF, missing CancellationToken | BLOCKER |
| Missing tests for new behavior, dead code, unused usings, logging violations, missing AsNoTracking, TS `any` abuse | IMPORTANT |
| Style, naming, optional modernization | NIT |

## Output (`.pair/review.md`)

```markdown
# Review: [Stream label]

**Reviewer:** `claude / <model>`
**Date:** `YYYY-MM-DD HH:MM UTC`

## Summary
[2-3 sentences]

## Findings

### BLOCKER: [title]
- **File:** `path:line`
- **Issue:** [what]
- **Suggested fix:** [how]

## Verdict
[OK to proceed / N blockers must be fixed]
```

## After Writing Review

1. **Update `.pair/stream-log.md`** — append `### YYYY-MM-DD HH:MM UTC — Review: Stream N`:
   - Agent, stream reviewed, finding counts, files inspected, verdict
2. **Signal**: `jq -r '.dispatch_id' .pair/status.json > .pair/.ready`
3. Reply briefly: blocker/important counts, verdict