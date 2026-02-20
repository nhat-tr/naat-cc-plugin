#!/usr/bin/env bash
# install.sh — Install nhat-dev-toolkit plugin for Claude Code.
#
# Usage:
#   ./install.sh              Install plugin (agents, skills, commands)
#   ./install.sh --uninstall  Remove installed plugin
#
# What gets installed:
#   ~/.claude/agents/         Symlinked agent files
#   ~/.claude/commands/       Symlinked command files
#   ~/.claude/contexts/       Copied context files
#
# What does NOT get installed (loaded automatically by plugin system):
#   skills/                   Loaded from plugin.json "skills" field
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

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${GREEN}[+]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[x]${NC} $1" >&2; }

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

    if [[ $removed -eq 0 ]]; then
        warn "Nothing to remove."
    else
        echo ""
        info "Uninstalled $removed files."
    fi
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

# Create directories
mkdir -p "$AGENTS_DIR" "$COMMANDS_DIR" "$CONTEXTS_DIR"

installed=0
skipped=0

# --- Agents (symlink) ---
echo -e "${BOLD}Agents${NC}"
for f in "$PLUGIN_DIR"/agents/*.md; do
    name="$(basename "$f")"
    target="$AGENTS_DIR/$name"

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

# --- Commands (symlink) ---
echo ""
echo -e "${BOLD}Commands${NC}"
for f in "$PLUGIN_DIR"/commands/*.md; do
    name="$(basename "$f")"
    target="$COMMANDS_DIR/$name"

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

# --- Summary ---
echo ""
echo -e "${BOLD}Installation complete${NC}"
echo ""
info "Installed: $installed"
[[ $skipped -gt 0 ]] && warn "Skipped:   $skipped (already installed)"
echo ""
echo "Installed to:"
echo "  Agents:   $AGENTS_DIR/"
echo "  Commands: $COMMANDS_DIR/"
echo "  Contexts: $CONTEXTS_DIR/"
echo ""
echo "Skills are loaded automatically from plugin.json."
echo ""

# --- Shell aliases for contexts ---
echo -e "${BOLD}Optional: add these aliases to your shell profile:${NC}"
echo ""
echo "  alias claude-dev='claude --system-prompt \"\$(cat $CONTEXTS_DIR/dev.md)\"'"
echo "  alias claude-review='claude --system-prompt \"\$(cat $CONTEXTS_DIR/review.md)\"'"
echo "  alias claude-research='claude --system-prompt \"\$(cat $CONTEXTS_DIR/research.md)\"'"
echo ""
echo "Then use: claude-dev, claude-review, claude-research"