#!/usr/bin/env bash
# install.sh — Install nhat-dev-toolkit plugin for Claude Code.
#
# Usage:
#   ./install.sh              Install plugin (agents, skills, commands, CLI tools, infra deps)
#   ./install.sh --uninstall  Remove installed plugin
#
# Fresh macOS setup:
#   git clone <repo> ~/.local/share/my-claude-code
#   cd ~/.local/share/my-claude-code && ./install.sh
#
# What gets installed:
#   ~/.claude/agents/         Symlinked agent files
#   ~/.claude/commands/       Symlinked command files
#   ~/.claude/contexts/       Copied context files
#   ~/.local/bin/             CLI tools (jaeger, grafana, kibana-logs)
#   infra/node_modules/       TypeScript dependencies
#   tsx (global)              TypeScript runner
#
# Prerequisites (checked automatically):
#   node >= 20, npm, kubectl
#
# Note: This script uses symlinks so your edits to the source repo
# are immediately available without re-installing.

set -euo pipefail

# --- Resolve script location (handles symlinks) ---
SCRIPT_PATH="$0"
while [ -L "$SCRIPT_PATH" ]; do
    link_dir="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
    SCRIPT_PATH="$(readlink "$SCRIPT_PATH")"
    [[ "$SCRIPT_PATH" != /* ]] && SCRIPT_PATH="$link_dir/$SCRIPT_PATH"
done
PLUGIN_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"

CLAUDE_DIR="${CLAUDE_HOME:-$HOME/.claude}"
AGENTS_DIR="$CLAUDE_DIR/agents"
COMMANDS_DIR="$CLAUDE_DIR/commands"
CONTEXTS_DIR="$CLAUDE_DIR/contexts"
GLOBAL_CLAUDE_FILE="$CLAUDE_DIR/CLAUDE.md"
LOCAL_BIN="${HOME}/.local/bin"

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${GREEN}[+]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[x]${NC} $1" >&2; }

install_hooks() {
    local hooks_file="$PLUGIN_DIR/hooks/hooks.json"
    local settings_file="$CLAUDE_DIR/settings.json"

    if [[ ! -f "$hooks_file" ]]; then
        warn "  No hooks/hooks.json found, skipping"
        return 0
    fi
    if [[ ! -f "$settings_file" ]]; then
        warn "  $settings_file not found, skipping hooks"
        return 0
    fi

    python3 - "$hooks_file" "$settings_file" <<'EOF'
import json, sys

hooks_file, settings_file = sys.argv[1], sys.argv[2]

with open(hooks_file) as f:
    plugin_hooks = json.load(f).get("hooks", {})

with open(settings_file) as f:
    settings = json.load(f)

settings.setdefault("hooks", {})
added = 0

for event, matchers in plugin_hooks.items():
    settings["hooks"].setdefault(event, [])
    for matcher in matchers:
        plugin_commands = {h["command"] for h in matcher.get("hooks", [])}
        already_exists = any(
            plugin_commands <= {h["command"] for h in existing.get("hooks", [])}
            for existing in settings["hooks"][event]
            if existing.get("matcher") == matcher.get("matcher")
        )
        if not already_exists:
            settings["hooks"][event].append(matcher)
            added += 1

with open(settings_file, "w") as f:
    json.dump(settings, f, indent=2)
    f.write("\n")

print(f"Added {added} hook matcher(s)")
EOF
}

uninstall_hooks() {
    local hooks_file="$PLUGIN_DIR/hooks/hooks.json"
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

removed = 0

for event, matchers in plugin_hooks.items():
    if event not in settings.get("hooks", {}):
        continue
    plugin_commands = {h["command"] for matcher in matchers for h in matcher.get("hooks", [])}
    before = len(settings["hooks"][event])
    settings["hooks"][event] = [
        existing for existing in settings["hooks"][event]
        if not ({h["command"] for h in existing.get("hooks", [])} & plugin_commands)
    ]
    removed += before - len(settings["hooks"][event])

with open(settings_file, "w") as f:
    json.dump(settings, f, indent=2)
    f.write("\n")

print(f"Removed {removed} hook matcher(s)")
EOF
}

install_claude_md() {
    local source="$PLUGIN_DIR/CLAUDE.md"
    local target="$GLOBAL_CLAUDE_FILE"

    if [[ ! -f "$source" ]]; then
        error "CLAUDE.md not found in plugin directory"
        return 1
    fi

    mkdir -p "$(dirname "$target")"

    # Back up existing file if it wasn't installed by us
    if [[ -f "$target" ]] && ! grep -q '__PLUGIN_DIR__\|nhat-dev-toolkit' "$target" 2>/dev/null; then
        cp "$target" "$target.bak"
        warn "Backed up existing CLAUDE.md to $target.bak"
    fi

    sed "s|__PLUGIN_DIR__|$PLUGIN_DIR|g" "$source" > "$target"
    info "Installed CLAUDE.md"
}

symlink_files() {
    local label="$1"
    local src_glob="$2"
    local dest_dir="$3"

    for f in $src_glob; do
        [[ -e "$f" ]] || continue
        name="$(basename "$f")"
        target="$dest_dir/$name"

        if [[ -L "$target" ]]; then
            existing="$(readlink "$target")"
            if [[ "$existing" == "$f" ]]; then
                warn "  $name (already linked)"
                ((skipped++))
                continue
            else
                warn "  $name exists -> $existing (overwriting)"
                rm "$target"
            fi
        elif [[ -f "$target" ]]; then
            warn "  $name exists (regular file, backing up to $target.bak)"
            mv "$target" "$target.bak"
        fi

        ln -s "$f" "$target"
        info "  $name"
        ((installed++))
    done
}

prune_stale() {
    # Remove symlinks in dest_dir that point into plugin_dir but whose source no longer exists.
    local dest_dir="$1"
    local plugin_prefix="$2"  # only prune symlinks pointing under this path

    [[ -d "$dest_dir" ]] || return 0
    for target in "$dest_dir"/*; do
        [[ -L "$target" ]] || continue
        link_target="$(readlink "$target")"
        # Only prune symlinks that point into our plugin dir
        [[ "$link_target" == "$plugin_prefix"* ]] || continue
        # If the source file/dir no longer exists, remove
        if [[ ! -e "$link_target" ]]; then
            name="$(basename "$target")"
            rm "$target"
            warn "  $name (retired — removed stale symlink)"
            ((pruned++))
        fi
    done
}

# --- Uninstall ---
if [[ "${1:-}" == "--uninstall" ]]; then
    echo -e "${BOLD}Uninstalling nhat-dev-toolkit${NC}"
    echo ""

    removed=0

    # Remove symlinked agents
    for f in "$PLUGIN_DIR"/agents/*.md; do
        name="$(basename "$f")"
        target="$AGENTS_DIR/$name"
        if [[ -L "$target" ]]; then
            rm "$target"
            info "Removed agent: $name"
            ((removed++))
        fi
    done

    # Remove symlinked commands
    for f in "$PLUGIN_DIR"/commands/*.md; do
        name="$(basename "$f")"
        target="$COMMANDS_DIR/$name"
        if [[ -L "$target" ]]; then
            rm "$target"
            info "Removed command: $name"
            ((removed++))
        fi
    done

    # Remove symlinked skills
    for d in "$PLUGIN_DIR"/skills/*/; do
        skill_name="$(basename "$d")"
        name="$skill_name.md"
        target="$COMMANDS_DIR/$name"
        [[ -f "$PLUGIN_DIR/commands/$name" ]] && continue
        if [[ -L "$target" ]]; then
            rm "$target"
            info "Removed skill: $name"
            ((removed++))
        fi
    done

    # Remove copied contexts
    for f in "$PLUGIN_DIR"/contexts/*.md; do
        name="$(basename "$f")"
        target="$CONTEXTS_DIR/$name"
        if [[ -f "$target" ]]; then
            rm "$target"
            info "Removed context: $name"
            ((removed++))
        fi
    done

    # Remove CLI tool symlinks
    for f in "$PLUGIN_DIR"/bin/*; do
        [[ -f "$f" ]] || continue
        name="$(basename "$f")"
        target="$LOCAL_BIN/$name"
        if [[ -L "$target" ]]; then
            rm "$target"
            info "Removed CLI: $name"
            ((removed++))
        fi
    done

    if [[ $removed -eq 0 ]]; then
        warn "Nothing to remove."
    else
        echo ""
        info "Uninstalled $removed files."
    fi

    if [[ -f "$GLOBAL_CLAUDE_FILE" ]]; then
        rm "$GLOBAL_CLAUDE_FILE"
        info "Removed CLAUDE.md: $GLOBAL_CLAUDE_FILE"
        if [[ -f "$GLOBAL_CLAUDE_FILE.bak" ]]; then
            mv "$GLOBAL_CLAUDE_FILE.bak" "$GLOBAL_CLAUDE_FILE"
            info "Restored backup: $GLOBAL_CLAUDE_FILE"
        fi
    fi

    echo ""
    echo -e "${BOLD}Hooks${NC}"
    uninstall_hooks

    exit 0
fi

# --- Install ---
echo -e "${BOLD}Installing nhat-dev-toolkit${NC}"
echo -e "Source: $PLUGIN_DIR"
echo ""

# Verify source files exist
if [[ ! -f "$PLUGIN_DIR/.claude-plugin/plugin.json" ]]; then
    error "plugin.json not found. Run this script from the plugin repo root."
    exit 1
fi

# --- Prerequisites ---
echo -e "${BOLD}Prerequisites${NC}"
missing=0

check_cmd() {
    if command -v "$1" &>/dev/null; then
        info "  $1: $(command -v "$1")"
    else
        error "  $1: NOT FOUND"
        ((missing++))
    fi
}

check_cmd node
check_cmd npm
check_cmd kubectl

if [[ $missing -gt 0 ]]; then
    echo ""
    error "Missing $missing prerequisite(s). Install them and re-run."
    echo "  brew install node kubectl"
    exit 1
fi

# Check node version >= 20
node_major=$(node -v | sed 's/v\([0-9]*\).*/\1/')
if [[ $node_major -lt 20 ]]; then
    error "  Node.js >= 20 required (found v$(node -v))"
    exit 1
fi

# --- Infra dependencies (install early — CLI tools need tsx) ---
echo ""
echo -e "${BOLD}Infra dependencies${NC}"
if ! command -v tsx &>/dev/null; then
    info "  Installing tsx globally..."
    npm install -g tsx
else
    info "  tsx: $(command -v tsx) (already installed)"
fi
if [[ ! -d "$PLUGIN_DIR/infra/node_modules/@types/node" ]]; then
    info "  Installing infra node dependencies..."
    (cd "$PLUGIN_DIR/infra" && npm install)
else
    info "  infra/node_modules: up to date"
fi

# Create directories
mkdir -p "$AGENTS_DIR" "$COMMANDS_DIR" "$CONTEXTS_DIR" "$LOCAL_BIN"

installed=0
skipped=0
pruned=0

# --- Prune stale symlinks (retired assets) ---
echo -e "${BOLD}Pruning retired assets${NC}"
prune_stale "$AGENTS_DIR" "$PLUGIN_DIR/agents/"
prune_stale "$COMMANDS_DIR" "$PLUGIN_DIR/commands/"
prune_stale "$COMMANDS_DIR" "$PLUGIN_DIR/skills/"
prune_stale "$LOCAL_BIN" "$PLUGIN_DIR/bin/"
if [[ $pruned -gt 0 ]]; then
    info "  Pruned $pruned stale symlink(s)"
else
    info "  Nothing to prune"
fi

# --- Agents (symlink) ---
echo ""
echo -e "${BOLD}Agents${NC}"
symlink_files "agent" "$PLUGIN_DIR/agents/*.md" "$AGENTS_DIR"

# --- Commands (symlink) ---
echo ""
echo -e "${BOLD}Commands${NC}"
symlink_files "command" "$PLUGIN_DIR/commands/*.md" "$COMMANDS_DIR"

# --- Skills (symlink SKILL.md as <skill-name>.md in commands) ---
echo ""
echo -e "${BOLD}Skills${NC}"
for d in "$PLUGIN_DIR"/skills/*/; do
    skill_name="$(basename "$d")"
    f="$d/SKILL.md"
    name="$skill_name.md"
    target="$COMMANDS_DIR/$name"

    if [[ ! -f "$f" ]]; then
        warn "  $skill_name/ (no SKILL.md, skipping)"
        continue
    fi

    # Don't overwrite a command wrapper that already covers this name
    if [[ -f "$PLUGIN_DIR/commands/$name" ]]; then
        warn "  $name (shadowed by commands/$name, skipping)"
        ((skipped++))
        continue
    fi

    if [[ -L "$target" ]]; then
        existing="$(readlink "$target")"
        if [[ "$existing" == "$f" ]]; then
            warn "  $name (already linked)"
            ((skipped++))
            continue
        else
            warn "  $name exists -> $existing (overwriting)"
            rm "$target"
        fi
    elif [[ -f "$target" ]]; then
        warn "  $name exists (regular file, backing up to $target.bak)"
        mv "$target" "$target.bak"
    fi

    ln -s "$f" "$target"
    info "  $name"
    ((installed++))
done

# --- Contexts (copy — small files, no symlink needed) ---
echo ""
echo -e "${BOLD}Contexts${NC}"
for f in "$PLUGIN_DIR"/contexts/*.md; do
    name="$(basename "$f")"
    target="$CONTEXTS_DIR/$name"

    if [[ -f "$target" ]]; then
        if diff -q "$f" "$target" > /dev/null 2>&1; then
            warn "  $name (already up to date)"
            ((skipped++))
            continue
        else
            warn "  $name exists (updating)"
        fi
    fi

    cp "$f" "$target"
    info "  $name"
    ((installed++))
done

# --- CLI tools (symlink to ~/.local/bin) ---
echo ""
echo -e "${BOLD}CLI Tools${NC}"
symlink_files "cli" "$PLUGIN_DIR/bin/*" "$LOCAL_BIN"

# --- Hooks ---
echo ""
echo -e "${BOLD}Hooks${NC}"
install_hooks

# --- Language routing in CLAUDE.md ---
install_claude_md

# --- Summary ---
echo ""
echo -e "${BOLD}Installation complete${NC}"
echo ""
info "Installed: $installed"
[[ $skipped -gt 0 ]] && warn "Skipped:   $skipped (already installed)"
[[ $pruned -gt 0 ]] && warn "Pruned:    $pruned (retired assets removed)"
echo ""
echo "Installed to:"
echo "  Agents:    $AGENTS_DIR/"
echo "  Commands:  $COMMANDS_DIR/"
echo "  Contexts:  $CONTEXTS_DIR/"
echo "  Skills:    $COMMANDS_DIR/<skill-name>.md"
echo "  CLI Tools: $LOCAL_BIN/{jaeger,grafana,kibana-logs,kibana-traffic,aspire-logs,aspire-traces}"
echo "  CLAUDE.md: $GLOBAL_CLAUDE_FILE"
echo ""

# --- PATH check ---
if [[ ":$PATH:" != *":$LOCAL_BIN:"* ]]; then
    warn "$LOCAL_BIN is not in PATH. Add to your shell profile:"
    echo ""
    echo '  export PATH="$HOME/.local/bin:$PATH"'
    echo ""
fi

# --- CLI help verification ---
echo -e "${BOLD}CLI verification${NC}"
cli_ok=0
cli_fail=0
for cmd in jaeger grafana kibana-logs kibana-traffic aspire-logs aspire-traces; do
    if "$LOCAL_BIN/$cmd" --help &>/dev/null; then
        info "  $cmd --help OK"
        ((cli_ok++))
    else
        error "  $cmd --help FAILED"
        ((cli_fail++))
    fi
done
[[ $cli_fail -gt 0 ]] && warn "$cli_fail CLI tool(s) failed verification"

# --- Environment checks ---
echo ""
echo -e "${BOLD}Environment checks${NC}"
if [[ ":$PATH:" != *":$LOCAL_BIN:"* ]]; then
    warn "$LOCAL_BIN is not in PATH. Add to your shell profile:"
    echo '  export PATH="$HOME/.local/bin:$PATH"'
fi
if ! kubectl cluster-info &>/dev/null 2>&1; then
    warn "kubectl not connected to a cluster. Remote CLI tools (jaeger, grafana, kibana-logs) need cluster access."
fi
if [[ ! -f /tmp/aspire-telemetry/logs.jsonl ]]; then
    info "Aspire OTLP files not found. aspire-logs/aspire-traces will work once Aspire runs with the file exporter."
fi