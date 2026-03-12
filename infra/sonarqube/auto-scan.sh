#!/usr/bin/env bash
# Auto-triggered SonarCloud scan — called by Claude Code Stop hook.
# Reads config from sonar-project.properties or .sonarlint/*.json.
# Silently skips if token is missing, service is unreachable, or no config found.
# Runs scanner in the background; logs to /tmp/sonar-auto-scan.log.
#
# Environment variables:
#   SONAR_TOKEN      Required. SonarCloud user token.
#   SONAR_URL        Optional. Defaults to https://sonarcloud.io

SONAR_URL="${SONAR_URL:-https://sonarcloud.io}"
SONAR_TOKEN="${SONAR_TOKEN:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_FILE="/tmp/sonar-auto-scan.log"
TEMP_PROPS=""

# 1. Token is required
if [ -z "$SONAR_TOKEN" ]; then
  exit 0
fi

# 2. Resolve config — prefer sonar-project.properties, fall back to .sonarlint/*.json
if [ -f "sonar-project.properties" ]; then
  : # use as-is
elif [ -d ".sonarlint" ]; then
  SONARLINT_JSON=$(ls .sonarlint/*.json 2>/dev/null | head -1)
  if [ -z "$SONARLINT_JSON" ]; then
    exit 0
  fi

  # Parse JSON with sed/grep (no jq dependency)
  PROJECT_KEY=$(grep -o '"projectKey"[[:space:]]*:[[:space:]]*"[^"]*"' "$SONARLINT_JSON" | grep -o '"[^"]*"$' | tr -d '"')
  ORG=$(grep -o '"sonarCloudOrganization"[[:space:]]*:[[:space:]]*"[^"]*"' "$SONARLINT_JSON" | grep -o '"[^"]*"$' | tr -d '"')
  REGION=$(grep -o '"region"[[:space:]]*:[[:space:]]*"[^"]*"' "$SONARLINT_JSON" | grep -o '"[^"]*"$' | tr -d '"' | tr '[:upper:]' '[:lower:]')

  if [ -z "$PROJECT_KEY" ] || [ -z "$ORG" ]; then
    exit 0
  fi

  # Generate a temporary sonar-project.properties
  TEMP_PROPS="$(pwd)/sonar-project.properties"
  {
    echo "sonar.projectKey=$PROJECT_KEY"
    echo "sonar.organization=$ORG"
    [ -n "$REGION" ] && echo "sonar.region=$REGION"
    echo "sonar.sourceEncoding=UTF-8"
    echo "sonar.exclusions=**/bin/**,**/obj/**,**/Migrations/**,**/node_modules/**,**/dist/**"
  } > "$TEMP_PROPS"
else
  exit 0
fi

# 3. Service reachability check
if ! curl -sf --max-time 3 "${SONAR_URL}/api/system/status" -o /dev/null 2>/dev/null; then
  [ -n "$TEMP_PROPS" ] && rm -f "$TEMP_PROPS"
  exit 0
fi

# 4. Detect project type
if find . -maxdepth 3 \( -name "*.sln" -o -name "*.csproj" \) 2>/dev/null | grep -qE '\.(sln|csproj)$'; then
  SCANNER="$SCRIPT_DIR/scan-dotnet.sh"
elif [ -f "package.json" ] || [ -f "tsconfig.json" ]; then
  SCANNER="$SCRIPT_DIR/scan-frontend.sh"
else
  SCANNER="$SCRIPT_DIR/scan-frontend.sh"
fi

# 5. Launch scan in background, clean up temp file after
{
  echo "=== SonarCloud auto-scan: $(date) ==="
  echo "Project dir: $(pwd)"
  echo "Server:      $SONAR_URL"
  echo "Scanner:     $SCANNER"
  [ -n "$TEMP_PROPS" ] && echo "Config:      generated from .sonarlint JSON"
  echo ""
  bash "$SCANNER" "" "$SONAR_URL" "$SONAR_TOKEN"
  echo ""
  echo "=== Done: $(date) ==="
  [ -n "$TEMP_PROPS" ] && rm -f "$TEMP_PROPS"
} > "$LOG_FILE" 2>&1 &

echo "SonarCloud scan started in background. Logs: $LOG_FILE"