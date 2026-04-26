#!/usr/bin/env bash
# install-codex.sh — thin wrapper around the canonical runtime installer.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "node is required to run install-codex.sh" >&2
  exit 1
fi

exec node scripts/install-runtime.js --runtime codex --scope global "$@"
