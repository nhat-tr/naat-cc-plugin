#!/usr/bin/env bash
# Shared utility: poll SonarQube for analysis results and quality gate status.
# Called by scan-dotnet.sh and scan-frontend.sh after scanner completes.
#
# Usage: ./fetch-results.sh <project-key> [sonar-url] [sonar-token]
set -euo pipefail

PROJECT_KEY="${1:?Usage: fetch-results.sh <project-key> [sonar-url] [sonar-token]}"
SONAR_URL="${2:-http://localhost:9000}"
SONAR_TOKEN="${3:-}"

# Build auth header
AUTH_HEADER=""
if [ -n "$SONAR_TOKEN" ]; then
  AUTH_HEADER="-u $SONAR_TOKEN:"
fi

api_get() {
  local endpoint="$1"
  # shellcheck disable=SC2086
  curl -sf $AUTH_HEADER "$SONAR_URL/$endpoint"
}

# Wait for the most recent analysis task to complete
wait_for_analysis() {
  local timeout=120
  local interval=5
  local elapsed=0

  echo "Waiting for SonarQube analysis to complete..."

  while [ $elapsed -lt $timeout ]; do
    local ce_status
    ce_status=$(api_get "api/ce/component?component=$PROJECT_KEY" 2>/dev/null || echo "")

    if [ -z "$ce_status" ]; then
      sleep $interval
      elapsed=$((elapsed + interval))
      continue
    fi

    # Check if there are pending/in-progress tasks
    local queue_count
    queue_count=$(echo "$ce_status" | grep -o '"queue":\[[^]]*\]' | grep -c '"status"' 2>/dev/null || echo "0")

    local current_status
    current_status=$(echo "$ce_status" | grep -o '"current":{[^}]*}' | grep -o '"status":"[^"]*"' | cut -d'"' -f4 2>/dev/null || echo "")

    if [ "$queue_count" = "0" ] && [ "$current_status" != "PENDING" ] && [ "$current_status" != "IN_PROGRESS" ]; then
      echo "Analysis complete."
      return 0
    fi

    sleep $interval
    elapsed=$((elapsed + interval))
    echo "  Analysis in progress... (${elapsed}s / ${timeout}s)"
  done

  echo "WARNING: Analysis did not complete within ${timeout}s. Fetching latest available results."
}

# Fetch quality gate status
fetch_quality_gate() {
  echo ""
  echo "QUALITY GATE"
  echo "════════════"

  local gate_result
  gate_result=$(api_get "api/qualitygates/project_status?projectKey=$PROJECT_KEY" 2>/dev/null || echo "")

  if [ -z "$gate_result" ]; then
    echo "  Status: UNKNOWN (could not fetch quality gate)"
    return 1
  fi

  local gate_status
  gate_status=$(echo "$gate_result" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)

  echo "  Status: $gate_status"

  # Parse conditions
  echo ""
  echo "  Conditions:"

  # Extract condition statuses using simple parsing
  local conditions
  conditions=$(echo "$gate_result" | grep -o '"metric":"[^"]*","comparator":"[^"]*","periodIndex":[0-9]*,"status":"[^"]*","errorThreshold":"[^"]*"' 2>/dev/null || \
               echo "$gate_result" | grep -o '"metric":"[^"]*"[^}]*"status":"[^"]*"' 2>/dev/null || echo "")

  if [ -n "$conditions" ]; then
    echo "$conditions" | while IFS= read -r cond; do
      local metric status
      metric=$(echo "$cond" | grep -o '"metric":"[^"]*"' | cut -d'"' -f4)
      status=$(echo "$cond" | grep -o '"status":"[^"]*"' | cut -d'"' -f4)
      printf "    %-40s %s\n" "$metric" "$status"
    done
  fi

  echo ""

  if [ "$gate_status" = "OK" ]; then
    return 0
  else
    return 1
  fi
}

# Fetch issues summary
fetch_issues() {
  echo "ISSUES SUMMARY"
  echo "══════════════"

  local severities=("BLOCKER" "CRITICAL" "MAJOR" "MINOR" "INFO")
  local total=0

  for severity in "${severities[@]}"; do
    local result
    result=$(api_get "api/issues/search?projectKeys=$PROJECT_KEY&severities=$severity&resolved=false&ps=1" 2>/dev/null || echo "")
    local count
    count=$(echo "$result" | grep -o '"total":[0-9]*' | cut -d: -f2 2>/dev/null || echo "0")
    [ -z "$count" ] && count=0
    total=$((total + count))
    printf "  %-12s %s\n" "$severity" "$count"
  done

  echo "  ────────────────"
  printf "  %-12s %s\n" "TOTAL" "$total"

  # Fetch by type
  echo ""
  echo "  By Type:"

  local types=("BUG" "VULNERABILITY" "CODE_SMELL" "SECURITY_HOTSPOT")
  for type in "${types[@]}"; do
    local result
    result=$(api_get "api/issues/search?projectKeys=$PROJECT_KEY&types=$type&resolved=false&ps=1" 2>/dev/null || echo "")
    local count
    count=$(echo "$result" | grep -o '"total":[0-9]*' | cut -d: -f2 2>/dev/null || echo "0")
    [ -z "$count" ] && count=0
    printf "    %-20s %s\n" "$type" "$count"
  done

  echo ""
}

# Main
wait_for_analysis
fetch_issues
gate_exit=0
fetch_quality_gate || gate_exit=$?

# Fetch all issues and write formatted report to .sonar/
mkdir -p .sonar
RAW_FILE=".sonar/raw.json"
REPORT_FILE=".sonar/issues.md"

curl -sf $AUTH_HEADER \
  "$SONAR_URL/api/issues/search?projectKeys=$PROJECT_KEY&resolved=false&ps=500" \
  -o "$RAW_FILE" 2>/dev/null || echo '{"issues":[],"total":0}' > "$RAW_FILE"

python3 - "$RAW_FILE" "$REPORT_FILE" "$PROJECT_KEY" << 'PYEOF'
import json, sys
from datetime import datetime, timezone
from collections import defaultdict

raw_file, report_file, project_key = sys.argv[1], sys.argv[2], sys.argv[3]
with open(raw_file) as f:
    data = json.load(f)

# Traditional severity → normalised level (BLOCKER/CRITICAL=HIGH, MAJOR=MEDIUM, MINOR/INFO=LOW)
TRAD_MAP = {"BLOCKER": "HIGH", "CRITICAL": "HIGH", "MAJOR": "MEDIUM", "MINOR": "LOW", "INFO": "LOW"}
SEV_ORDER  = {"HIGH": 0, "MEDIUM": 1}   # LOW filtered out
QUAL_ORDER = {"SECURITY": 0, "RELIABILITY": 1, "MAINTAINABILITY": 2}

def resolve_severity(issue):
    """Return (normalised_severity, quality) or None if LOW/filtered."""
    # Modern: use highest-severity impact
    best_sev, best_qual = None, None
    for imp in issue.get("impacts", []):
        s = imp["severity"]
        if s not in SEV_ORDER: continue
        if best_sev is None or SEV_ORDER[s] < SEV_ORDER[best_sev]:
            best_sev, best_qual = s, imp["softwareQuality"]
    if best_sev:
        return best_sev, best_qual

    # Fallback: traditional severity field
    trad = TRAD_MAP.get(issue.get("severity", ""), "LOW")
    if trad not in SEV_ORDER:
        return None
    qual = issue.get("type", "CODE_SMELL").replace("_", " ").title()
    return trad, qual

def strip_component(c):
    return c.split(":", 1)[-1] if ":" in c else c

groups = defaultdict(lambda: defaultdict(list))
for issue in data.get("issues", []):
    resolved = resolve_severity(issue)
    if resolved:
        groups[resolved[0]][resolved[1]].append(issue)

total = data.get("total", 0)
counts = {s: sum(len(v) for v in groups[s].values()) for s in SEV_ORDER}
actionable = sum(counts.values())
project_name = project_key.split("_", 1)[-1] if "_" in project_key else project_key

out = []
out.append(f"# Sonar Report · {project_name}")
out.append(f"_{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')} · "
           f"{actionable} actionable of {total} total "
           f"({counts.get('HIGH',0)} high · {counts.get('MEDIUM',0)} medium)_\n")

if actionable == 0:
    out.append("✅ No actionable issues (all LOW/INFO).")
else:
    for sev in ["HIGH", "MEDIUM"]:
        if sev not in groups: continue
        out.append(f"## {sev} ({counts[sev]})\n")
        for qual in sorted(groups[sev], key=lambda q: QUAL_ORDER.get(q, 99)):
            issues = sorted(groups[sev][qual], key=lambda i: strip_component(i["component"]))
            out.append(f"### {qual} ({len(issues)})\n")
            for i in issues:
                path = strip_component(i["component"])
                line = i.get("line") or i.get("textRange", {}).get("startLine", "?")
                rule = i.get("rule", "").split(":")[-1]
                out.append(f"- **{path}:{line}** `{rule}`  \n  {i['message']}")
            out.append("")

with open(report_file, "w") as f:
    f.write("\n".join(out) + "\n")

print(f"  {actionable} actionable ({counts.get('HIGH',0)} high · {counts.get('MEDIUM',0)} medium) of {total} total")
PYEOF

echo ""
echo "Report: $(pwd)/$REPORT_FILE"

exit $gate_exit
