#!/usr/bin/env bash
# gate-orient — SessionStart hook (fires on startup, resume, clear, AND after
# compaction). stdout is injected into the session's context.
#
# In a gated repo (.pair/plan.md or .claude-loop.md present) every fresh or
# compacted context opens already knowing the workflow state — measured pain:
# 33 mid-task compactions in 14 days, each costing a manual re-orientation.
# Prints NOTHING outside gated repos (zero context tax elsewhere).
set -uo pipefail

input=$(cat 2> /dev/null || true)
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2> /dev/null)
[[ -z "$cwd" ]] && cwd="$PWD"

root=$(git -C "$cwd" rev-parse --show-toplevel 2> /dev/null) || exit 0

gate=""
for candidate in "$root/.pair/plan.md" "$root/.claude-loop.md"; do
  [[ -f "$candidate" ]] && gate="$candidate" && break
done
[[ -z "$gate" ]] && exit 0

open=$(grep -cE '^[[:space:]]*[-*] \[ \]' "$gate" 2> /dev/null || true)
done_n=$(grep -cE '^[[:space:]]*[-*] \[x\]' "$gate" 2> /dev/null || true)
next=$(grep -E '^[[:space:]]*[-*] \[ \]' "$gate" | head -1 | sed 's/^[[:space:]]*//')
fixes=$(grep -cE '^[[:space:]]*[-*] \[ \] BLOCKER:' "$gate" 2> /dev/null || true)

echo "Pair/loop gate active: $(basename "$gate") — ${done_n:-0} done, ${open:-0} open$([[ "${fixes:-0}" -gt 0 ]] && echo " (${fixes} unresolved review BLOCKERs)")."
if [[ "${open:-0}" -gt 0 ]]; then
  echo "Next task: $next"
  echo "Re-read $gate before working — it is the source of truth. The stop-gate blocks 'done' while tasks are open."
else
  echo "All tasks checked — verify acceptance criteria hold, then this feature can be closed (<leader>pD archives .pair/)."
fi
exit 0
