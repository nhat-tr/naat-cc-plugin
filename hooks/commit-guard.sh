#!/usr/bin/env bash
# commit-guard — PreToolUse[Bash] hook (filtered to git commit commands).
#
# Deterministically enforces the CLAUDE.md rule "never add a Co-Authored-By
# trailer": blocks the commit BEFORE it runs instead of scolding after.
# Exit 2 = block the tool call, stderr is fed back to the model.
set -uo pipefail

input=$(cat)
command -v jq > /dev/null 2>&1 || exit 0

cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty')
[[ -z "$cmd" ]] && exit 0
case "$cmd" in *"git commit"*) ;; *) exit 0 ;; esac

if printf '%s' "$cmd" | grep -qiE 'Co-Authored-By|Generated with \[?Claude'; then
  echo "commit-guard: BLOCKED — commit message contains an attribution trailer (Co-Authored-By / Generated with Claude). The user's global rules forbid these. Re-run the commit with the trailer removed." >&2
  exit 2
fi
exit 0
