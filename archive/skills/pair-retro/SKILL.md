---
name: pair-retro
description: Stream retrospective after a fix cycle. Reads review.md + stream-log.md, extracts surprise/root-cause/rule, appends to .pair/learnings.md. In retro-final mode also writes a session takeaways block.
---

# Pair Retro

Run a retrospective on a stream that required at least one fix cycle. Write learnings, signal ready.

## Mode

Read `.pair/status.json:waiting_for`:

- **`retro-stream`**: per-stream retro — append one entry to `learnings.md`.
- **`retro-final`**: same, plus append a "Session Takeaways" block consolidating all entries.

## Inputs

Read these files before writing:

- `.pair/review.md` — findings that triggered the fix cycle(s)
- `.pair/stream-log.md` — agent decisions and task updates
- `.pair/plan.md` — stream name (most recent `### Stream` heading)
- `.pair/learnings.md` — existing entries (append only)
- `.pair/status.json` — `stream_fix_count`, `dispatch_id`, `waiting_for`

## Step 1 — Analyse

Identify:
1. **Surprise** — what went wrong that was not predicted before implementation.
2. **Root cause** — cite the specific finding in `review.md` or `stream-log.md`. No speculation.
3. **Rule for next time** — one concrete, actionable statement.

## Step 2 — Append to `.pair/learnings.md`

```markdown
## <CET timestamp> — <stream name> — fix_count=<stream_fix_count>
**Surprise:** <what was unexpected>
**Root cause:** (cite review.md finding / stream-log entry)
**Rule for next time:** <one concrete rule>
```

CET timestamp: run `TZ=Europe/Berlin date +%Y-%m-%dT%H:%M:%S%z` via Bash.
Stream name: most recent `### Stream N: <name>` heading in `plan.md`.
fix_count: `stream_fix_count` from `status.json`.

## Step 3 — Session Takeaways (retro-final only)

If `waiting_for == "retro-final"`, also append:

```markdown
## Session Takeaways — <CET timestamp>
- <pattern or repeated rule from this session's entries>
- ...
```

Consolidate the ## entries above into 2–5 bullets covering patterns, systemic issues, and rules that appeared more than once.

## Step 4 — Signal ready

Write `dispatch_id` from `status.json` to `.pair/.ready`:

```bash
echo -n "<dispatch_id>" > .pair/.ready
```
