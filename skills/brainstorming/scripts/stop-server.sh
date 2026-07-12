#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [[ $# -ne 1 ]]; then
  echo '{"error":"Usage: stop-server.sh <session_dir>"}'
  exit 1
fi
exec node "$SCRIPT_DIR/visual-session.cjs" stop --session-dir "$1"
