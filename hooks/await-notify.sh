#!/usr/bin/env bash
# await-notify — Notification hook.
#
# Fires when Claude needs attention (permission prompt, idle waiting for
# input). Sends a macOS notification so a prompt raised while you are away
# from the pane is noticed in minutes, not the next morning — the failure
# mode: an unattended prompt stalls a loop until answered.
# Opt-out: CLAUDE_AWAIT_NOTIFY=off.
set -uo pipefail

[[ "${CLAUDE_AWAIT_NOTIFY:-on}" == "off" ]] && exit 0
command -v osascript > /dev/null 2>&1 || exit 0

input=$(cat 2> /dev/null || true)
msg=$(printf '%s' "$input" | jq -r '.message // "Claude needs your attention"' 2> /dev/null)
[[ -z "$msg" || "$msg" == "null" ]] && msg="Claude needs your attention"
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2> /dev/null)
repo=$(basename "${cwd:-?}")

# Escape double quotes for the AppleScript string literal.
msg=${msg//\"/\\\"}
osascript -e "display notification \"$msg\" with title \"Claude Code — $repo\" sound name \"Ping\"" > /dev/null 2>&1 || true
exit 0
