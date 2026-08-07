#!/usr/bin/env bash
# format-changed — PostToolUse[Edit|Write|MultiEdit] hook.
#
# Runs the project's formatter on the ONE file that was just written:
#   .cs                        -> format-range.mjs (csharpier, changed lines only)
#   .ts/.tsx/.js/.json/.css/…  -> prettier --write <file>
# The formatter argument is always the single edited path, never a directory or
# the repo root, so touching one file cannot drag a whole-project reformat into
# the diff.
#
# One edited path was still not narrow enough. CSharpier formats whole files and
# has no range mode, so a one-line change to a repo that wraps by hand came back
# as a whole-file rewrite: observed live in ParagonAgent, where a 12-line change
# to a shared test fixture arrived as ~40 hunks and the Pair checkpoint built on
# it could not be reviewed. format-range.mjs supplies the missing range mode —
# it formats the file, then keeps only the hunks overlapping the lines this
# session changed. Every other line keeps the bytes it was committed with.
#
# Both branches only fire inside a project that actually uses the formatter:
#   - csharpier needs a *.csproj / *.sln above the file
#   - prettier needs a prettier config that lives inside the file's own git
#     repo. A bare ~/.prettierrc exists on this machine, so prettier's own
#     lookup succeeds for every file under $HOME; without the containment check
#     that home config would silently reformat repos that format another way.
#
# csharpier-default.json (printWidth 160) is a fallback, not an override: it is
# passed only when nothing in the repo states a preference, and range formatting
# is what makes that safe — the widest it can reach is the session's own lines.
# A home-level ~/.csharpierrc could express none of this: csharpier ranks any
# .csharpierrc above .editorconfig regardless of distance, so a home file would
# have silently narrowed the repos that declare max_line_length = 280.
#
# A missing formatter binary is a silent no-op — repos without it must not fail
# on every edit. The harness announces the rewrite to the model on its own, so
# this hook stays silent on both success and skip.
#
# Escape hatch: CLAUDE_FORMAT_ON_EDIT=0 disables the hook.
set -uo pipefail

[[ "${CLAUDE_FORMAT_ON_EDIT:-1}" == "0" ]] && exit 0

input=$(cat)
command -v jq > /dev/null 2>&1 || exit 0

path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_response.filePath // empty')
[[ -z "$path" || ! -f "$path" ]] && exit 0

start_dir=$(dirname "$path")

# First ancestor of $1 holding a match for glob $2.
find_up_glob() {
  local dir=$1 glob=$2
  while [[ -n "$dir" && "$dir" != "/" ]]; do
    compgen -G "$dir/$glob" > /dev/null 2>&1 && { printf '%s' "$dir"; return 0; }
    dir=$(dirname "$dir")
  done
  return 1
}

# Like find_up_glob, but stops after $3 — used to ask "does THIS REPO say
# anything?" without the walk escaping into $HOME, where a personal
# ~/.editorconfig would answer yes for every repo on the machine.
find_up_glob_within() {
  local dir=$1 glob=$2 boundary=$3
  while [[ -n "$dir" && "$dir" != "/" ]]; do
    compgen -G "$dir/$glob" > /dev/null 2>&1 && return 0
    [[ "$dir" == "$boundary" ]] && return 1
    dir=$(dirname "$dir")
  done
  return 1
}

abspath() { printf '%s/%s' "$(cd "$(dirname "$1")" && pwd)" "$(basename "$1")"; }

case "${path##*.}" in
  cs)
    find_up_glob "$start_dir" "*.csproj" > /dev/null \
      || find_up_glob "$start_dir" "*.sln" > /dev/null \
      || exit 0
    export PATH="$HOME/.dotnet/tools:$PATH"
    command -v csharpier > /dev/null 2>&1 || exit 0
    # Supply the printWidth default only where the repo states nothing itself.
    # --config-path suppresses .editorconfig wholesale, so an .editorconfig
    # counts as "the repo decided" even when it sets only indentation.
    command -v node > /dev/null 2>&1 || exit 0
    range="$(dirname "${BASH_SOURCE[0]}")/format-range.mjs"
    [[ -f "$range" ]] || exit 0
    default_cfg="$(dirname "${BASH_SOURCE[0]}")/csharpier-default.json"
    repo=$(git -C "$start_dir" rev-parse --show-toplevel 2> /dev/null)
    # Which config, and then always through format-range.mjs, which keeps only the hunks overlapping the
    # lines this session changed. Whole-file formatting is what buried a 12-line change in ~40 hunks.
    if [[ -z "$repo" ]] \
      || find_up_glob_within "$start_dir" ".csharpierrc*" "$repo" \
      || find_up_glob_within "$start_dir" ".editorconfig" "$repo"; then
      # The repo stated how it wants to look, so csharpier's own lookup is the authority.
      node "$range" "$path" > /dev/null 2>&1
    elif [[ -f "$default_cfg" ]]; then
      # It stated nothing, so the default applies — and range formatting is what makes that safe. It can
      # only ever reach the session's own lines now, so a repo that wraps by hand keeps every line it
      # already had, and there is nothing left to withhold the default from.
      node "$range" "$path" "$default_cfg" > /dev/null 2>&1
    fi
    ;;
  ts | tsx | mts | cts | js | jsx | mjs | cjs | json | jsonc | css | scss | less | html | vue | yaml | yml | md | mdx | graphql)
    if root=$(find_up_glob "$start_dir" "node_modules/.bin/prettier"); then
      bin="$root/node_modules/.bin/prettier"
    elif command -v prettier > /dev/null 2>&1; then
      bin=$(command -v prettier)
    else
      exit 0
    fi
    repo=$(git -C "$start_dir" rev-parse --show-toplevel 2> /dev/null) || exit 0
    config=$("$bin" --find-config-path "$path" 2> /dev/null) || exit 0
    [[ -n "$config" && -e "$config" ]] || exit 0
    [[ "$(abspath "$config")" == "$repo"/* ]] || exit 0
    "$bin" --write --ignore-unknown "$path" > /dev/null 2>&1
    ;;
esac
exit 0
