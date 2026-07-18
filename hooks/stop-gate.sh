#!/usr/bin/env bash
# Stop-gate: block the agent from stopping while an active work plan has
# unchecked tasks, or while a project verify script fails.
#
# Gate activates ONLY when an active gate exists in the project:
#   .pair/plan.md   (requires a live .pair/active-loop.json owner)
#   .claude-loop.md (generic loop state file)
# Normal conversational sessions (no gate file) are never blocked.
#
# Progress-aware iteration cap: consecutive blocks WITHOUT progress
# (unchecked count not decreasing) are capped at CLAUDE_STOP_GATE_MAX
# (default 5) to prevent infinite loops on genuinely stuck work.
#
# Opt-out: PAIR_STOP_GATE=off (legacy: CLAUDE_STOP_GATE=off)
set -uo pipefail

# Both Codex and Claude send JSON on stdin. Codex uses cwd; Claude commonly
# provides CLAUDE_PROJECT_DIR in the environment.
hook_input=$(cat)

[[ "${PAIR_STOP_GATE:-on}" == "off" || "${CLAUDE_STOP_GATE:-on}" == "off" ]] && exit 0

hook_cwd=""
if command -v jq > /dev/null 2>&1 && [[ -n "$hook_input" ]]; then
  hook_cwd=$(printf '%s' "$hook_input" | jq -r '.cwd // .project_dir // empty' 2> /dev/null || true)
fi
proj="${CLAUDE_PROJECT_DIR:-${hook_cwd:-$PWD}}"

# pair-loop owns this file. Block a stop only while the attempt's owning pair-loop
# process is still alive. active-attempt.json carries no pid of its own, so use the
# sibling active-loop.json owner as the liveness proxy. An orphaned active-attempt.json
# (loop crashed/killed/reset) must NOT trap the session — the next pair-loop run
# reconciles it from the ledger.
active_attempt="$proj/.pair/active-attempt.json"
if [[ -f "$active_attempt" ]]; then
  command -v jq > /dev/null 2>&1 || exit 0
  active_loop="$proj/.pair/active-loop.json"
  owner_pid=""
  if [[ -f "$active_loop" && ! -L "$active_loop" ]]; then
    owner_pid=$(jq -r '.pid // empty' "$active_loop" 2> /dev/null || true)
  fi
  if [[ "$owner_pid" =~ ^[1-9][0-9]*$ ]] && kill -0 "$owner_pid" 2> /dev/null; then
    task=$(jq -r '.taskId // "unknown"' "$active_attempt" 2> /dev/null || echo unknown)
    jq -n --arg r "Pair attempt for task $task is still active. Resume pair-loop or classify/recover the attempt before stopping." '{decision: "block", reason: $r}'
    exit 0
  fi
fi

gate=""
for candidate in "$proj/.pair/plan.md" "$proj/.claude-loop.md"; do
  if [[ -f "$candidate" ]]; then
    gate="$candidate"
    break
  fi
done
[[ -z "$gate" ]] && exit 0

command -v jq > /dev/null 2>&1 || exit 0 # cannot emit valid JSON without jq

run_id="claude-loop"
if [[ "$gate" == "$proj/.pair/plan.md" ]]; then
  active_loop="$proj/.pair/active-loop.json"
  if [[ ! -f "$active_loop" || -L "$active_loop" ]]; then
    exit 0
  fi
  marker_schema=$(jq -r '.schema // empty' "$active_loop" 2> /dev/null || true)
  marker_pid=$(jq -r '.pid // empty' "$active_loop" 2> /dev/null || true)
  marker_plan=$(jq -r '.plan // empty' "$active_loop" 2> /dev/null || true)
  run_id=$(jq -r '.run_id // empty' "$active_loop" 2> /dev/null || true)
  if [[ "$marker_schema" != "1" || ! "$marker_pid" =~ ^[1-9][0-9]*$ \
    || "$marker_plan" != ".pair/plan.md" || ! "$run_id" =~ ^[A-Za-z0-9._-]{1,128}$ ]] \
    || ! kill -0 "$marker_pid" 2> /dev/null; then
    rm -f "$active_loop"
    exit 0
  fi
fi

# State lives in the scratch dir (keyed by gate path) so gates never litter
# project roots with untracked state files.
state_dir="${CLAUDE_SCRATCH_DIR:-$HOME/.claude-scratch}/stop-gate"
mkdir -p "$state_dir"
state_file="$state_dir/$(printf '%s' "$gate" | shasum | cut -c1-16)"

block() {
  local reason="$1"
  jq -n --arg r "$reason" '{decision: "block", reason: $r}'
  exit 0
}

# --- Task checkboxes ---------------------------------------------------------
unchecked=$(grep -cE '^[[:space:]]*[-*] \[ \]' "$gate" 2> /dev/null || true)
unchecked=${unchecked:-0}

# --- Optional verify script --------------------------------------------------
run_verify() {
  local verify="$proj/.pair/verify.sh"
  [[ -x "$verify" ]] || return 0
  local timeout_cmd=""
  if command -v gtimeout > /dev/null 2>&1; then
    timeout_cmd="gtimeout 120"
  elif command -v timeout > /dev/null 2>&1; then
    timeout_cmd="timeout 120"
  fi
  local out
  if ! out=$($timeout_cmd "$verify" 2>&1); then
    printf '%s' "$out" | tail -c 800
    return 1
  fi
  return 0
}

if [[ "$unchecked" -eq 0 ]]; then
  verify_out=$(run_verify) || {
    block "Stop gate: all tasks in $(basename "$gate") are checked, but $proj/.pair/verify.sh FAILED. Fix the failure before finishing. Verify output (tail): $verify_out"
  }
  rm -f "$state_file"
  exit 0
fi

# --- Progress-aware iteration cap -------------------------------------------
prev_run_id=""
prev_iter=0
prev_unchecked=""
prev_exhausted=0
if [[ -f "$state_file" ]]; then
  read -r prev_run_id prev_iter prev_unchecked prev_exhausted < "$state_file" || true
fi

if [[ "$prev_run_id" != "$run_id" || -z "$prev_unchecked" || "$unchecked" != "$prev_unchecked" ]]; then
  iter=1
  exhausted=0
elif [[ "$prev_exhausted" == "1" ]]; then
  exit 0
else
  iter=$((prev_iter + 1))
  exhausted=0
fi

max="${PAIR_STOP_GATE_MAX:-${CLAUDE_STOP_GATE_MAX:-5}}"
if [[ "$iter" -gt "$max" ]]; then
  printf '%s %s %s 1\n' "$run_id" "$max" "$unchecked" > "$state_file"
  echo "stop-gate: $unchecked task(s) still unchecked in $gate but no progress after $max attempts — allowing stop" >&2
  exit 0
fi

printf '%s %s %s %s\n' "$run_id" "$iter" "$unchecked" "$exhausted" > "$state_file"

next_tasks=$(grep -E '^[[:space:]]*[-*] \[ \]' "$gate" | head -3 | sed 's/^[[:space:]]*//')
block "Stop gate ($iter/$max): $unchecked unchecked task(s) remain in $(basename "$gate"). Next: $next_tasks — Continue with the next unchecked task and mark finished tasks [x]. If a task is genuinely blocked, write a blocker note under it in the plan file and ask the user."
