---
description: Discover and document a use case from source code. Traces flows across repos with evidence and confidence scoring. Asks on ambiguity, never guesses.
---

# Discover

Trace and document a use case using the **discovery** agent.

## What This Command Does

1. **Intake** — confirm scope, repos, trace depth, run mode
2. **Anchor** — find the trigger entrypoint with evidence
3. **Trace** — follow the flow end-to-end across service boundaries
4. **Validate** — confidence-score every step, escalate unknowns
5. **Output** — write the use case to the target output file using the template structure

## Run Modes

- `quick-discovery` (default) — main flow, key alternatives, open questions, discovery log
- `full-doc` — adds deeper trace coverage, full data contracts, full cross-service map, Mermaid lifecycle diagram

## When to Use

- Documenting an existing feature's end-to-end flow
- Understanding how a user action propagates across services
- Onboarding onto unfamiliar code paths
- Pre-work before refactoring a cross-cutting flow

## Usage

```
/discover Add from pallet flow. Write to docs/usecases/UC-001-add-from-pallet.md
/discover User registration — full-doc. Write to docs/usecases/UC-002-user-registration.md
/discover Order cancellation, L2 trace depth. Write to docs/usecases/UC-003-order-cancellation.md
/discover Payment webhook processing. Write to docs/usecases/UC-004-payment-webhook.md
```

## Template Contract

- Seed template location: `~/.dotfiles/scripts/templates/usecase-template.md`
- Discovery instruction reference: `~/.dotfiles/scripts/templates/usecase-discovery-prompt.md`
- Optional operation map: `/docs/discovery/operation-map.yaml` in the current repo
- The command writes to a target use case doc (for example under `docs/usecases/`).
- If output path is missing, the agent must ask before writing.
- Never edit files under `~/.dotfiles/scripts/templates/`; treat them as source templates.

## Trace Depths

- `L1` — boundary only (default): capture operation + target service at each hop
- `L2` — one backend hop: follow into the first handler/resolver
- `L3` — deep trace: full internal flow within each service

## What to Expect

- The agent will **ask you** before starting — to confirm scope, services, and non-goals
- Every flow step is **evidence-backed** with `file:line` references and confidence scores
- If confidence drops below 0.80, the agent escalates instead of guessing
- `full-doc` mode includes deeper trace coverage than `quick-discovery`
- Hard read budgets prevent runaway exploration

## After Discovery

- Review open questions — they highlight gaps worth investigating
- Use the discovery log to understand what was traced and what was skipped
- Feed the output into `/planner` for implementation planning
