#!/usr/bin/env bash
# install-codex.sh — Install nhat-dev-toolkit skills for Codex.
#
# Usage:
#   ./install-codex.sh              Install skills to ~/.codex/skills
#   ./install-codex.sh --uninstall  Remove installed skill symlinks

set -euo pipefail

# Resolve script location (handles symlinks)
SCRIPT_PATH="$0"
while [ -L "$SCRIPT_PATH" ]; do
  link_dir="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
  SCRIPT_PATH="$(readlink "$SCRIPT_PATH")"
  [[ "$SCRIPT_PATH" != /* ]] && SCRIPT_PATH="$link_dir/$SCRIPT_PATH"
done
PLUGIN_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"

CODEX_DIR="${CODEX_HOME:-$HOME/.codex}"
SKILLS_DIR="$CODEX_DIR/skills"
SRC_SKILLS_DIR="$PLUGIN_DIR/skills"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${GREEN}[+]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[x]${NC} $1" >&2; }

if [[ ! -d "$SRC_SKILLS_DIR" ]]; then
  error "skills/ directory not found in plugin repo."
  exit 1
fi

if [[ "${1:-}" == "--uninstall" ]]; then
  echo -e "${BOLD}Uninstalling nhat-dev-toolkit skills from Codex${NC}"
  echo ""

  removed=0
  for src in "$SRC_SKILLS_DIR"/*; do
    [[ -d "$src" ]] || continue
    [[ -f "$src/SKILL.md" ]] || continue

    name="$(basename "$src")"
    target="$SKILLS_DIR/$name"

    if [[ -L "$target" ]]; then
      link_target="$(readlink "$target")"
      if [[ "$link_target" == "$src" ]]; then
        rm "$target"
        info "Removed skill: $name"
        ((removed+=1))
      fi
    fi
  done

  if [[ $removed -eq 0 ]]; then
    warn "No installed nhat-dev-toolkit skill symlinks found."
  else
    echo ""
    info "Uninstalled $removed skills."
  fi

  exit 0
fi

echo -e "${BOLD}Installing nhat-dev-toolkit skills for Codex${NC}"
echo -e "Source: $PLUGIN_DIR"
echo -e "Target: $SKILLS_DIR"
echo ""

mkdir -p "$SKILLS_DIR"

installed=0
skipped=0

for src in "$SRC_SKILLS_DIR"/*; do
  [[ -d "$src" ]] || continue
  [[ -f "$src/SKILL.md" ]] || continue

  name="$(basename "$src")"
  target="$SKILLS_DIR/$name"

  if [[ -L "$target" ]]; then
    existing="$(readlink "$target")"
    if [[ "$existing" == "$src" ]]; then
      warn "$name (already linked)"
      ((skipped+=1))
      continue
    else
      warn "$name exists -> $existing (overwriting symlink)"
      rm "$target"
    fi
  elif [[ -e "$target" ]]; then
    backup="$target.bak"
    warn "$name exists (backing up to $backup)"
    mv "$target" "$backup"
  fi

  ln -s "$src" "$target"
  info "$name"
  ((installed+=1))
done

echo ""
echo -e "${BOLD}Installation complete${NC}"
info "Installed: $installed"
[[ $skipped -gt 0 ]] && warn "Skipped:   $skipped (already installed)"
echo ""
echo "Skills installed at: $SKILLS_DIR"
