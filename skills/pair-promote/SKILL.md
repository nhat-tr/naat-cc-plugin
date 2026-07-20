---
name: pair-promote
description: Promote an approved specification into an evidence-grounded, compact `.pair/plan.md` for Pair v4. Use for pair planning, plan promotion, preparing pair-loop, code-grounded task decomposition, or turning acceptance criteria into bounded tests-first Review Slices without speculative architecture.
---

# Promote an Approved Spec Into a Compact Pair Plan

Produce the smallest executable plan the visible Pair v4 coordinator can follow. Do not implement during promotion, and do not copy the repository investigation into the plan.

## Resolve Canonical Work

Use, in order:

1. A user-provided canonical specification.
2. The `Canonical:` path in `.pair/spec.md` when its `Canonical SHA-256:` matches the exact canonical bytes.
3. An approved design from the current conversation, after the brainstorming skill publishes it as canonical Work.

For Pair Work, the canonical path is `docs/work/<work-id>/spec.md`; `.pair/spec.md` is only its generated active mirror. Read `work.json`, confirm the Work ID, path, and digest, then run `work-lineage.cjs validate --work docs/work/<work-id>`. Stop on a missing Work root, legacy raw mirror, path escape, digest mismatch, or validation failure. Keep `.pair/`, prompts, transcripts, and model telemetry uncommitted.

If no approved design exists, stop. Purpose, constraints, stable Acceptance Criteria IDs, and verification must be approved before promotion. If the input already passes the canonical `validate-plan`, report that it is already executable and do not rewrite it.

## Ground the Plan, Keep the Evidence Compact

Read applicable `AGENTS.md`, the relevant `UBIQUITOUS_LANGUAGE.md` cluster, manifests/lockfiles, exact callers, existing implementations, and tests before naming a path or contract. Load applicable language skills read-only.

For a dependency or framework capability, check in this order:

1. Existing repository usage and tests.
2. Pinned package source, API metadata, or bundled docs.
3. Official version-matched documentation or samples.
4. A minimal probe under `$CLAUDE_SCRATCH_DIR`.

- **Dependency:** `<name>@<pinned-version>` means an external package or runtime.
- **Repository capability:** means application-owned code or an existing composition pattern.

Do not label repository behavior as a dependency, use model memory as evidence, or invent an abstraction to cover an unknown. Start with the framework-native baseline; custom code must implement confirmed application behavior.

Record only the decisive paths/symbols in the plan's single `Repository evidence` field. The investigation remains in tool evidence or canonical Work, not in repeated Capability Evidence, Simplicity Contract, Change Map, Consumes/Produces, and Review-boundary prose.

## Design Finite Behavior Slices

One plan owns one cohesive repository deliverable. Split independent subsystems, separately releasable deliverables, and other repositories into separate Work.

Each task is one complete behavior-sized Review Slice handled by the visible coordinator in one tests-first pass:

1. Read the named evidence and existing tests.
2. Write the smallest failing test first.
3. Confirm it fails for the missing behavior, not a tooling/environment failure.
4. Implement the minimum behavior without weakening the test.
5. Run the exact `verify:` command.

Do not create separate RED, GREEN, unit-test, integration-test, wiring, or review tasks. Fold setup and wiring into the behavior that needs them. Every non-doc slice owns its test files and declares `[test:unit|integration|e2e]`. At least one integration/e2e slice must cross a real acceptance boundary. Integration tests covering the Acceptance Criteria are mandatory.

Only these task facts belong in the executable plan:

- Stable task ID and observable outcome.
- Explicit `risk`, mapped `[ac:...]`, and `[test:...]` boundary.
- Exact owned `files`, test-owned `tests`, exact `verify` command, and S/M/L size.

Human readability is part of the contract. Put the observable outcome on the checkbox line, then put each machine-read fact on its own indented, labeled row. Do not collapse profile, files, tests, RED evidence, and verification into one scrolling sentence. The validator accepts this readable form and the legacy one-line form.

Budgets remain hard limits:

| Size | Owned files | ACs | Description |
|---|---:|---:|---:|
| S | 3 | 1 | 240 characters |
| M | 6 | 2 | 420 characters |
| L | 10 | 3 | 650 characters |

Cross-module work is at least medium risk; contract/architecture work is at least high risk; credentials, authorization, payments, destructive data changes, and production security are critical. Resolve uncertainty before promotion. Pair v4 plans are limited to 12 Review Slices and 24 KiB.

## Write `.pair/plan.md`

Use this default contract:

```markdown
# Task: <title>

**Pair mode:** lite

## Intent Contract
- **Spec:** `docs/work/<work-id>/spec.md` (`sha256:<Canonical SHA-256>`)
- **Purpose:** <approved observable outcome>
- **Repository evidence:** `<existing-path#symbol>`, `<test/path>`, and `<manifest/lockfile>`
- **Constraints:** <approved compatibility, security, rejection, and simplicity boundaries>
- **Verification:** `<full Work command>`

## Streams
### Stream 1: <observable capability>
- [ ] Task 1.1 — <complete observable slice>
  - **Profile:** [risk:medium] [ac:AC-1] [test:integration] · **M**
  - **Files:** `tests/<behavior>.integration.*`, `src/<behavior>.*`
  - **Tests:** `tests/<behavior>.integration.*`
  - **Verify:** `<exact focused command>`

## Acceptance Criteria
- [ ] AC-1: <criterion copied verbatim from the canonical spec>

## Open Questions
- None.
```

Use additional Streams only to make real ordering visible. The runner executes tasks in written order, so do not add dependency ceremony for a simple linear plan. Add a short nested `Consumes`/`Produces` contract only when an otherwise invisible cross-task interface truly needs it; it is optional in the compact Pair v4 contract. For the full Pair contract, put every required profile tag on `**Profile:**` and use separate `**Red:**`, `**Red expect:**`, `**Consumes:**`, `**Produces:**`, `**Defect:**`, `**Review boundary:**`, and `**Test boundary:**` rows.

Never add progress logs, recovery notes, reviewer findings, or implementation history to the plan. Acceptance Criteria are completion state, not model tasks; the runner closes them automatically when all mapped tasks pass.

## Verification Script

If `.pair/verify.sh` is absent, create a fast pre-existing-tree gate using repository-native commands and make it executable. It must pass before implementation and target under two minutes. Do not substitute Docker for an existing container workflow or add an e2e suite to a fast gate. The final Pair v4 gate runs every distinct task verification plus `.pair/verify.sh` once.

## Validate, Then Challenge the Exact Digest

Run:

```bash
skills/pair-v3/scripts/validate-plan .pair/plan.md
pair-loop --challenge-plan --runtime auto
```

The first challenge performs one bounded sweep and reports all material findings together. After a semantic revision, run a focused closure verdict that carries prior findings forward. Every CLI invocation is finite, exact already-approved digests are cached, and unchanged material findings require plan revision rather than blind redispatch. Pair v4 has no default lifetime counter across plan digests; `PAIR_MAX_PLAN_REVIEWS` or `--max-plan-reviews` remains an optional operator ceiling.

A clean independent verdict records `no-blockers:<digest>:<runtime>/<model>`. If the human deliberately accepts the risk or the reviewer environment is unusable, the user may approve the exact current digest honestly:

```bash
pair-loop --approve-plan <64-character-digest> --reason "<concrete reason>"
```

This records `human-override:<digest>:user:<reason-hash>` plus the full reason in `.pair/plan-review.json`; it never claims an independent review occurred. Cross-provider fallback remains opt-in via `--allow-cross-runtime-fallback`.

Report the Work ID, plan digest, task/AC counts, decisive repository evidence, full verification command, complete plan-review summary path, and whether approval was independent or a human override. Do not begin implementation.
