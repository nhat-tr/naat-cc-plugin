#!/usr/bin/env bash
set -uo pipefail

hook_dir=$(cd "$(dirname "$0")" && pwd)
adapter="$hook_dir/../skills/pair-v3/scripts/pair-handover-adapter"
[[ -f "$adapter" ]] || exit 0
exec node "$adapter"
