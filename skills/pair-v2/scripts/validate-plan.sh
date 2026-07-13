#!/usr/bin/env bash
# Compatibility wrapper. The shared pair-v3 parser is the plan contract.
set -uo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
exec node "$script_dir/../../pair-v3/scripts/validate-plan" "$@"
