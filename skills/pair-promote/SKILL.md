---
name: pair-promote
description: Promote an approved specification into an evidence-grounded, capability-first `.pair/plan.md` for pair-v3. Use for pair planning, plan promotion, preparing pair-loop, code-grounded task decomposition, or turning acceptance criteria into delegated TDD tasks without speculative architecture.
---

# Promote an Approved Spec Into a Pair-v3 Plan

Produce an implementable plan for an agent that will not have the planning conversation. Do not implement during promotion.

## Resolve Input

Use, in order:

1. A user-provided canonical spec/design path.
2. The canonical spec path named by the `Canonical:` header in `.pair/spec.md` when its `Canonical SHA-256:` digest matches the exact canonical bytes.
3. An approved design from the current conversation, after publishing it as a canonical Work through the brainstorming skill.

For pair-v3 Work, the canonical spec path is `docs/work/<work-id>/spec.md`; `.pair/spec.md` is only its generated active mirror. Read `work.json`, confirm its Work ID, canonical path, and digest, then run `work-lineage.cjs validate --work docs/work/<work-id>`. The runtime installer puts this portable helper on `PATH`; in an uninstalled toolkit checkout, invoke it from `skills/brainstorming/scripts/work-lineage.cjs`. Stop on a missing Work root, raw legacy mirror, path mismatch, digest mismatch, or validation failure. Do not repair these by planning from chat or by treating `.pair/` as canonical.

Keep `.pair/`, review transcripts, attempts, prompts, and other raw workflow state uncommitted. Plans and implementation envelopes may reference the Work ID, canonical spec path, canonical digest, and Decision Record IDs; they must not copy private conversation or model telemetry into the Work root.

If no approved design exists, stop. If Purpose, Rejection Criteria, Contrasts, stable acceptance-criterion IDs, or verification entries are missing, propose the missing content and obtain approval before writing the plan. Mark evidence-derived proposals so the user can veto them.

If the input already passes pair-v3's canonical `validate-plan`, report that it is already an implementable plan and do not rewrite it.

## Reconstruct Repository and Capability Evidence

Read applicable `AGENTS.md`, relevant `UBIQUITOUS_LANGUAGE.md` clusters, project manifests, lockfiles, callers, tests, and existing implementations before naming files or architecture. Load applicable language skills read-only.

For every dependency or framework that affects the design, establish capability evidence in this order:

1. Existing repository usage and tests.
2. The pinned dependency's source, API metadata, or bundled documentation.
3. Official documentation matching the pinned version.
4. Official samples.
5. A minimal compile/runtime probe under `$CLAUDE_SCRATCH_DIR`.

Model memory is not evidence for a fast-moving or unfamiliar dependency. Record an unknown load-bearing capability as blocking. Do not compensate with a custom abstraction.

Use `**Dependency:** name@version` only for an external package, SDK, framework, or runtime, and always record the pinned version. Use `**Repository capability:**` for an existing symbol, composition pattern, or application-owned gap. Do not label repository-owned behavior as a dependency.

Start from the **framework-native baseline**: the smallest vertical solution that directly composes existing repository and dependency capabilities. Use `reuse` when the baseline satisfies the need. Use `extend` or `build` only for a confirmed gap and state the application-owned behavior the custom module will hide.

High uncertainty is not implementable plan state. Resolve it through reconnaissance or a scratch probe, update the evidence, and then promote with `uncertainty:low|medium`.

## Decompose Vertically

Create streams around observable acceptance behavior, not layers such as abstractions, infrastructure, factories, registries, services, frontend, or backend. A cross-stack behavior may still have ordered tasks in separate streams when ownership and file sets are genuinely independent.

Topologically order streams because pair-v3 executes the first open task. Declare only dependencies on earlier streams.

Apply TDD:

- Begin every stream with `[type:test] [phase:red]`.
- Schedule all failing tests that define a behavior before its implementation.
- Include at least one failing integration test that exercises the acceptance criteria through the real boundary; do not mock the boundary under test.
- Give every task a stable ID, AC mapping, exact files, exact verification command, complexity, and validated profile.

## Write `.pair/plan.md`

Use this contract exactly:

```markdown
# Task: <title>

## Context
<why, approved spec path, and relevant decisions>

## Intent Contract
- **Work ID:** `<work-id>`
- **Spec:** `docs/work/<work-id>/spec.md` (`sha256:<Canonical SHA-256>`)
- **Active Mirror:** `.pair/spec.md` (generated; not canonical)
- **Purpose:** <approved wording>
- **Rejection Criteria:** <approved wording or none beyond ACs>
- **Contrasts:** <approved wording or none>

## Implementation Context
- **Language / Framework:** <pinned versions>
- **Existing patterns:** <real paths and symbols>
- **Constraints:** <compatibility, runtime, security, migration>
- **Verification:** `<fast command>`; `<full command>`

## Capability Evidence
- **Dependency:** `<name>@<pinned-version>` | evidence: `<repo path, official source, or probe>` | decision: reuse | gap: none
- **Dependency:** `<name>@<pinned-version>` | evidence: `<source>` | decision: extend | gap: <confirmed missing capability>
- **Repository capability:** `<path#symbol or named behavior>` | evidence: `<repo path and observed contract>` | decision: reuse | gap: none
- **Repository capability:** `<path#symbol or named behavior>` | evidence: `<repo path and observed contract>` | decision: extend | gap: <application-owned behavior still required>

## Simplicity Contract
- **Native baseline:** <smallest direct composition>
- **Custom modules justified:** <module -> application-owned behavior, or none>
- **Real seams:** <interface -> adapters/external boundary, or none>
- **Rejected abstractions:** <pass-through wrappers/factories/registries/ports not to add>

## Streams
### Stream 1: <observable behavior> - complexity: S|M|L
**Depends on:** none
- [ ] Task 1.1 - write failing tests for <behavior> [type:test] [phase:red] [risk:low] [scope:local] [uncertainty:low] [ac:AC-1] - files: `tests/...` - verify: `<focused failing command>` - **S**
- [ ] Task 1.2 - write failing integration test for <acceptance scenario> [type:test] [phase:red] [risk:medium] [scope:cross-module] [uncertainty:low] [ac:AC-1] - files: `tests/...` - verify: `<integration command>` - **M**
- [ ] Task 1.3 - implement <smallest behavior> [type:feature] [risk:medium] [scope:local] [uncertainty:low] [ac:AC-1] - files: `src/...` - verify: `<focused and integration commands>` - **M**

## Acceptance Criteria
- [ ] AC-1: <criterion copied from the spec>

## Open Questions
- None.
```

Use `- [blocking] <question> - impact: Task X` only while drafting. The canonical validator rejects blocking questions. Non-blocking assumptions must state their evidence and affected tasks.

Allowed task profiles:

- `type`: `bugfix|feature|refactor|test|docs|migration`
- `risk`: `low|medium|high|critical`
- `scope`: `local|cross-module|contract|architecture`
- `uncertainty`: `low|medium` in an implementable plan; resolve `high` first

Security boundaries, credentials, payments, destructive data changes, and production authorization are critical. Public contracts, schemas, database changes, and migrations are at least high risk.

## Enforce Simplicity

Apply the deletion test to every proposed custom module. Reject pass-through wrappers, one-adapter interfaces, speculative factories/registries, duplicated framework capability, and tests that exist only to justify a wrapper. A seam is real only when it has two adapters or crosses a true external ownership boundary.

Every task must serve at least one AC. Every AC must be covered. Do not add cleanup, extensibility, or infrastructure that the approved intent does not require.

## Generate `.pair/verify.sh`

If `.pair/verify.sh` is absent, generate it — the stop-gate's execution check depends on it; without it the gate is checkbox-trust only. Detect the repo and write a FAST script (unit-level only, NO e2e, target < 2 minutes, exit non-zero on failure), then `chmod +x` it:

- `*.csproj`/`*.sln` -> `dotnet build` (or the repo's `dobq`) + `dotnet test --filter "TestCategory=UnitTest"` (match the repo's actual category convention; omit the filter only if the repo has none).
- `package.json` + tsconfig -> `npx tsc --noEmit` + the repo's unit-test script (never the e2e/playwright script).

Verify it runs and passes on the CURRENT (pre-implementation) tree — a verify script that fails before work starts would deadlock the gate.

## Validate and Challenge

Run until clean:

```bash
~/.local/share/my-claude-code/skills/pair-v3/scripts/validate-plan
```

The validator prints the progress-stable `plan contract sha256`. After the final independent challenge, record that digest in `docs/work/<work-id>/work.json` as `plan.sha256` with `path: ".pair/plan.md"`, `status: "validated"`, and the observed independent-review result. Do not use a raw file SHA: Task and Acceptance Criteria checkbox progress is mutable, while any semantic plan change must produce a new contract digest before implementation continues.

For high/critical-risk, cross-stack, migration, or newly verified framework work, run the independent plan challenge when available. It must check Intent Contract alignment, capability evidence, file grounding, AC coverage, TDD order, dependency order, and the Simplicity Contract.

Report stream/task counts, evidence sources, custom modules justified, open questions, and any derived acceptance criteria. Do not begin implementation.
