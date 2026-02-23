#!/usr/bin/env bash
# .NET scanner wrapper for SonarQube.
# Runs dotnet-sonarscanner begin → dotnet build → dotnet-sonarscanner end.
#
# Usage: ./scan-dotnet.sh [project-key] [sonar-url] [sonar-token]
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

# Ensure dotnet-sonarscanner is installed
if ! dotnet tool list -g 2>/dev/null | grep -q dotnet-sonarscanner; then
  echo "Installing dotnet-sonarscanner global tool..."
  dotnet tool install --global dotnet-sonarscanner
fi

# Build scanner args
SCANNER_ARGS=(
  /k:"$PROJECT_KEY"
  /d:sonar.host.url="$SONAR_URL"
)

if [ -n "$SONAR_TOKEN" ]; then
  SCANNER_ARGS+=(/d:sonar.token="$SONAR_TOKEN")
fi

# Read additional properties from sonar-project.properties if present
if [ -f "sonar-project.properties" ]; then
  while IFS='=' read -r key value; do
    # Skip comments and empty lines
    [[ "$key" =~ ^[[:space:]]*# ]] && continue
    [[ -z "$key" ]] && continue
    # Skip projectKey (already set) and host.url (already set)
    [[ "$key" =~ sonar\.projectKey ]] && continue
    [[ "$key" =~ sonar\.host\.url ]] && continue
    key=$(echo "$key" | tr -d '[:space:]')
    value=$(echo "$value" | sed 's/^[[:space:]]*//')
    [ -n "$key" ] && [ -n "$value" ] && SCANNER_ARGS+=(/d:"$key=$value")
  done < sonar-project.properties
fi

echo "═══════════════════════════════════════"
echo "SonarQube .NET Scanner"
echo "═══════════════════════════════════════"
echo "Project:  $PROJECT_KEY"
echo "Server:   $SONAR_URL"
echo ""

# Begin analysis
echo "▸ Starting SonarScanner..."
dotnet sonarscanner begin "${SCANNER_ARGS[@]}"

# Build
echo ""
echo "▸ Building project..."
dotnet build --no-incremental 2>&1 | tail -20

# End analysis (sends results to SonarQube)
echo ""
echo "▸ Completing analysis..."
dotnet sonarscanner end ${SONAR_TOKEN:+/d:sonar.token="$SONAR_TOKEN"}

# Fetch results
echo ""
"$SCRIPT_DIR/fetch-results.sh" "$PROJECT_KEY" "$SONAR_URL" "$SONAR_TOKEN"
