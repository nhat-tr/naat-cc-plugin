---
name: pair-promote
description: Promote an approved specification into an evidence-grounded, compact `.pair/plan.md` for Pair v4. Use for pair planning, plan promotion, preparing pair-loop, code-grounded task decomposition, or turning acceptance criteria into bounded tests-first Review Slices without speculative architecture.
---

# Promote an Approved Spec Into a Compact Pair Plan

Produce the smallest executable plan the visible Pair v4 coordinator can follow, backed by one immutable Implementation Design Contract. Do not implement during promotion, and do not copy the repository investigation into the plan. Both artifacts are provider-neutral: the same bytes must work in Codex and Claude Code without provider prompts or model-specific fields.

## Resolve Canonical Work

Use, in order:

1. A user-provided canonical specification.
2. The `Canonical:` path in `.pair/spec.md` when its `Canonical SHA-256:` matches the exact canonical bytes.
3. An approved design from the current conversation, after the brainstorming skill publishes it as canonical Work.

For Pair Work, the canonical path is `docs/work/<work-id>/spec.md`; `.pair/spec.md` is only its generated active mirror. Read `work.json`, confirm the Work ID, path, and digest, then run `work-lineage.cjs validate --work docs/work/<work-id>`. Stop on a missing Work root, legacy raw mirror, path escape, digest mismatch, or validation failure. Keep `.pair/`, prompts, transcripts, and model telemetry uncommitted.

If no approved design exists, stop. Purpose, constraints, stable Acceptance Criteria IDs, and verification must be approved before promotion. If the input already passes the canonical `validate-plan`, report that it is already executable and do not rewrite it.

## Ground the Design Once

Read applicable `AGENTS.md`, the relevant `UBIQUITOUS_LANGUAGE.md` cluster, manifests/lockfiles, exact callers, existing implementations, and tests before naming a path or contract. Load applicable language skills read-only.

For a dependency or framework capability, check in this order:

1. Existing repository usage and tests.
2. Pinned package source, API metadata, or bundled docs.
3. Official version-matched documentation or samples.
4. A minimal probe under `$CLAUDE_SCRATCH_DIR`.

- **Dependency:** `<name>@<pinned-version>` means an external package or runtime.
- **Repository capability:** means application-owned code or an existing composition pattern.

Do not label repository behavior as a dependency, use model memory as evidence, or invent an abstraction to cover an unknown. Start with the framework-native baseline; custom code must implement confirmed application behavior.

Record the closed implementation decisions once in an Implementation Design Contract, not repeatedly in plan prose or executor prompts. Keep only a short, human-scannable list of decisive paths/symbols in the plan's `Repository evidence` field.

## Persist the Implementation Design Contract

Before writing `.pair/plan.md`, create one persisted evidence envelope with `kind: "implementation-design-contract"`. Choose the next unused Work-local `EVD-NNN` number by inspecting `work.json` and the indexed `evidence/` files. Use this exact outer/result shape; arrays contain concrete values, not these placeholders:

```json
{
  "schema": 1,
  "id": "EVD-NNN-implementation-design",
  "work_id": "work-YYYYMMDD-slug",
  "kind": "implementation-design-contract",
  "acceptance_criteria": ["AC-1"],
  "decision_record_ids": [],
  "source": "pair-promote/repository-grounding",
  "recorded_at": "ISO-8601 date-time",
  "result": {
    "schema": 1,
    "spec": { "path": "docs/work/<work-id>/spec.md", "sha256": "64 lowercase hex" },
    "repository_evidence": [{ "path": "existing/file", "symbols": ["ExactSymbol"] }],
    "decisions": [{
      "id": "IMP-001", "outcome": "closed behavior", "acceptance_criteria": ["AC-1"], "depends_on": [],
      "symbols": [{ "path": "file", "symbol": "ExactSymbol", "action": "read|add|modify|delete" }],
      "call_paths": ["entry -> ExactSymbol -> effect"],
      "contract": { "before": ["current behavior"], "after": ["required behavior"], "errors": ["error behavior"] },
      "data_shapes": ["exact DTO/API shape"], "state_flow": ["state transition"], "wiring": ["DI/host wiring"],
      "failure_handling": ["failure rule"], "deletions": [],
      "pattern_references": [{ "path": "existing/file", "symbol": "ExactSymbol" }],
      "tests": [{ "name": "exact test", "file": "test/file", "boundary": "unit|integration|e2e", "purpose": "behavior proved", "red_signal": "missing-behavior failure" }],
      "verify": "exact focused command", "non_goals": ["explicit exclusion"]
    }]
  }
}
```

The `result` contains:

- The canonical spec path and SHA-256.
- Existing repository evidence paths and exact symbols actually read. Every non-`add` symbol and every pattern reference must map to this evidence; unused or missing evidence is invalid.
- Stable `IMP-NNN` decisions. Each decision closes its mapped Acceptance Criteria, dependencies, exact symbols/actions and call paths, before/after/error contract, DTO/API/data shapes, state flow, DI/host wiring, failure handling, deletions, repository pattern references, exact tests and RED signal, focused verification, and non-goals.

No `TODO`, `TBD`, unknown field, provider/model/prompt field, provider-specific executor instruction, or undecided alternative may survive promotion. Provider names remain valid only when they are part of the approved product behavior. A decision maps to exactly one Review Slice; all decisions and Acceptance Criteria must be mapped. Write the candidate under `$CLAUDE_SCRATCH_DIR/<repo>/pair-promote/`, then run:

```bash
validate-implementation-design "$CLAUDE_SCRATCH_DIR/<repo>/pair-promote/implementation-design.json"
work-lineage.cjs record-evidence --file "$CLAUDE_SCRATCH_DIR/<repo>/pair-promote/implementation-design.json" --repository-root .
```

The second command creates the immutable `docs/work/<work-id>/evidence/EVD-NNN-implementation-design.json` record and indexes it in `work.json`. Compute its raw SHA-256 after persistence; `.pair/plan.md` binds that exact digest. A revision is a new evidence record, never an in-place edit.

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
- Explicit `type`, `risk`, `scope`, `uncertainty`, mapped `[ac:...]`, and `[test:...]` boundary.
- Exact owned `files`, test-owned `tests`, exact `verify` command, and S/M/L size.
- Exact mapped `IMP-NNN` Implementation Design Contract decisions.

Human readability is part of the contract. Put the observable outcome on the checkbox line, then put each machine-read fact on its own indented, labeled row. Do not collapse profile, files, tests, RED evidence, and verification into one scrolling sentence. The validator accepts this readable form and the legacy one-line form.

Budgets remain hard limits:

| Size | Owned files | ACs | Description |
|---|---:|---:|---:|
| S | 3 | 1 | 240 characters |
| M | 6 | 2 | 420 characters |
| L | 10 | 3 | 650 characters |

Cross-module work is at least medium risk; contract/architecture work is at least high risk; credentials, authorization, payments, destructive data changes, and production security are critical. Resolve uncertainty before promotion. Pair v4 plans are limited to 12 Review Slices and 24 KiB.

## Prove Cheap-Ready, Do Not Infer It From Size

`S` and `M` are size budgets, not model-routing promises. A non-doc Review Slice is cheap-ready only when all of these are true: it is S or M with low uncertainty, risk is low or medium, scope is local or cross-module, every implementation decision is closed and mapped, all named existing evidence exists, and its compiled Review Slice Execution Packet is at most 8,192 UTF-8 bytes. The packet includes the slice constraints, relevant repository evidence, and transitive upstream decisions as well as its own decisions and tests.

Strength 1 means a minimal docs executor; strength 2 means a standard code executor; strength 3 means a strong executor; strength 4 means the strongest available executor. Claude commonly maps these to Haiku/low, Sonnet/medium, Opus/high, and Opus/max; Codex commonly maps them to low, medium, high, and xhigh reasoning on the selected model. These are provider-affine launch recommendations, not fields in the contract. Pair v4's visible coordinator cannot switch its own model: choose the recommended tier before starting that coordinator. Provider configuration may change the concrete model while the provider-neutral packet stays identical.

The validator compiles every packet and prints `cheap-ready`, `recommended-strength`, and `packet-bytes`. Treat failure of any gate as routing evidence, not as an invitation to relabel the task. This makes a grounded S or M task suitable for a less expensive executor while retaining exact decisions and tests; it does not make an arbitrary M task cheap.

## Write `.pair/plan.md`

Use this default contract:

```markdown
# Task: <title>

**Pair mode:** compiled

## Intent Contract
- **Spec:** `docs/work/<work-id>/spec.md` (`sha256:<Canonical SHA-256>`)
- **Implementation design:** `docs/work/<work-id>/evidence/EVD-NNN-implementation-design.json` (`sha256:<raw evidence SHA-256>`)
- **Purpose:** <approved observable outcome>
- **Repository evidence:** `<existing-path#symbol>`, `<test/path>`, and `<manifest/lockfile>`
- **Constraints:** <approved compatibility, security, rejection, and simplicity boundaries>
- **Verification:** `<full Work command>`

## Streams
### Stream 1: <observable capability>
- [ ] Task 1.1 — <complete observable slice>
  - **Profile:** [type:feature] [risk:medium] [scope:cross-module] [uncertainty:low] [ac:AC-1] [test:integration] · **M**
  - **Files:** `tests/<behavior>.integration.*`, `src/<behavior>.*`
  - **Tests:** `tests/<behavior>.integration.*`
  - **Design:** IMP-001
  - **Verify:** `<exact focused command>`

## Acceptance Criteria
- [ ] AC-1: <criterion copied verbatim from the canonical spec>

## Open Questions
- None.
```

Use additional Streams only to make real ordering visible. The runner executes tasks in written order, so do not add dependency ceremony for a simple linear plan. Add a short nested `Consumes`/`Produces` contract only when an otherwise invisible cross-task interface truly needs it; it is optional in the compiled Pair v4 contract. Legacy `lite` and full Pair plans remain readable for compatibility, but new promotions use `compiled`.

Never add progress logs, recovery notes, reviewer findings, or implementation history to the plan. Acceptance Criteria are completion state, not model tasks; the runner closes them automatically when all mapped tasks pass.

## Verification Script

If `.pair/verify.sh` is absent, create a fast pre-existing-tree gate using repository-native commands and make it executable. It must pass before implementation and target under two minutes. Do not substitute Docker for an existing container workflow or add an e2e suite to a fast gate. The final Pair v4 gate runs every distinct task verification plus `.pair/verify.sh` once.

## Validate, Then Challenge the Exact Digest

Run:

```bash
validate-plan .pair/plan.md
pair-loop --challenge-plan --runtime auto
```

The first challenge performs one bounded sweep and reports all material findings together. After a semantic revision, run a focused closure verdict that carries prior findings forward. Pair v4 challenges a Work at most twice across plan digests by default. If the second reviewer verdict still has material plan findings, Pair records an exact-digest `human-override`, retains the findings for mandatory coordinator work, and does not challenge the plan again. Reviewer-environment failures are never approved. `PAIR_MAX_PLAN_REVIEWS` or `--max-plan-reviews` can select a different positive challenge cap.

A clean independent verdict records `no-blockers:<digest>:<runtime>/<model>`. If the human deliberately accepts the risk or the reviewer environment is unusable, the user may approve the exact current digest honestly:

```bash
pair-loop --approve-plan <64-character-digest> --reason "<concrete reason>"
```

This records `human-override:<digest>:user:<reason-hash>` plus the full reason in `.pair/plan-review.json`; it never claims an independent review occurred. Cross-provider fallback remains opt-in via `--allow-cross-runtime-fallback`.

Report the Work ID, Implementation Design Contract path/digest, plan digest, task/AC counts, each Review Slice's cheap-ready/recommended-strength/packet-bytes result, decisive repository evidence, full verification command, complete plan-review summary path, and whether approval was independent or a human override. Do not begin implementation.
