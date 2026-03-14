---
description: Review code changed in the current stream for quality, reuse, and efficiency. Fix issues found. Signals readiness when done. Dispatched by the orchestrator after pair-implement (Claude-only).
---

# Pair Simplify

Review and fix code changed in the current stream. Do not add features. Do not touch files outside the stream scope.

## Steps

1. Read `.pair/stream-log.md` — **last entry only** (`grep -n "^###" .pair/stream-log.md | tail -1`) to identify which files were changed.

2. Read each changed file.

3. Review and fix:
   - Unnecessary abstractions for single-use logic
   - Duplicated code that already exists elsewhere in the repo
   - Dead branches, unused variables, unreachable code
   - Over-complex expressions where a simpler form is equivalent
   - Missing early returns or guard clauses that reduce nesting

4. Update `.pair/stream-log.md` — append `### YYYY-MM-DD HH:MM UTC — Simplify` with:
   - files reviewed
   - changes made (or "no changes needed")

5. **Signal readiness**:
   ```bash
   jq -r '.dispatch_id' .pair/status.json > .pair/.ready
   ```

## Scope constraint

Only touch files that appear in the current stream's stream-log entry. Do not refactor unrelated code.