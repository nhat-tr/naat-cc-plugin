#!/usr/bin/env bash
# install.sh — Claude-oriented wrapper around the canonical runtime installer.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

CLAUDE_DIR="${CLAUDE_HOME:-$HOME/.claude}"
LOCAL_BIN="$HOME/.local/bin"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${GREEN}[+]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[x]${NC} $1" >&2; }

install_hooks() {
  local hooks_file="hooks/hooks.json"
  local settings_file="$CLAUDE_DIR/settings.json"

  [[ -f "$hooks_file" ]] || return 0
  [[ -f "$settings_file" ]] || return 0

  python3 - "$hooks_file" "$settings_file" <<'EOF'
import json, sys
hooks_file, settings_file = sys.argv[1], sys.argv[2]
with open(hooks_file) as f:
    plugin_hooks = json.load(f).get("hooks", {})
with open(settings_file) as f:
    settings = json.load(f)
settings.setdefault("hooks", {})
for event, matchers in plugin_hooks.items():
    settings["hooks"].setdefault(event, [])
    existing = settings["hooks"][event]
    for matcher in matchers:
        if matcher not in existing:
            existing.append(matcher)
with open(settings_file, "w") as f:
    json.dump(settings, f, indent=2)
    f.write("\n")
EOF
}

uninstall_hooks() {
  local hooks_file="hooks/hooks.json"
  local settings_file="$CLAUDE_DIR/settings.json"

  [[ -f "$hooks_file" ]] || return 0
  [[ -f "$settings_file" ]] || return 0

  python3 - "$hooks_file" "$settings_file" <<'EOF'
import json, sys
hooks_file, settings_file = sys.argv[1], sys.argv[2]
with open(hooks_file) as f:
    plugin_hooks = json.load(f).get("hooks", {})
with open(settings_file) as f:
    settings = json.load(f)
for event, matchers in plugin_hooks.items():
    if event not in settings.get("hooks", {}):
        continue
    commands = {hook["command"] for matcher in matchers for hook in matcher.get("hooks", [])}
    settings["hooks"][event] = [
        entry for entry in settings["hooks"][event]
        if not ({hook["command"] for hook in entry.get("hooks", [])} & commands)
    ]
with open(settings_file, "w") as f:
    json.dump(settings, f, indent=2)
    f.write("\n")
EOF
}

link_cli_tools() {
  mkdir -p "$LOCAL_BIN"
  for file in bin/*; do
    [[ -f "$file" ]] || continue
    ln -snf "$PWD/$file" "$LOCAL_BIN/$(basename "$file")"
  done
}

unlink_cli_tools() {
  for file in bin/*; do
    [[ -f "$file" ]] || continue
    rm -f "$LOCAL_BIN/$(basename "$file")"
  done
}

check_prerequisites() {
  local missing=0
  for cmd in node npm kubectl; do
    if command -v "$cmd" >/dev/null 2>&1; then
      info "$cmd: $(command -v "$cmd")"
    else
      error "$cmd: NOT FOUND"
      missing=1
    fi
  done
  if [[ $missing -ne 0 ]]; then
    exit 1
  fi
}

install_infra_deps() {
  if ! command -v tsx >/dev/null 2>&1; then
    npm install -g tsx
  fi
  if [[ ! -d infra/node_modules/@types/node ]]; then
    (cd infra && npm install)
  fi
}

if [[ "${1:-}" == "--uninstall" ]]; then
  node scripts/install-runtime.js --runtime claude --scope global --uninstall "${@:2}"
  unlink_cli_tools
  uninstall_hooks
  exit 0
fi

echo -e "${BOLD}Installing nhat-dev-toolkit${NC}"
check_prerequisites
install_infra_deps
node scripts/install-runtime.js --runtime claude --scope global "$@"
link_cli_tools
install_hooks
info "Claude runtime install complete"
