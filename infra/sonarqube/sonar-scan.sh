#!/usr/bin/env bash
# Full or diff SonarCloud/SonarQube scan for a project.
# Detects project type, runs scanner, writes report to .sonar/issues.md.
#
# Usage: sonar-scan.sh [--diff] [sonar-url] [sonar-token]
#   --diff       Scan only files changed vs base branch (git diff)
#   sonar-url    defaults to https://sonarcloud.io
#   sonar-token  defaults to $SONAR_TOKEN env var
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIFF_MODE=false

# Parse --diff flag
ARGS=()
for arg in "$@"; do
  if [ "$arg" = "--diff" ]; then DIFF_MODE=true; else ARGS+=("$arg"); fi
done

SONAR_URL="${ARGS[0]:-https://sonarcloud.io}"
SONAR_TOKEN="${ARGS[1]:-${SONAR_TOKEN:-}}"

# --- Token check ---
if [ -z "$SONAR_TOKEN" ]; then
  echo "ERROR: SONAR_TOKEN is not set. Add it to ~/.zshrc." >&2
  exit 1
fi

# --- Reachability check ---
if ! curl -sf --max-time 5 "${SONAR_URL}/api/system/status" -o /dev/null 2>/dev/null; then
  echo "ERROR: Cannot reach $SONAR_URL" >&2
  exit 1
fi

# --- Detect project key from sonar-project.properties or .sonarlint/*.json ---
detect_project_key() {
  if [ -f "sonar-project.properties" ]; then
    grep -E '^sonar\.projectKey=' sonar-project.properties | cut -d= -f2- | tr -d '[:space:]'
    return
  fi
  local json
  json=$(ls .sonarlint/*.json 2>/dev/null | head -1)
  if [ -n "$json" ]; then
    grep -o '"projectKey"[[:space:]]*:[[:space:]]*"[^"]*"' "$json" | grep -o '"[^"]*"$' | tr -d '"'
    return
  fi
  echo ""
}

PROJECT_KEY=$(detect_project_key)

if [ -z "$PROJECT_KEY" ]; then
  echo "ERROR: No sonar-project.properties or .sonarlint/*.json found in $(pwd)" >&2
  echo "" >&2
  echo "Create sonar-project.properties from a template:" >&2
  echo "  .NET:     $SCRIPT_DIR/templates/sonar-project.dotnet.properties" >&2
  echo "  Frontend: $SCRIPT_DIR/templates/sonar-project.frontend.properties" >&2
  exit 1
fi

# --- Build PR/branch analysis args for diff mode ---
EXTRA_ARGS_DOTNET=()
EXTRA_ARGS_FRONTEND=()

if [ "$DIFF_MODE" = true ]; then
  CURRENT_BRANCH=$(git branch --show-current 2>/dev/null || echo "")
  BASE_BRANCH=$(git remote show origin 2>/dev/null | grep 'HEAD branch' | awk '{print $NF}' || echo "main")

  if [ -z "$CURRENT_BRANCH" ] || [ "$CURRENT_BRANCH" = "$BASE_BRANCH" ]; then
    echo "ERROR: --diff requires a feature branch checked out (not on $BASE_BRANCH)." >&2
    exit 1
  fi

  # Detect remote platform from origin URL
  REMOTE_URL=$(git remote get-url origin 2>/dev/null || echo "")
  PR_KEY=""

  if echo "$REMOTE_URL" | grep -qi "github\.com"; then
    # GitHub — use gh CLI
    PR_KEY=$(gh pr view --json number -q '.number' 2>/dev/null || echo "")
    PLATFORM="github"
  elif echo "$REMOTE_URL" | grep -qiE "dev\.azure\.com|visualstudio\.com"; then
    # Azure DevOps — use az CLI
    PR_KEY=$(az repos pr list \
      --source-branch "$CURRENT_BRANCH" \
      --target-branch "$BASE_BRANCH" \
      --status active \
      --query "[0].pullRequestId" \
      -o tsv 2>/dev/null || echo "")
    PLATFORM="azure"
  else
    PLATFORM="unknown"
  fi

  if [ -n "$PR_KEY" ]; then
    echo "Diff mode: PR #${PR_KEY} · ${CURRENT_BRANCH} → ${BASE_BRANCH} [${PLATFORM}]"
    EXTRA_ARGS_DOTNET=(
      /d:sonar.pullrequest.key="$PR_KEY"
      /d:sonar.pullrequest.branch="$CURRENT_BRANCH"
      /d:sonar.pullrequest.base="$BASE_BRANCH"
    )
    EXTRA_ARGS_FRONTEND=(
      "-Dsonar.pullrequest.key=$PR_KEY"
      "-Dsonar.pullrequest.branch=$CURRENT_BRANCH"
      "-Dsonar.pullrequest.base=$BASE_BRANCH"
    )
  else
    # No PR yet (or CLI not available) — branch analysis
    echo "Diff mode: branch analysis · ${CURRENT_BRANCH} (no open PR on ${PLATFORM:-unknown})"
    EXTRA_ARGS_DOTNET=(/d:sonar.branch.name="$CURRENT_BRANCH")
    EXTRA_ARGS_FRONTEND=("-Dsonar.branch.name=$CURRENT_BRANCH")
  fi
  echo ""
fi

# --- Detect project type and run scanner ---
IS_DOTNET=false
IS_FRONTEND=false
find . -maxdepth 3 \( -name "*.sln" -o -name "*.csproj" \) 2>/dev/null | grep -qE '\.(sln|csproj)$' && IS_DOTNET=true
find . -maxdepth 2 \( -name "package.json" -o -name "tsconfig.json" \) 2>/dev/null | grep -q . && IS_FRONTEND=true

if [ "$IS_DOTNET" = true ]; then
  export SONAR_EXTRA_ARGS="${EXTRA_ARGS_DOTNET[*]:-}"
  "$SCRIPT_DIR/scan-dotnet.sh" "$PROJECT_KEY" "$SONAR_URL" "$SONAR_TOKEN"
elif [ "$IS_FRONTEND" = true ]; then
  export SONAR_EXTRA_ARGS="${EXTRA_ARGS_FRONTEND[*]:-}"
  "$SCRIPT_DIR/scan-frontend.sh" "$PROJECT_KEY" "$SONAR_URL" "$SONAR_TOKEN"
else
  echo "ERROR: Could not detect .NET or frontend project in $(pwd)" >&2
  exit 1
fi

# fetch-results.sh (called by scanner) writes .sonar/raw.json and .sonar/issues.md