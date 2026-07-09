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

install_permissions() {
  local perms_file="permissions/allow.json"
  local settings_file="$CLAUDE_DIR/settings.json"

  [[ -f "$perms_file" ]] || return 0
  [[ -f "$settings_file" ]] || return 0

  python3 - "$perms_file" "$settings_file" <<'EOF'
import json, sys
perms_file, settings_file = sys.argv[1], sys.argv[2]
with open(perms_file) as f:
    entries = json.load(f).get("allow", [])
with open(settings_file) as f:
    settings = json.load(f)
settings.setdefault("permissions", {}).setdefault("allow", [])
existing = settings["permissions"]["allow"]
for entry in entries:
    if entry not in existing:
        existing.append(entry)
with open(settings_file, "w") as f:
    json.dump(settings, f, indent=2)
    f.write("\n")
EOF
}

uninstall_permissions() {
  local perms_file="permissions/allow.json"
  local settings_file="$CLAUDE_DIR/settings.json"

  [[ -f "$perms_file" ]] || return 0
  [[ -f "$settings_file" ]] || return 0

  python3 - "$perms_file" "$settings_file" <<'EOF'
import json, sys
perms_file, settings_file = sys.argv[1], sys.argv[2]
with open(perms_file) as f:
    entries = set(json.load(f).get("allow", []))
with open(settings_file) as f:
    settings = json.load(f)
allow = settings.get("permissions", {}).get("allow", [])
settings["permissions"]["allow"] = [e for e in allow if e not in entries]
with open(settings_file, "w") as f:
    json.dump(settings, f, indent=2)
    f.write("\n")
EOF
}

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

# Replace-by-marker: strip every previously-managed entry first, so hooks
# removed/renamed in hooks.json can never strand stale copies in settings
# (an orphaned disabled guard-read.sh hook once ran on every Read this way).
MARKERS = ("my-claude-code", "⚠ VERIFY before done")
def managed(entry):
    return any(m in hook.get("command", "") for hook in entry.get("hooks", []) for m in MARKERS)
for event in list(settings["hooks"].keys()):
    settings["hooks"][event] = [e for e in settings["hooks"][event] if not managed(e)]

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
  uninstall_permissions
  uninstall_hooks
  exit 0
fi

echo -e "${BOLD}Installing nhat-dev-toolkit${NC}"
check_prerequisites
install_infra_deps
# CLI tools are manifest-driven inside install-runtime.js (installCliTools)
node scripts/install-runtime.js --runtime claude --scope global "$@"
install_permissions
install_hooks
info "Claude runtime install complete"
