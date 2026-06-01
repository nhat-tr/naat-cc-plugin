---
description: Update Navigator artifacts (.nav/) after a completed stream. AI-maintained navigation layer for human drill-down.
---

# Pair Nav Update

Execute these instructions directly. Do NOT spawn a subagent.

## Steps

1. Read `.pair/status.json` to get `dispatch_id` and `waiting_for`.

2. Read `.pair/plan.md` to understand the feature context.

3. Read the latest `.pair/stream-log.md` entry — use `grep -n "^###" .pair/stream-log.md | tail -2` to find the newest entry, then read only that section.

4. Run `git diff HEAD~1 --stat` to identify files changed in this stream.

5. Read current `.nav/index.md` and any relevant `.nav/modules/*.md`.

6. Update `.nav/index.md`: add or update module rows with purpose, risk level (LOW/MED/HIGH), last-changed stream, and connections.

7. For each module affected, create or update `.nav/modules/<name>.md` with:
   - Key files: path, line ranges, status (NEW / CHANGED / STABLE)
   - Connections: what calls it, what it calls, data flow
   - "If this breaks" table: symptom → where to look

8. Append to `.nav/journal.md`: stream entry with files touched, new patterns, risk, blast radius.

9. If key design decisions were made, append to `.nav/decisions.md` with context and alternatives.

10. Do not modify `.nav/spec.md` — that is human-authored.

11. Append a nav-update summary to `.pair/stream-log.md`.

## Signal Readiness

After all updates:
```bash
jq -r '.dispatch_id' .pair/status.json > .pair/.ready
```