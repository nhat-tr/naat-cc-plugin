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

Pair owns dedicated linked worktree and checkpoint commits. Product branch receives no Pair artifacts.

## Who drives

The loop drives itself. One `run` carries a Review Slice from implementation through verification, review, correction and acceptance, and on into the next slice, stopping only where a person is genuinely required: a block, a completed Work, an interrupt, the per-run action cap, or a slice you marked `hitl`.

```bash
pair-loop hitl                       # who drives what
pair-loop hitl --slice <id>          # stand in this one
pair-loop hitl --slice <id> --off    # hand it back to the loop
pair-loop hitl --all [--off]         # the whole Work, clearing every per-slice mark
```

A marked slice meets every gate below, one fresh model action per `run`: its findings wait for your disposition, its Architecture-Sensitive checkpoint waits for your acceptance, its corrected checkpoint comes back to you. Marking is not retroactive — a slice already parked at a gate stays parked, because handing it to the loop must not accept a checkpoint nobody read — and a slice can also arrive marked, with `"hitl": true` on its manifest entry.

An unmarked slice adjudicates its own model findings: the claim is believed, spent on the one bounded correction it earns, and the corrected checkpoint reviewed again. That is bounded rather than trusting — the correction is counted, so a second round of valid findings blocks for a human exactly as it always did. Every such verdict is stamped `adjudicator: autonomous` in the immutable record and is refused as a source of Review Guidance, which learns from human judgement only.

Accepting a checkpoint hands the Work straight to the next slice when the loop drives that slice — the acceptance is the input, exactly as a submitted correction is. A slice marked `hitl` is not started this way: the mark is the request to be asked.

A run narrates itself on **stderr** as it goes — each provider call and verification when it starts and when it returns, with duration, tokens and cost, then where the transition landed and how many of the per-run actions it has spent. stdout still carries only the final status (or `--json`), so nothing has to be parsed out of it; `--quiet` silences progress for a caller that treats stderr as failure.

```
[15:41:24] S-05 implementation started — claude/claude-opus-5[1m], warm session
[15:41:24] S-05 implementation finished — 11m05s, 40.4k out, 160.9k ctx, $5.84
[15:41:25] S-05 verifying — dotnet test …
[15:44:42] S-05 verification clean — 3m17s
[15:44:42] action 1/40 → ready, S-05 review-ready
```

Configuration lives in `~/.config/pair/config.json`: `human_in_the_loop_default: true` puts you back in every loop, `autonomous_actions_per_run` (default 40) bounds one run. Both are pinned at open, so Work in flight keeps the gates it was opened with.

## Routing

Implementation session first names one bounded Architecture Risk or explicitly returns none. The structured result is transient, capped at 2 KiB, and deleted after ingestion.

- Use Routine Path only when runtime responsibilities remain unchanged.
- Use Architecture-Sensitive Path for a changed or unknown owner/lifetime/state, public or data contract, middleware order, remote boundary, event ordering/idempotency, background-job lifecycle, concurrency/transaction/retry behavior, security boundary, replica/load-balancer behavior, deployment topology, or React state owner.
- Record the Design Check as Markdown under 2 KiB with six lines: seam/callers, ownership/state/lifetime, runtime/failure/deployment, contract/compatibility, rejected alternative, and proof.
- Reinspect checkpoint diff. Escalate a misrouted Routine Path before acceptance.
- Treat existing code as evidence. Reuse pattern only when responsibility, ownership, lifetime, failure behavior, and concurrency match.

Every **review** invocation is fresh. Never resume a provider session for a review, and never pass prior transcript or history into one — fresh eyes are what a review is for, and the loop refuses a review that asks to resume.

## Warm implementation session

Implementation of one Review Slice lives in one provider session that carries through the whole cycle: it implements, the checkpoint is reviewed, and the same session applies the correction. The first implementation call of a slice persists its session and records the id; corrections and steering resume it. Only implementation is warm — reviews and post-diff design stay one-shot.

A resumed call carries only what the session cannot already know: the adjudicated findings, the deterministic failure, and any human direction. It re-sends no outcome and no acceptance criteria, because the session is already holding them. `pair-loop brief` shows the correction exactly as it will run, warm or cold.

Continuity is bounded rather than unlimited. The session retires when the slice is accepted, and rotates mid-slice — a fresh session seeded with the full package — when the last call's context passed `warm_session_context_budget_tokens` (default 120000), when the runtime or model changed, or when the resume failed. Every rotation is recorded with its reason, and a rotation is exactly the fresh-spawn path, so it is always available as a fallback.

```bash
pair-loop interrupt                              # stop the attempt in flight
pair-loop steer --text "<direction>" [--slice <id>]
```

`interrupt` signals the provider alone, so the run that owns it survives to record the attempt as `interrupted-by-human`: no correction is spent, nothing is blocked, and the edits already made stay in the worktree for the next run to pick up. `steer` puts a human message — up to 8 KiB, not reflowed — into the session carrying this slice as a resumed turn, and dispatches it immediately while the Work is `ready`. It is spent by the attempt that carries it. Unlike `direct`, it is not bounded to one correction and not restricted to `correction-ready`.

Closing adjudication on a valid finding, or `pair-loop finding --submit`, dispatches that correction immediately into the warm session. Nothing cycles without a human act; set `dispatch_correction_on_submit: false` to keep the explicit `run`.

Everything here is per Work: a Work opened before warm sessions existed carries no policy and keeps spawning fresh for the rest of its life. Configuration lives in `~/.config/pair/config.json` and every key has a safe default.

`pair-report` states warm-vs-fresh call counts, rotations by reason, and the per-slice context growth curve — the numbers the continuity claim is judged on.

## Failure Proof

Use narrowest proof that observes real failure boundary: base reproduction, unit, integration, contract, end-to-end, runtime, or recorded manual evidence. State negative control, mutation, base failure, or equivalent observation. Pair runs exact manifest verification after handoff and again cumulatively at completion.

Do not freeze exact test names before code. Do not use test count, coverage, or synthetic RED output as proof by itself.

If the implementer's own report names a specific behavioral verification as unmet ("the one gap: proving X actually reaches Y"), the slice cannot claim implemented on static/fitness evidence alone — that named gap is the proof obligation. Any already-diagnosed adjacent defect must be listed in the completion report even when out of scope.

## Deterministic failure

An exit status cannot separate a defect this Review Slice introduced from a failure the repository already had. Re-run verification before treating a red gate as a defect. Re-verification is deterministic, so it spends no correction, and a clean run at correction-ready checkpoints the slice directly.

On an unmarked slice the loop does this itself: a red gate is re-verified immediately, and a clean second run checkpoints it — a correction spent on a flake edits working code to chase a failure that was never in it. If the failure is real, the loop keeps correcting it. **A failing test is not a finding**: it is falsifiable and the same suite judges every round, so it gets `deterministic_correction_attempts` (default 3) rather than the single correction a model finding earns. What bounds it is progress — an attempt that leaves the identical set of tests failing has stopped moving and blocks there, whatever budget remains. A `hitl` slice keeps the one correction and then asks you.

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

Never hand-edit the Pair worktree to satisfy findings or a red gate. Work done outside the loop carries no checkpoint, no verification record, and no Review Outcome, so it can never be reviewed, adjudicated, or learned from. When a state looks like it has no command, run `pair-loop status`: it names the exact next command. For Work orientation in a fresh session, run `pair-loop digest` — it prints the slices, their acceptance criteria, and the next command in a few hundred bytes; do not read `.pair/spec.md` or `.pair/plan.md` whole.

## Review

Architecture-Sensitive checkpoints always receive fresh review. Routine checkpoints use deterministic proof plus configured conditional sampling.

Reviewer receives only the checkpoint diff, mapped behavior, Design Check when applicable, named callers/contracts, verification result, and at most three relevant approved Review Guidance rules. The diff arrives inlined when it fits `review_diff_inline_max_bytes` (default 24 KiB) — the coordinator already holds it as two commit ids, so making the reviewer re-derive it buys nothing — and above that cap the reviewer derives it selectively as before.

Approval contains no prose. Transient reviewer JSON is capped at 6 KiB. A model Review Outcome contains at most three BLOCKER/MAJOR findings, each with a falsifiable claim (≤180 characters), reachable scenario, immutable checkpoint commit/path/blob/line anchor, impact, and pass condition. Those bounds are a token budget on a fresh reviewer, so a human review is bounded separately: up to twenty findings, ≤400 characters per field, and an optional pass condition.

A finding whose claim names a defect class ("every X", "all instances of Y") must carry a pass condition that enumerates the class mechanically — a fitness/architecture test or a grep-able invariant — never a single-instance fix; a class-scoped finding closed by one instance is not closed.

A human review happens when you read, not when the loop offers a gate, so nothing about the bookkeeping refuses one. Draft before any checkpoint exists and the claim anchors the worktree's HEAD; submit long after and it keeps the commit you actually read; submit against a slice since accepted and the correction **migrates** to whatever slice can carry one — reopening the last accepted slice, on the record, when the Work has none left. A draft is never stale and never blocks anything.

A finding anchors any file tracked at the anchored commit, not only the paths this slice changed — a checkpoint is read against the code around it, and the caller the diff never touched is often the thing worth raising. Type the path as your editor shows it, absolute or repository-relative; a path the checkpoint tree does not contain is refused by name, because there is no immutable blob there for the claim to be about.

A human can raise a finding too, reading the checkpoint the same way a reviewer would. It reaches the same one bounded correction a model finding does, but not by the same route: a model finding is a claim awaiting a verdict, and a human finding arrives with one. Submission *is* the verdict, so every submitted human finding is recorded valid and the slice lands directly on `correction-ready` — no second pass adjudicating your own claims. In nvim that is `<leader>pf` per finding while you read, then either `<leader>pn` or `s` in the draft inbox (`f` on the Review Slice Board, `<leader>pb`); both submit the draft *and* spend the correction it earns, so the correcting session starts without a further gesture. To steer that correction, `D` on the board's row first: a Correction Direction is admitted at any status, so it does not have to wait for the reducer.

```bash
pair-loop finding --slice <id> --file <path> --line <n> --text "<what is wrong>" \
  [--pass-condition "<observable state>"] [--severity BLOCKER|MAJOR] [--allow-same-anchor]
pair-loop finding --slice <id> [--index <n>] --text "<the claim, reworded>"
pair-loop finding --slice <id> [--index <n>] --pass-condition "<observable state>"
pair-loop finding --slice <id> [--index <n>] --drop
pair-loop finding --slice <id> --submit
```

A second finding on lines a drafted finding already anchors is refused: at the same anchor a reworded claim is a re-draft far more often than a second concern. Reword the one already there with `--index <n> --text`, `--drop` it, or pass `--allow-same-anchor` to declare the concerns genuinely distinct. Both reach only the draft — the mutable half — so a duplicate never has to be submitted and dispositioned away, which would write it into the immutable record and into the Review Guidance bank that learns from it.

Drafting records no Review Outcome and moves no slice, but it is not invisible: `pair-loop status` lists every unsubmitted draft. A draft is deleted only by submission, so `status` also names a draft that can no longer be submitted — its slice already accepted, or the slice moved to a newer checkpoint than the draft anchors to.

A claim over 400 characters is refused where it is drafted, naming its length and how much to cut, rather than at submission where a batch of findings would fail for one of them and nothing could be edited. In nvim the refusal reopens the prompt with your text in it.

`--pass-condition` is optional, and an unstated one is *absent* rather than a copy of the claim. You raise the issue; working out what "addressed" looks like is the correcting session's job, and your claim plus the lines you anchored it to is what it goes on. State a separate one only when the claim is a symptom and the remedy is a different observable fact — "every test in the suite is named `Capability_verb_fact`" against a claim about one badly-named test. When you do state one it must be the *observable state*, a fact a command or a reader can check without asking the person who raised it: "the naming is fixed" and "the human who raised this confirms it is addressed" are refused where they are written, because a pass condition that defers the verdict to a person leaves the corrector nothing to satisfy. A claim bundling two unrelated asks is two findings, not one.

Model finding never edits code, and its claim is the one that still needs a human verdict:

```bash
pair-loop feedback --finding <id> \
  --disposition valid|false-positive|not-worth-fixing|missing-context \
  --reason "<evidence>"
```

The reason is the comment on that finding, capped at 500 characters. It is recorded as immutable Review Feedback, feeds Review Guidance, and — for a finding dispositioned valid — travels to the correcting session attached to the finding it adjudicates. Write it as the instruction you want followed for that finding, not as a verdict.

Only valid finding or deterministic failure permits one bounded fresh correction. Second failure pauses for human control. Because that budget is one deep, spend it on a defect the slice actually has: at correction-ready, `pair-loop verify` first, and `pair-loop run` only once re-verification has confirmed a real, reproducible failure.

That budget bounds a *model* loop. A fresh reviewer can always find something, so find → correct → find → correct would never terminate on its own, and the block is what puts a human back in it. A **human** review is already that human: the correction produces a new checkpoint, the slice returns to `awaiting-human-review`, and reading that checkpoint, writing a finding against it and submitting it *is* the deliberation `unblock --reason "<why a second correction is warranted>"` asks for. So a human round does not block — round two, three and four each earn their correction directly, and review → correct → review until you accept is the normal shape rather than an escape hatch. The bound holds where it means something: a model finding dispositioned valid after the correction is spent still blocks, and so does a correction that fails its own verification, whoever raised it.

A deterministic failure produces no checkpoint, so no Review Outcome and no Review Feedback can exist for it. Review findings raised at that point have no finding ID to carry them; the way to reach a reviewable checkpoint is a clean verification, not hand-edits. It does produce an **attempt snapshot** — the session's work written as a commit in `refs/pair/<work-id>/attempts/<slice>/<n>` through a throwaway index, so the branch, HEAD and the worktree's index are all untouched and no attempt can pass for an accepted change. That is what makes a red slice readable: `show`, and the Review Slice Board's `d` and `<CR>` on that row, diff against it and say `unverified attempt` every time they offer it. Reading it is the point; accepting it is structurally refused, and re-verification is the only route from an attempt to a checkpoint. To steer that correction, record one bounded Correction Direction while the slice is correction-ready:

```bash
pair-loop direct --text "<intent>" [--slice <id>]
```

It is human intent, not falsifiable evidence, so it travels beside the deterministic failure rather than inside it. Capped at 1000 characters, stored as addressable evidence, and spent with the one correction it steers. Recording it outside the correction-ready window is admitted rather than refused — the out-of-window use is recorded as a human override, because a human who can already see the wrong turn should not wait for the reducer's permission to say so.

An Architecture-Sensitive checkpoint on a `hitl` slice requires human acceptance; unmarked, it is accepted on a fresh review that found nothing. There is no remote and no pull request; the immutable refs are the review surface, and `show` assembles them:

```bash
pair-loop show [--slice <id>]
pair-loop accept --slice <id>
```

`show` prints two diffs, never one — base→checkpoint answers "does this slice deserve to exist", prior-checkpoint→checkpoint answers "did the correction do what was asked and nothing else" — plus the Design Check, the Correction Direction, each finding with its anchor and recorded disposition, and the verification result. Reviewing only the cumulative diff is how a correction widens its own scope unnoticed. A red slice gets the same pair against its attempt snapshots (base→attempt and prior-attempt→attempt), labelled unverified.

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

Pair never merges automatically. Completion is two acts and both are the human's: land the branch, then tidy up.

```bash
git merge --no-ff pair/<work-id>     # from the primary worktree; or cherry-pick base..head
pair-loop finish                     # removes the linked worktree, clears the current-Work selection
pair-loop checkpoints [--json]       # every slice's commit pair — readable after cleanup
pair-loop sessions [--json]          # every provider session of every Work, newest first
```

`finish` refuses until the branch has reached the branch you are standing on, and refuses a Work that is not complete; `--force` overrides both. It keeps a worktree holding uncommitted changes and says so — those changes exist nowhere else. Removing the worktree is what stops it holding `pair/<work-id>` checked out, which is what otherwise blocks deleting or checking out that branch later; clearing the selection is what stops every later command answering for a Work that is over.

The branch and `refs/pair/<work-id>/*` survive, so the review history stays readable: `checkpoints` and `show` resolve against the linked worktree while it exists and against the primary checkout afterwards, and both report which one answered (`read_root`, `worktree_exists`).

## Stop conditions

Stop for human input when a `hitl` slice's architecture checkpoint awaits acceptance or its findings await disposition, one correction failed, provider/verification evidence is untrustworthy, cumulative verification fails, combined-diff review found something, or Work is blocked. Preserve worktree and refs.
