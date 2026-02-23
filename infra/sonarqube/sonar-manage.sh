#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"
SONAR_URL="http://localhost:9000"

usage() {
  cat <<EOF
Usage: $(basename "$0") <command>

Commands:
  up      Start SonarQube and PostgreSQL
  down    Stop SonarQube and PostgreSQL
  status  Check if SonarQube is running and healthy
  wait    Block until SonarQube API responds healthy (timeout: 180s)
  logs    Tail SonarQube logs
EOF
  exit 1
}

cmd_up() {
  echo "Starting SonarQube..."
  docker compose -f "$COMPOSE_FILE" up -d
  echo "SonarQube starting at $SONAR_URL"
  echo "First startup takes 1-2 minutes. Run '$(basename "$0") wait' to block until ready."
}

cmd_down() {
  echo "Stopping SonarQube..."
  docker compose -f "$COMPOSE_FILE" down
  echo "SonarQube stopped."
}

cmd_status() {
  if ! docker compose -f "$COMPOSE_FILE" ps --status running 2>/dev/null | grep -q sonarqube; then
    echo "SonarQube is not running."
    echo "Start with: $(basename "$0") up"
    return 1
  fi

  local health
  health=$(curl -sf "$SONAR_URL/api/system/health" 2>/dev/null || echo '{"health":"UNREACHABLE"}')
  local status
  status=$(echo "$health" | grep -o '"health":"[^"]*"' | cut -d'"' -f4)

  if [ "$status" = "GREEN" ]; then
    echo "SonarQube is running and healthy."
    echo "URL: $SONAR_URL"
  elif [ "$status" = "UNREACHABLE" ]; then
    echo "SonarQube container is running but API is not yet responding."
    echo "It may still be starting up. Run '$(basename "$0") wait' to block until ready."
    return 1
  else
    echo "SonarQube is running but health status: $status"
    echo "URL: $SONAR_URL"
    return 1
  fi
}

cmd_wait() {
  local timeout=180
  local interval=5
  local elapsed=0

  echo "Waiting for SonarQube to become healthy (timeout: ${timeout}s)..."

  while [ $elapsed -lt $timeout ]; do
    local health
    health=$(curl -sf "$SONAR_URL/api/system/health" 2>/dev/null || echo '{"health":"WAITING"}')
    local status
    status=$(echo "$health" | grep -o '"health":"[^"]*"' | cut -d'"' -f4)

    if [ "$status" = "GREEN" ]; then
      echo "SonarQube is ready at $SONAR_URL"
      return 0
    fi

    sleep $interval
    elapsed=$((elapsed + interval))
    echo "  Still waiting... (${elapsed}s / ${timeout}s)"
  done

  echo "ERROR: SonarQube did not become healthy within ${timeout}s"
  return 1
}

cmd_logs() {
  docker compose -f "$COMPOSE_FILE" logs -f sonarqube
}

[ $# -lt 1 ] && usage

case "$1" in
  up)     cmd_up ;;
  down)   cmd_down ;;
  status) cmd_status ;;
  wait)   cmd_wait ;;
  logs)   cmd_logs ;;
  *)      usage ;;
esac
