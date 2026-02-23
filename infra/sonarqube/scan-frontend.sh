#!/usr/bin/env bash
# JS/TS scanner wrapper for SonarQube.
# Runs sonar-scanner with config from sonar-project.properties or CLI args.
#
# Usage: ./scan-frontend.sh [project-key] [sonar-url] [sonar-token]
#
# project-key: defaults to value from sonar-project.properties or directory name
# sonar-url:   defaults to http://localhost:9000
# sonar-token: defaults to empty (anonymous, works with default SonarQube setup)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SONAR_URL="${2:-http://localhost:9000}"
SONAR_TOKEN="${3:-}"

# Detect project key
detect_project_key() {
  local explicit_key="${1:-}"
  if [ -n "$explicit_key" ]; then
    echo "$explicit_key"
    return
  fi

  # Try sonar-project.properties
  if [ -f "sonar-project.properties" ]; then
    local key
    key=$(grep -E '^sonar\.projectKey=' sonar-project.properties | cut -d= -f2- | tr -d '[:space:]')
    if [ -n "$key" ]; then
      echo "$key"
      return
    fi
  fi

  # Fallback to directory name
  basename "$(pwd)"
}

PROJECT_KEY=$(detect_project_key "${1:-}")

# Ensure sonar-scanner is available
if ! command -v sonar-scanner &>/dev/null; then
  # Check for npx availability
  if command -v npx &>/dev/null; then
    echo "sonar-scanner not found. Using npx sonar-scanner..."
    SONAR_SCANNER="npx sonar-scanner"
  else
    echo "ERROR: sonar-scanner not found and npx not available."
    echo "Install with: npm install -g sonar-scanner"
    exit 1
  fi
else
  SONAR_SCANNER="sonar-scanner"
fi

# Build scanner args
SCANNER_ARGS=(
  "-Dsonar.projectKey=$PROJECT_KEY"
  "-Dsonar.host.url=$SONAR_URL"
)

if [ -n "$SONAR_TOKEN" ]; then
  SCANNER_ARGS+=("-Dsonar.token=$SONAR_TOKEN")
fi

# If no sonar-project.properties, set sensible defaults
if [ ! -f "sonar-project.properties" ]; then
  SCANNER_ARGS+=(
    "-Dsonar.sources=src"
    "-Dsonar.exclusions=**/node_modules/**,**/dist/**,**/build/**,**/coverage/**"
    "-Dsonar.sourceEncoding=UTF-8"
  )
fi

echo "═══════════════════════════════════════"
echo "SonarQube Frontend Scanner"
echo "═══════════════════════════════════════"
echo "Project:  $PROJECT_KEY"
echo "Server:   $SONAR_URL"
echo ""

# Run scanner
echo "▸ Running sonar-scanner..."
# shellcheck disable=SC2086
$SONAR_SCANNER "${SCANNER_ARGS[@]}"

# Fetch results
echo ""
"$SCRIPT_DIR/fetch-results.sh" "$PROJECT_KEY" "$SONAR_URL" "$SONAR_TOKEN"
