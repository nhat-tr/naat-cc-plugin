#!/bin/bash
# PreToolUse hook: block whole-file reads on files over the threshold.
#
# Receives JSON on stdin: {"tool_name":"Read","tool_input":{"file_path":"...","offset":N,"limit":N}}
# Exit 0 → allow. Exit 2 → block (stdout shown to agent as feedback).

THRESHOLD=80

input=$(cat)

file_path=$(printf '%s' "$input" | python3 -c "
import json, sys
d = json.load(sys.stdin)
print(d.get('tool_input', {}).get('file_path', ''))
" 2>/dev/null)

[[ -z "$file_path" ]] && exit 0
[[ ! -f "$file_path" ]] && exit 0

# Allow binary/non-text formats
ext="${file_path##*.}"
case "$ext" in
  pdf|png|jpg|jpeg|gif|webp|ico|woff|woff2|ttf|eot|mp4|mp3|zip|tar|gz|bin|exe|dll|so) exit 0 ;;
esac

line_count=$(wc -l < "$file_path" 2>/dev/null) || exit 0
[[ "$line_count" -le "$THRESHOLD" ]] && exit 0

# File is large — parse offset and limit
read_offset=$(printf '%s' "$input" | python3 -c "
import json, sys
ti = json.load(sys.stdin).get('tool_input', {})
v = ti.get('offset')
print(v if v is not None else 0)
" 2>/dev/null)

read_limit=$(printf '%s' "$input" | python3 -c "
import json, sys
ti = json.load(sys.stdin).get('tool_input', {})
v = ti.get('limit')
print(v if v is not None else 0)
" 2>/dev/null)

# Block: no limit set at all
if [[ "$read_limit" -eq 0 ]]; then
  echo "BLOCKED: whole-file Read on a ${line_count}-line file."
  echo "  1. grep -n '<symbol>' '$file_path' | head -5   → find the line range"
  echo "  2. Set offset + limit to cover only that range"
  exit 2
fi

# Block: limit covers nearly the whole file from the start (bypass attempt)
# offset <= 1 and limit >= line_count - 5  →  effectively reading everything
if [[ "$read_offset" -le 1 && "$read_limit" -ge $(( line_count - 5 )) ]]; then
  echo "BLOCKED: offset=${read_offset} limit=${read_limit} on a ${line_count}-line file reads the whole file."
  echo "  1. grep -n '<symbol>' '$file_path' | head -5   → find the line range"
  echo "  2. Set a narrow offset + limit for only the relevant section"
  exit 2
fi

exit 0