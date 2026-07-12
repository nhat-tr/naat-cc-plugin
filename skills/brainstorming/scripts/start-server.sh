#!/usr/bin/env bash
# Foreground-only visual session. The process must stay attached to Codex/Claude.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "$SCRIPT_DIR/visual-session.cjs" start "$@"
