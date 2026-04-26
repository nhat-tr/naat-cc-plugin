#!/usr/bin/env bash
# install-copilot.sh — optional global skill install for GitHub Copilot.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "node is required to run install-copilot.sh" >&2
  exit 1
fi

exec node scripts/install-runtime.js --runtime copilot --scope global "$@"
