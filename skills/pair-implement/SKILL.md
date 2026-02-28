---
name: pair-implement
description: Implement the current stream from `.pair/plan.md` or fix review findings from `.pair/review.md`. Reads `.pair/status.json` to determine mode (implement or fix). Runs targeted verification and updates `.pair/stream-log.md`.
---

# Pair Implement

Use this skill when the implementation agent should make code changes — either implementing from the plan or fixing review findings.

## Metadata

- Runtime: `codex`
- Claude command: `commands/pair-implement.md`
- Claude agent: `agents/pair-implementer.md`
- Command alias in Claude: `/pair-implement`

## Instructions

Follow `agents/pair-implementer.md` — it is the authoritative source for mode selection, implementation workflow, verification, stream-log updates, and signaling behavior.
