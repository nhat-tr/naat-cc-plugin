#!/usr/bin/env bash
# validate-plan.sh — preflight check that .pair/plan.md is an implementable
# PLAN, not a sketch or a spec. Refusing here turns the old "implement stalls
# silently on a spec" failure into an actionable error.
#
# Usage: validate-plan.sh [plan-path]   (default: <git-root>/.pair/plan.md)
# Exit 0 = implementable; exit 1 = not a plan (reasons on stdout).
set -uo pipefail

plan="${1:-}"
if [[ -z "$plan" ]]; then
  root=$(git rev-parse --show-toplevel 2> /dev/null) || root="$PWD"
  plan="$root/.pair/plan.md"
fi

fail=0
say() { echo "  ✗ $1"; fail=1; }

if [[ ! -f "$plan" ]]; then
  echo "validate-plan: $plan does not exist"
  echo "  ✗ no plan file — run /pair-promote (from a spec) or /pair-plan first"
  exit 1
fi

if grep -qiE 'plan-phase:[[:space:]]*sketch|<!--[[:space:]]*sketch' "$plan"; then
  say "still a SKETCH (sketch marker present) — run /pair-plan to expand, or /pair-promote"
fi

tasks_total=$(grep -cE '^[[:space:]]*[-*] \[[ x]\]' "$plan" || true)
tasks_open=$(grep -cE '^[[:space:]]*[-*] \[ \]' "$plan" || true)
if [[ "${tasks_total:-0}" -eq 0 ]]; then
  say "no task checkboxes ('- [ ] ...') — this is a spec/notes, not an implementable plan; run /pair-promote"
fi

if ! grep -qE '^##+ Implementation Context' "$plan"; then
  say "missing '## Implementation Context' section (implementer runs without the planning conversation)"
fi

# TDD enforcement: tests are scheduled BEFORE implementation, and integration
# tests are mandatory — a plan without them is not implementable here.
if [[ "${tasks_total:-0}" -gt 0 ]]; then
  test_tasks=$(grep -cE '^[[:space:]]*[-*] \[[ x]\].*[Tt]est' "$plan" || true)
  if [[ "${test_tasks:-0}" -eq 0 ]]; then
    say "no test tasks at all — TDD is mandatory: every stream starts with a failing-test task"
  fi

  if ! grep -qiE '^[[:space:]]*[-*] \[[ x]\].*integration[- ]test' "$plan"; then
    say "no integration-test task — an integration test covering the acceptance criteria is mandatory"
  fi

  # Within each stream, the FIRST task must be a test task (tests-first ordering).
  bad_streams=$(awk '
    /^###[[:space:]]+Stream/ { stream = $0; want = 1; next }
    want && /^[[:space:]]*[-*] \[[ x]\]/ {
      if ($0 !~ /[Tt]est/) { sub(/^###[[:space:]]*/, "", stream); print stream }
      want = 0
    }
  ' "$plan")
  if [[ -n "$bad_streams" ]]; then
    while IFS= read -r s; do
      say "stream does not start with a test task (TDD order): $s"
    done <<< "$bad_streams"
  fi
fi

# Warning only: tasks should name the files they touch.
if [[ "${tasks_total:-0}" -gt 0 ]]; then
  tasks_with_files=$(grep -EA1 '^[[:space:]]*[-*] \[ \]' "$plan" | grep -c '`[^`]*/[^`]*`' || true)
  if [[ "${tasks_with_files:-0}" -eq 0 && "${tasks_open:-0}" -gt 0 ]]; then
    echo "  ⚠ no open task references a file path in backticks — implementer will have to rediscover targets"
  fi
fi

if [[ "$fail" -eq 0 ]]; then
  echo "validate-plan: OK — $tasks_open open / $tasks_total total task(s) in $plan"
  exit 0
fi
echo "validate-plan: NOT implementable ($plan)"
exit 1
