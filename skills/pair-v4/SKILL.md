---
name: pair-v4
description: Token-bounded Evidence-at-Commit Pair workflow for implementing approved Work through minimal Review Slices, dedicated Git worktrees, fresh implementation/review sessions, deterministic Failure Proof, human-adjudicated findings, and compact evaluated Review Guidance. Use when running pair-loop, implementing approved Work, reviewing a checkpoint, resuming Pair state, or inspecting Pair cost and quality.
---

# Pair Evidence-at-Commit Loop

Use current `pair-loop`. Do not create `.pair/plan.md`, large design JSON, generated execution packets, test proposals, plan challenges, warm provider sessions, or autonomous review-fix loops.

## Required inputs

Keep one approved canonical specification and one compact `.pair/review-slices.json`:

```json
{
  "schema": 1,
  "work_id": "work-example",
  "slices": [
    {
      "id": "S1",
      "acceptance_criteria": ["AC-1"],
      "outcome": "One observable behavior works.",
      "depends_on": [],
      "verify": "node --test test/example.test.js"
    }
  ]
}
```

Manifest is navigation only: 1–40 slices and below 16 KiB. Do not embed source excerpts, architecture decisions, test inventories, patches, or review history.

## Start and run

```bash
pair-loop open --work <work-id> --spec .pair/spec.md --manifest .pair/review-slices.json
pair-loop run --runtime auto
pair-loop status
```

Each `run` performs at most one fresh model action except deterministic verification. Run again for next saved action. Pair owns dedicated linked worktree and checkpoint commits. Product branch receives no Pair artifacts.

## Routing

Implementation session first names one bounded Architecture Risk or explicitly returns none. The structured result is transient, capped at 2 KiB, and deleted after ingestion.

- Use Routine Path only when runtime responsibilities remain unchanged.
- Use Architecture-Sensitive Path for a changed or unknown owner/lifetime/state, public or data contract, middleware order, remote boundary, event ordering/idempotency, background-job lifecycle, concurrency/transaction/retry behavior, security boundary, replica/load-balancer behavior, deployment topology, or React state owner.
- Record the Design Check as Markdown under 2 KiB with six lines: seam/callers, ownership/state/lifetime, runtime/failure/deployment, contract/compatibility, rejected alternative, and proof.
- Reinspect checkpoint diff. Escalate a misrouted Routine Path before acceptance.
- Treat existing code as evidence. Reuse pattern only when responsibility, ownership, lifetime, failure behavior, and concurrency match.

Every implementation and review invocation is fresh. Never resume provider session or pass prior transcript/history.

## Failure Proof

Use narrowest proof that observes real failure boundary: base reproduction, unit, integration, contract, end-to-end, runtime, or recorded manual evidence. State negative control, mutation, base failure, or equivalent observation. Pair runs exact manifest verification after handoff and again cumulatively at completion.

Do not freeze exact test names before code. Do not use test count, coverage, or synthetic RED output as proof by itself.

## Review

Architecture-Sensitive checkpoints always receive fresh review. Routine checkpoints use deterministic proof plus configured conditional sampling.

Reviewer receives only checkpoint diff command, mapped behavior, Design Check when applicable, named callers/contracts, verification result, and at most three relevant approved Review Guidance rules.

Approval contains no prose. Transient reviewer JSON is capped at 6 KiB. Durable Review Outcome is capped at 8 KiB and contains at most three BLOCKER/MAJOR findings. Each finding must include falsifiable claim, reachable scenario, immutable checkpoint commit/path/blob/line anchor, impact, and pass condition.

Model finding never edits code. Human disposition required:

```bash
pair-loop feedback --finding <id> \
  --disposition valid|false-positive|not-worth-fixing|missing-context \
  --reason "<evidence>"
```

Only valid finding or deterministic failure permits one bounded fresh correction. Second failure pauses for human control. Architecture-Sensitive checkpoint requires human acceptance:

```bash
pair-loop accept --slice <id>
```

## Review learning

Review Feedback stays as compact immutable references. Runtime prompts never receive raw history.

Review Guidance requires a 20–50 case offline evaluation. The bank is capped at 32 KiB and references fixtures instead of embedding them. Its persisted result is a metrics-and-ID summary capped at 16 KiB; case trials never enter the result or CLI output. The repository retains at most 16 active rules in a 32-KiB index. Guidance needs measured precision/escapes/token improvement and explicit approval. At most three scope-relevant rules enter one review.

```bash
pair-loop evaluate --bank <bank.json>
pair-loop guidance propose --feedback <id,...> --scope <tag,...> \
  --rule "<bounded rule>" --evaluation <result.json>
pair-loop guidance approve --proposal <id> --reason "<decision evidence>"
```

## Worktree and state

Canonical local state lives under Git common directory. `state.json` is capped at 16 KiB; accepted slices retain commit identities instead of changed-path copies, invocation history is reduced to totals plus the latest three summaries, and append-only events never enter model prompts. `refs/pair/<work-id>/*` keep base, checkpoints, reviewed evidence, and completion reachable after linked worktree deletion. Deleting whole repository intentionally deletes local Pair history.

Dependency hydration is lazy. Package-manager caches are fingerprinted by lockfile/runtime/platform. Mutable `node_modules` is never shared directly; copy-on-write reuse is isolated when filesystem supports it. Initialize only named submodules.

```bash
pair-loop hydrate [--submodule <path> ...]
pair-loop remove-worktree
```

Pair never merges automatically. After completion, review and merge or cherry-pick `pair/<work-id>` from the primary worktree, then remove the linked worktree. Worktree removal does not delete the branch or Pair refs.

## Stop conditions

Stop for human input when architecture checkpoint awaits acceptance, findings await disposition, one correction failed, provider/verification evidence is untrustworthy, cumulative verification fails, or Work is blocked. Preserve worktree and refs.
