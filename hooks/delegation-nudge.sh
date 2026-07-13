#!/usr/bin/env bash
# delegation-nudge — PostToolUse[Edit|Write|MultiEdit] hook.
#
# Deterministic counterpart to the CLAUDE.md "Delegation & Model Tiering"
# rules: when the MAIN session has personally made many edits, remind it once
# that mechanical remainders belong in a subagent (mech/haiku or
# general-purpose/sonnet). Instructions alone under-deliver — measured: 46
# subagent calls across 5 large sessions while edits ran inline on opus.
#
# Fires exactly once per session, at the Nth edit (default 8). Exit 2 feeds
# stderr to the model without blocking the edit that already ran.
# Opt-out: CLAUDE_DELEGATION_NUDGE=off. Threshold: CLAUDE_DELEGATION_NUDGE_AT.
set -uo pipefail

[[ "${CLAUDE_DELEGATION_NUDGE:-on}" == "off" ]] && exit 0

input=$(cat)
command -v jq > /dev/null 2>&1 || exit 0

session_id=$(printf '%s' "$input" | jq -r '.session_id // empty')
transcript=$(printf '%s' "$input" | jq -r '.transcript_path // empty')
[[ -z "$session_id" ]] && exit 0
# Subagents also fire hooks; only the main session should be nudged.
[[ "$transcript" == */subagents/* ]] && exit 0

state_dir="${CLAUDE_SCRATCH_DIR:-${TMPDIR:-/tmp}}/delegation-nudge"
mkdir -p "$state_dir"
state_file="$state_dir/$session_id"

count=0
[[ -f "$state_file" ]] && read -r count < "$state_file" || true
count=$((${count:-0} + 1))
printf '%s\n' "$count" > "$state_file"

threshold="${CLAUDE_DELEGATION_NUDGE_AT:-8}"
if [[ "$count" -eq "$threshold" ]]; then
  echo "Delegation check: this is your ${threshold}th manual edit this session. If the remaining edits are mechanical or repetitive, batch them into ONE subagent call (mech for rote work on haiku, general-purpose with model=sonnet for self-contained implementation) per the Delegation & Model Tiering rules — write a standalone brief with exact paths and done-criteria. If this work genuinely needs main-session context, continue as you were; this reminder will not repeat." >&2
  exit 2
fi
exit 0
