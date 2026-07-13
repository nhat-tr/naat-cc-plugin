#!/usr/bin/env bash
# scratch-guard — PreToolUse[Write] hook.
#
# Enforces the Scratch & Temp Files rules at the moment of violation instead
# of hoping the instruction sticks (measured: 12 tmp-*.spec.ts files written
# into a repo tree, 60 raw /tmp files in 5 sessions):
#   - no throwaway diagnostic files (tmp-*.spec/test.*) inside the repo tree
#   - no writes to raw /tmp or /private/tmp
# The harness session scratchpad (/tmp/claude-* or /private/tmp/claude-*) and
# $CLAUDE_SCRATCH_DIR are always allowed.
# Exit 2 = block the Write, stderr is fed back to the model.
set -uo pipefail

input=$(cat)
command -v jq > /dev/null 2>&1 || exit 0

path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')
[[ -z "$path" ]] && exit 0

scratch="${CLAUDE_SCRATCH_DIR:-$HOME/.claude-scratch}"

# Always allowed: the pre-approved scratch roots.
case "$path" in
  "$scratch"/* | /tmp/claude-* | /private/tmp/claude-*) exit 0 ;;
esac

# Raw system temp is off-limits.
case "$path" in
  /tmp/* | /private/tmp/*)
    echo "scratch-guard: BLOCKED — do not write to raw /tmp. Use \$CLAUDE_SCRATCH_DIR ($scratch/<repo>/<purpose>) per the Scratch & Temp Files rules." >&2
    exit 2
    ;;
esac

# Throwaway diagnostic specs/tests do not belong in the repo tree.
base=$(basename "$path")
if [[ "$base" =~ ^tmp-.*\.(spec|test)\.[A-Za-z]+$ ]]; then
  echo "scratch-guard: BLOCKED — throwaway diagnostic file '$base' must not be written into the repo tree. Write it under \$CLAUDE_SCRATCH_DIR ($scratch/<repo>/) instead, or give it a real name and a permanent home if it is a genuine test." >&2
  exit 2
fi
exit 0
