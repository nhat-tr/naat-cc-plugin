#!/usr/bin/env bash
# set -uo pipefail
#
# [[ "${PAIR_STOP_GATE:-on}" == "off" || "${CLAUDE_STOP_GATE:-on}" == "off" ]] && exit 0
#
# hook_dir=$(cd "$(dirname "$0")" && pwd)
# adapter="$hook_dir/../skills/pair-v3/scripts/pair-stop-adapter"
# [[ -f "$adapter" ]] || exit 0
# exec node "$adapter"
