#!/usr/bin/env bash
# install-codex.sh — Install nhat-dev-toolkit skills for Codex.
#
# Usage:
#   ./install-codex.sh              Install skills
#   ./install-codex.sh --uninstall  Remove installed skill symlinks
#
# Installs to BOTH discovery paths:
#   ~/.codex/skills/     (legacy Codex path)
#   ~/.agents/skills/    (current Codex discovery path)
#
# Also installs AGENTS.md to:
#   ~/.codex/AGENTS.md
#   ~/.agents/AGENTS.md

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
AGENTS_DIR="$HOME/.agents"
SKILLS_DIRS=("$CODEX_DIR/skills" "$AGENTS_DIR/skills")
SRC_SKILLS_DIR="$PLUGIN_DIR/skills"
GLOBAL_AGENTS_FILES=("$CODEX_DIR/AGENTS.md" "$AGENTS_DIR/AGENTS.md")

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
NC='\033[0m'

AGENTS_MANAGED_MARKER="nhat-dev-toolkit managed global instructions template"

info()  { echo -e "${GREEN}[+]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[x]${NC} $1" >&2; }

install_agents_md() {
  local source="$PLUGIN_DIR/AGENTS.md"
  local target

  if [[ ! -f "$source" ]]; then
    error "AGENTS.md not found in plugin directory"
    return 1
  fi

  for target in "${GLOBAL_AGENTS_FILES[@]}"; do
    mkdir -p "$(dirname "$target")"

    if [[ -f "$target" ]] && ! grep -q "$AGENTS_MANAGED_MARKER" "$target" 2>/dev/null; then
      cp "$target" "$target.bak"
      warn "Backed up existing AGENTS.md to $target.bak"
    fi

    sed "s|__PLUGIN_DIR__|$PLUGIN_DIR|g" "$source" > "$target"
    info "Installed AGENTS.md: $target"
  done
}

if [[ ! -d "$SRC_SKILLS_DIR" ]]; then
  error "skills/ directory not found in plugin repo."
  exit 1
fi

if [[ "${1:-}" == "--uninstall" ]]; then
  echo -e "${BOLD}Uninstalling nhat-dev-toolkit skills from Codex${NC}"
  echo ""

  removed=0
  for skills_dir in "${SKILLS_DIRS[@]}"; do
    [[ -d "$skills_dir" ]] || continue
    for src in "$SRC_SKILLS_DIR"/*; do
      [[ -d "$src" ]] || continue
      [[ -f "$src/SKILL.md" ]] || continue

      name="$(basename "$src")"
      target="$skills_dir/$name"

      if [[ -L "$target" ]]; then
        link_target="$(readlink "$target")"
        if [[ "$link_target" == "$src" ]]; then
          rm "$target"
          info "Removed skill: $name (from $skills_dir)"
          ((removed+=1))
        fi
      fi
    done
  done

  if [[ $removed -eq 0 ]]; then
    warn "No installed nhat-dev-toolkit skill symlinks found."
  else
    echo ""
    info "Uninstalled $removed skills."
  fi

  for gf in "${GLOBAL_AGENTS_FILES[@]}"; do
    if [[ -f "$gf" ]]; then
      rm "$gf"
      info "Removed AGENTS.md: $gf"
      if [[ -f "$gf.bak" ]]; then
        mv "$gf.bak" "$gf"
        info "Restored backup: $gf"
      fi
    fi
  done

  exit 0
fi

echo -e "${BOLD}Installing nhat-dev-toolkit skills for Codex${NC}"
echo -e "Source: $PLUGIN_DIR"
echo -e "Targets: ${SKILLS_DIRS[*]}"
echo ""

installed=0
skipped=0
pruned=0

# Only install skills that are Codex-compatible.
# Source of truth: metadata/runtime-asset-map.yaml
# - codex.workflow_skills: review-workflow, planner-workflow,
#   architect-workflow, discovery-workflow, sonar-workflow
# - shared_language_skills: csharp-dotnet, typescript, rust, python, security-review
# - direct codex skills: evidence-discipline
#
# Skills NOT installed (Claude Code-only):
# - pair-plan, pair-implement, pair-review, pair-review-eco, pair-plan-challenge
#   (require .pair/ state, /clear command, jq, sub-agent orchestration)
# - observability-index (requires npx tsx, mcp__embedcode__ tools)
# - get-api-docs (requires chub CLI)
CODEX_SKILLS=(
  review-workflow
  planner-workflow
  architect-workflow
  discovery-workflow
  sonar-workflow
  csharp-dotnet
  typescript
  rust
  python
  security-review
  evidence-discipline
)

for skills_dir in "${SKILLS_DIRS[@]}"; do
  mkdir -p "$skills_dir"
  echo -e "${BOLD}  $skills_dir${NC}"

  # --- Prune stale skills (retired from repo or dropped from allowlist) ---
  for target in "$skills_dir"/*/; do
    [[ -L "${target%/}" ]] || continue
    link_target="$(readlink "${target%/}")"
    [[ "$link_target" == "$SRC_SKILLS_DIR/"* ]] || continue
    name="$(basename "${target%/}")"
    found=0
    for allowed in "${CODEX_SKILLS[@]}"; do
      [[ "$name" == "$allowed" ]] && found=1 && break
    done
    if [[ $found -eq 0 ]]; then
      rm "${target%/}"
      warn "  $name (retired — removed stale symlink)"
      ((pruned++))
    fi
  done

  # --- Install skills ---
  for name in "${CODEX_SKILLS[@]}"; do
    src="$SRC_SKILLS_DIR/$name"
    target="$skills_dir/$name"

    if [[ ! -d "$src" ]] || [[ ! -f "$src/SKILL.md" ]]; then
      warn "  $name (not found in source, skipping)"
      continue
    fi

    if [[ -L "$target" ]]; then
      existing="$(readlink "$target")"
      if [[ "$existing" == "$src" ]]; then
        warn "  $name (already linked)"
        ((skipped+=1))
        continue
      else
        warn "  $name exists -> $existing (overwriting)"
        rm "$target"
      fi
    elif [[ -e "$target" ]]; then
      warn "  $name exists (backing up to $target.bak)"
      mv "$target" "$target.bak"
    fi

    ln -s "$src" "$target"
    info "  $name"
    ((installed+=1))
  done
  echo ""
done

# --- Global AGENTS.md installation ---
install_agents_md

echo ""
echo -e "${BOLD}Installation complete${NC}"
info "Installed: $installed"
[[ $skipped -gt 0 ]] && warn "Skipped:   $skipped (already installed)"
[[ $pruned -gt 0 ]] && warn "Pruned:    $pruned (retired skills removed)"
echo ""
echo "Skills installed at:"
for sd in "${SKILLS_DIRS[@]}"; do echo "  $sd"; done
echo "Global AGENTS.md installed at:"
for gf in "${GLOBAL_AGENTS_FILES[@]}"; do echo "  $gf"; done
