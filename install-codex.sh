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
GLOBAL_INSTRUCTION_FILES=("$CODEX_DIR/AGENTS.md" "$AGENTS_DIR/AGENTS.md")

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
NC='\033[0m'

ROUTING_BLOCK_START="<!-- BEGIN nhat-dev-toolkit:language-routing -->"
ROUTING_BLOCK_END="<!-- END nhat-dev-toolkit:language-routing -->"

info()  { echo -e "${GREEN}[+]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[x]${NC} $1" >&2; }

strip_managed_block() {
  local source_file="$1"
  local target_file="$2"

  awk -v start="$ROUTING_BLOCK_START" -v end="$ROUTING_BLOCK_END" '
    $0 == start { in_block = 1; next }
    $0 == end { in_block = 0; next }
    !in_block { print }
  ' "$source_file" > "$target_file"
}

upsert_managed_block() {
  local file="$1"
  local block="$2"
  local stripped_file
  local output_file

  mkdir -p "$(dirname "$file")"
  [[ -f "$file" ]] || touch "$file"

  stripped_file="$(mktemp)"
  output_file="$(mktemp)"

  strip_managed_block "$file" "$stripped_file"

  cat "$stripped_file" > "$output_file"
  if [[ -s "$output_file" ]]; then
    printf '\n' >> "$output_file"
  fi

  printf '%s\n' "$ROUTING_BLOCK_START" >> "$output_file"
  printf '%s\n' "$block" >> "$output_file"
  printf '%s\n' "$ROUTING_BLOCK_END" >> "$output_file"

  mv "$output_file" "$file"
  rm -f "$stripped_file"
}

remove_managed_block() {
  local file="$1"
  local stripped_file

  [[ -f "$file" ]] || return 0

  stripped_file="$(mktemp)"
  strip_managed_block "$file" "$stripped_file"
  mv "$stripped_file" "$file"
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

  for gf in "${GLOBAL_INSTRUCTION_FILES[@]}"; do
    remove_managed_block "$gf"
    info "Removed managed block: $gf"
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

# --- Language routing in both global instruction files ---
routing_block="$(cat <<EOF
## Code Priority (nhat-dev-toolkit)
- When choosing between approaches, optimize in this order: **readability → maintainability → correctness patterns → performance**. Prefer the obvious solution over the clever one. If a rule makes code harder to understand in context, note the tradeoff and choose readability.

## Global Language Rules (nhat-dev-toolkit)
- For any C#/.NET task (*.cs, *.csproj, *.sln, or dotnet commands), always load and follow $SRC_SKILLS_DIR/csharp-dotnet/SKILL.md.
- NUnit test method names must follow [Action]_When[Scenario]_Then[Expectation].
- For any TypeScript/React task (*.ts, *.tsx, package.json, npm/pnpm/yarn commands, React or Next.js files), always load and follow $SRC_SKILLS_DIR/typescript/SKILL.md.
- For React or Next.js implementation details, consult $SRC_SKILLS_DIR/typescript/references/react-next.md.
EOF
)"

for gf in "${GLOBAL_INSTRUCTION_FILES[@]}"; do
  upsert_managed_block "$gf" "$routing_block"
  info "Updated language routing: $gf"
done

echo ""
echo -e "${BOLD}Installation complete${NC}"
info "Installed: $installed"
[[ $skipped -gt 0 ]] && warn "Skipped:   $skipped (already installed)"
[[ $pruned -gt 0 ]] && warn "Pruned:    $pruned (retired skills removed)"
echo ""
echo "Skills installed at:"
for sd in "${SKILLS_DIRS[@]}"; do echo "  $sd"; done
