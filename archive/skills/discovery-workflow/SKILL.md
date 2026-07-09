---
name: discovery-workflow
description: Evidence-first use-case discovery workflow across repositories. Use when documenting end-to-end flows, tracing operations across services, or building architecture understanding before implementation.
---

# Discovery Workflow

Use this skill for use-case discovery sessions.

## Metadata

- Runtime: `codex`
- Claude command: `commands/discover.md`
- Claude agent: `agents/discovery.md`
- Command alias in Claude: `/discover`

## Workflow

1. Load source docs:
   - `../../commands/discover.md`
   - `../../agents/discovery.md`
2. Confirm output file path and mode (`quick-discovery` or `full-doc`).
3. Trace entrypoint and cross-service flow with evidence and confidence.
4. Escalate ambiguity instead of guessing.
5. Write results into the target use-case document.

## Rules

- Use `docs/discovery/operation-map.yaml` when available.
- Respect mode-specific read budgets.
- Keep claims evidence-backed.
