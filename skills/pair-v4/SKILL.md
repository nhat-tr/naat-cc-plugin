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

`pair-loop status` prints the exact next command for the current state. Adopting a handover, resuming, or arriving with no memory of the loop: run it first and follow the command it names rather than improvising one.

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

## Deterministic failure

An exit status cannot separate a defect this Review Slice introduced from a failure the repository already had. Re-run verification before treating a red gate as a defect. Re-verification is deterministic, so it spends no correction, and a clean run at correction-ready checkpoints the slice directly.

```bash
pair-loop verify [--slice <id>]
```

A test that already failed before this Work is declared once, with the evidence that it pre-exists, and never counts as this Work's failure again. Declaration is human-only: Pair never infers it. Copy the identity verbatim from `pair-loop verify` output.

```bash
pair-loop baseline add --test <test-id> --reason "<evidence it pre-exists>"
pair-loop baseline list
pair-loop baseline remove --test <test-id>
```

An unrecognised runner yields no test identity and is therefore never exempted. A baseline over 32 tests is a broken suite, not a baseline.

Only one verification of a Work runs at a time. Concurrent suites share the machine's containers, ports, and databases, so they make each other fail in unrelated places and those failures can be neither trusted nor baselined. A second verification is refused and names the running one; never run the verify command by hand beside it.

Never hand-edit the Pair worktree to satisfy findings or a red gate. Work done outside the loop carries no checkpoint, no verification record, and no Review Outcome, so it can never be reviewed, adjudicated, or learned from. When a state looks like it has no command, run `pair-loop status`: it names the exact next command.

## Review

Architecture-Sensitive checkpoints always receive fresh review. Routine checkpoints use deterministic proof plus configured conditional sampling.

Reviewer receives only checkpoint diff command, mapped behavior, Design Check when applicable, named callers/contracts, verification result, and at most three relevant approved Review Guidance rules.

Approval contains no prose. Transient reviewer JSON is capped at 6 KiB. Durable Review Outcome is capped at 8 KiB and contains at most three BLOCKER/MAJOR findings. Each finding must include falsifiable claim, reachable scenario, immutable checkpoint commit/path/blob/line anchor, impact, and pass condition.

A human can raise a finding too, reading the checkpoint the same way a reviewer would. It flows through the same disposition and correction path as a model finding once submitted:

```bash
pair-loop finding --slice <id> --file <path> --line <n> --text "<what is wrong>" \
  [--pass-condition "<observable state>"] [--severity BLOCKER|MAJOR]
pair-loop finding --slice <id> [--index <n>] --pass-condition "<observable state>"
pair-loop finding --slice <id> --submit
```

Drafting records no Review Outcome and moves no slice, but it is not invisible: `pair-loop status` lists every unsubmitted draft, each finding's pass condition, and the exact command for whichever is missing one. A draft is deleted only by submission, so `status` also names a draft that can no longer be submitted — its slice already accepted, or the slice moved to a newer checkpoint than the draft anchors to.

Pass condition is the *observable state* — a fact about the code that a command or a reader can check without asking the person who raised it. "Every test in the suite is named `Capability_verb_fact`" is one; "the naming is fixed" and "the human who raised this confirms it is addressed" are not, and a pass condition that defers the verdict to a person is refused where it is written. Submission is refused while any drafted finding states none; complete it in place with the second form above rather than re-drafting, or the outcome carries both copies. A claim bundling two unrelated asks rarely reduces to one pass condition — split it into two findings instead. A duplicate that reaches an outcome anyway is resolved by adjudication: disposition one copy `not-worth-fixing` with the reason naming the copy that carries it.

Model finding never edits code. Human disposition required:

```bash
pair-loop feedback --finding <id> \
  --disposition valid|false-positive|not-worth-fixing|missing-context \
  --reason "<evidence>"
```

The reason is the comment on that finding, capped at 500 characters. It is recorded as immutable Review Feedback, feeds Review Guidance, and — for a finding dispositioned valid — travels to the correcting session attached to the finding it adjudicates. Write it as the instruction you want followed for that finding, not as a verdict.

Only valid finding or deterministic failure permits one bounded fresh correction. Second failure pauses for human control. Because that budget is one deep, spend it on a defect the slice actually has: at correction-ready, `pair-loop verify` first, and `pair-loop run` only once re-verification has confirmed a real, reproducible failure.

A deterministic failure produces no checkpoint, so no Review Outcome and no Review Feedback can exist for it. Review findings raised at that point have no finding ID to carry them; the way to reach a reviewable checkpoint is a clean verification, not hand-edits. To steer that correction, record one bounded Correction Direction while the slice is correction-ready:

```bash
pair-loop direct --text "<intent>" [--slice <id>]
```

It is human intent, not falsifiable evidence, so it travels beside the deterministic failure rather than inside it. Capped at 1000 characters, stored as addressable evidence, and spent with the one correction it steers. Recording it outside the correction-ready window is admitted rather than refused — the out-of-window use is recorded as a human override, because a human who can already see the wrong turn should not wait for the reducer's permission to say so.

Architecture-Sensitive checkpoint requires human acceptance. There is no remote and no pull request; the immutable refs are the review surface, and `show` assembles them:

```bash
pair-loop show [--slice <id>]
pair-loop accept --slice <id>
```

`show` prints two diffs, never one — base→checkpoint answers "does this slice deserve to exist", prior-checkpoint→checkpoint answers "did the correction do what was asked and nothing else" — plus the Design Check, the Correction Direction, each finding with its anchor and recorded disposition, and the verification result. Reviewing only the cumulative diff is how a correction widens its own scope unnoticed.

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
