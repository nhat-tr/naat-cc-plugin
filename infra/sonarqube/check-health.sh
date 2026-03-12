#!/usr/bin/env bash
# Check SonarCloud or SonarQube reachability.
# Exits 0 and prints JSON status if reachable, exits 1 with message if not.
#
# Usage: check-health.sh [sonar-url]
#   sonar-url defaults to https://sonarcloud.io

SONAR_URL="${1:-https://sonarcloud.io}"

if curl -sf --max-time 5 "${SONAR_URL}/api/system/status" 2>/dev/null; then
  echo ""
  echo "SonarCloud reachable: $SONAR_URL"
  exit 0
elif curl -sf --max-time 5 "${SONAR_URL}/api/system/health" 2>/dev/null; then
  echo ""
  echo "SonarQube reachable: $SONAR_URL"
  exit 0
else
  echo "ERROR: Cannot reach $SONAR_URL" >&2
  exit 1
fi