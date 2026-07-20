---
name: pair-v3
description: Compatibility entry point for Pair v3. Use only when an existing invocation explicitly names pair-v3 or requests --legacy-v3; all normal Pair work follows the Pair v4 skill.
---

# Pair v3 Compatibility Entry Point

Pair v4 supersedes this workflow. Read and follow `../pair-v4/SKILL.md` for every normal `pair-loop` invocation.

The implementation remains under `skills/pair-v3/scripts/` so installed commands and old paths keep working during migration. That path is not the product version.

Use `pair-loop --legacy-v3 ...` only when the user explicitly requests the old headless split-worker lifecycle. Never infer legacy mode from an old `.pair/plan.md`, an existing ledger, or an old command alias.
