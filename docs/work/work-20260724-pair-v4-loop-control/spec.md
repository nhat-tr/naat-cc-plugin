# Spec: Pair v4 loop control — human insight and control over tests, review, and verification

- **Work ID:** `work-20260724-pair-v4-loop-control`

## Purpose

Pair v4's tests-first loop and independent Review Session are sound, but the human driving the loop has too little insight and control at the two most expensive, error-prone moments: when a Review Slice's tests are authored, and when the reviewer's verdict is acted on. They also cannot extend what a slice verifies beyond the plan's per-task `verify:` command (or the repo-wide `.pair/verify.sh` fallback that runs when a task declares no `verify:`) — and there is no digest-safe way to add a verification instruction while the loop is running.

Today this costs the driver real tokens on low-value or over-complex tests they would have rejected, and it lets the coordinator act on reviewer verdicts the human can neither inspect, override, nor learn from. The result is "too much effort for too little quality."

We want the human to be able to see, shape, and learn from those steps — and to extend where a slice verifies — all opt-in, so the loop is worth running on real work without adding ceremony to simple work.

## Rejection Criteria

- Must not weaken the tests-first guarantee or independent verification: no path that makes tests optional, and no path that trusts the doer's self-reported pass instead of Pair's own replay verification.
- Must stay opt-in: default (unflagged) behavior is byte-for-byte unchanged; no new mandatory approval step is added to an ordinary slice. Sole permitted exception: D-9's security-baseline tightening — doer edits to verification inputs (`.pair/verify.sh`, `.pair/extra-verify.json`) fail verification instead of warning.
- Must not fork the canonical lifecycle contract or duplicate lifecycle state; every new control composes the existing reducer, review-evidence, and pause machinery.
- Must not persist prompts, transcripts, private reasoning, or secrets in any new store (the review ledger); existing redaction is preserved. `[evidence-derived]` from the Pair v4 privacy contract (`skills/pair-v4/SKILL.md` "Bounded Resume and Privacy").

## Contrasts

- Not a lifecycle rewrite — we add gates, visibility, and an additive verify hook, not new phases.
- Not removing independent review — we make its verdict inspectable and overridable, not optional.
- Not making tests optional — we make them reviewable and revisable before they are written.

## Constraints

- Target repository is the toolkit itself; all changes land in `skills/pair-v3/scripts/**`, `skills/pair-v3/schemas/**`, `skills/pair-v3/tests/**`, and `skills/pair-v4/SKILL.md`. Node CommonJS, tested with `node --test`.
- The tmux/Neovim pane presentation lives in an external dotfiles repository (`docs/work/work-20260719-pair-loop-observable-control/decisions/DR-001-visible-runtime-host.md`); this Work cannot write across that boundary, so reviewer visibility (B3) is delivered as in-repo readable data, not pane cosmetics.
- `pair-loop` is a dispatcher: `--challenge-plan`/`--approve-plan` route to `pair-plan-challenge` (`skills/pair-v3/scripts/pair-loop:5-11`); everything else falls through to `pair-task` (`pair-loop:12`). New loop flags are therefore parsed in `pair-task` (plan-gate policy changes live in `pair-plan-challenge`) and invoked as `pair-loop <flag>`.

## Decisions

### D-1: All new controls are opt-in; defaults unchanged
- **Decision:** Every capability below is gated by an explicit flag or environment variable and is off by default.
- **Why:** Rejection Criterion 2 — ordinary work must not gain ceremony; this mirrors the existing `--hitl` (`PAIR_HITL`) and `--advisory-review` opt-in pattern.
- **Consequences:** Each acceptance criterion must include a default-off assertion (unflagged run is unchanged).

### D-2: A1 — richer test proposal detail
- **Decision:** Extend `skills/pair-v3/schemas/test-proposal.json` so each proposed test carries one optional bounded freeform `spec` string (a short technical sketch: what it arranges/asserts and why the declared boundary), alongside the existing `name`, `purpose`, `file`. `proposalPrompt` (`pair-task:2600`) requests it; `printTestProposal` (`pair-task:2586`) displays it.
- **Why:** The current proposal shows only a one-line purpose, which is too thin to judge whether a test is worth its token cost. A single freeform field is cheaper and matches the existing one-line style; structured arrange/act/assert fields were rejected as heavier for little added judgment value.
- **Consequences:** Only meaningful under `--hitl`. The schema currently requires exactly `name`/`purpose`/`file` with `additionalProperties: false` (`test-proposal.json:9-15`), so `spec` must be added as a new optional property; pre-existing proposals without it still validate.

### D-3: A2 — decline-with-feedback and re-proposal
- **Decision:** Add `pair-loop --revise-test <n> --note "<text>"` to record a per-test revision note against the current proposal; on the next run of that task's proposal, prior notes for still-unwritten tests are fed into `proposalPrompt` so the re-proposal accounts for them. Bare `--approve-tests` semantics are unchanged.
- **Why:** Today declining only excludes a test (`applyTestApproval`, `pair-task:2563-2584`); the driver wants to steer a test toward a leaner form, not just drop it. A dedicated flag is explicit and scriptable, and avoids overloading `--approve-tests`.
- **Consequences:** The proposal record (`.pair/test-proposal.json`, `pair-task:2529`) gains a per-test `feedback` note; notes are bound to the task ID + plan digest exactly as the proposal is (invalidated on digest mismatch, `pair-task:2534-2538`) and cleared when the task changes. `--revise-test` with no current proposal for the task is an explicit error, not a silent no-op.

### D-4: B1 — reviewer-verdict gate with recorded override
- **Decision:** Add opt-in `--review-gate` (`PAIR_REVIEW_GATE=1`). When an independent review produces a verdict with findings, Pair writes the review evidence and then pauses at a boundary before `classifyOutcome` acts (`pair-task:3454`), surfacing the findings. The human acts through an explicit resume surface: `pair-loop --review-decision approve` proceeds as the reviewer recommended; `pair-loop --review-decision override --action <action> --reason "<text>"` applies a different action drawn from the coordinator's existing outcome-action set (no new actions are invented). Either way an entry `{task_id, attempt_id, verdict_digest, reviewer_recommended_action, human_decision, override_reason}` is appended to `.pair/review-ledger.jsonl` for later pattern-mining. An override never bypasses verification.
- **Why:** No gate exists today between the reviewer's verdict and the coordinator acting on it (`assessAttempt` runs verdict → classify → write → transition synchronously, `pair-task:3454/3483/3556`), and `--advisory-review` does the opposite. The driver is "not always happy with the reviewer" and needs to collect the reviewer-vs-human divergence to improve the review prompt. Override with a recorded reason mirrors the existing `--approve-plan` human-override provenance pattern, so it does not weaken the integrity model.
- **Consequences:** This is the only change touching the review→action transition; it reuses the existing pause/blocked and review-evidence machinery. The ledger is append-only and secret-safe (no prompts/transcripts/reasoning). Highest-risk item.

### D-5: B2 — plan-review blocker calibration
- **Decision:** Refine the plan-challenge reviewer policy (`skills/pair-v3/scripts/pair-plan-challenge:176`; companion prose at `skills/pair-v4/SKILL.md:110`) so a cross-task ordering conflict the coordinator can resolve without a plan or spec change is **not reported as a finding at all** — noted at most in the review summary. BLOCKER stays reserved for findings needing a plan/spec/human decision.
- **Why:** The severity taxonomy is BLOCKER/MAJOR only (verdict validator, `pair-plan-challenge:233`) and the policy approves only with an empty findings array (`:176`) — there is no "advisory" severity, and even a MAJOR finding forces a fix-needed verdict. So downgrading severity cannot unstall the loop; the only fix that does not fork the verdict contract is to exclude coordinator-resolvable ordering conflicts from findings. Today such conflicts (e.g., Task 1 vs Task 10) are escalated to BLOCKER, stalling the loop on non-issues.
- **Consequences:** A documented exclusion rule (what counts as coordinator-resolvable) accompanies the prompt refinement; no schema, validator, or verdict-logic change.

### D-6: B3 — reviewer visibility as in-repo data
- **Decision:** Add `pair-loop --review-status [--json]` that prints a clean structured summary (kind, verdict, findings, origin) of the latest review evidence. Review evidence is split across three files, all covered: `.pair/review.json` (slice review, written by `writeReviewFiles`, `pair-task:2059-2066`), `.pair/plan-review.json` (plan challenge, `pair-plan-challenge:707-711`), and `.pair/final-review.json` (cumulative review, `pair-task:2207/2246`). Pane cosmetics are out of scope.
- **Why:** The reviewer tmux pane is opaque, but its presentation is owned by the external dotfiles repo (see Constraints). Exposing clean data in-repo is the part this Work can own; a pane widget it cannot maintain fails the deletion test.
- **Consequences:** Dotfiles may later wire the pane to this command; that wiring is not part of this Work.

### D-7: C1 — additive per-slice custom verification
- **Decision:** Allow an optional `extra-verify:` command per task in the plan (parsed in `skills/pair-v3/scripts/lib/pair-core.js`, near the existing `verify:` regex at line 97), executed additively inside `verify()` (`pair-task:1347`) after whichever primary applied — the task's `verify:` (branch `:1384-1396`) or the `.pair/verify.sh` fallback (branch `:1398-1417`) — and required to pass for the slice to be accepted.
- **Why:** Per-task verification today is the single `verify:` command, or the repo-wide `.pair/verify.sh` only when a task declares no `verify:`; there is no way to attach an extra slice-specific check on top. Reuses `runVerificationCommand` (`pair-task:1062`).
- **Consequences:** A task with a failing `extra-verify` cannot be accepted even if the primary `verify` passes; the field is optional so existing plans are unaffected.

### D-8: D1 — lifecycle documentation correctness
- **Decision:** Correct the Canonical Lifecycle diagram in `skills/pair-v4/SKILL.md` so the `blocked` row (`SKILL.md:41`, currently `material decision/hard boundary ─────→ blocked` with no source phase) names `verifying` and `reviewing` as its entry phases. The `any active phase ── pause boundary ──→ paused` row (`SKILL.md:39`) describes pause, not blocking, and stays as is.
- **Why:** The only attempt-phase transition to `blocked` is inside `assessAttempt` (`pair-task:3552-3556` via `resumePhase`), reached only from the `verifying`/`reviewing` phases: the reducer enters `verifying` (`:3279`) unless it resumes a prior `reviewing` phase that already holds verification results (`resumesReview`, `:3275-3277`), and `requiresMaterialDecision` is computed at `:3545-3550`. The other `status: "blocked"` sites (`:1014`, `:3709`, `:4010`) are worker-result records, not phase transitions. The diagram's unsourced `blocked` arrow implies any phase can block, which is misleading.
- **Consequences:** Documentation-only; no behavior change.

### D-9: C2 — on-the-fly additive verification and doer-immutable verification inputs
- **Decision:** Add `pair-loop --add-verify "<command>" [--task <id>]`, which appends `{command, task_id?, added_at, source}` to a new human-owned store `.pair/extra-verify.json`. `verify()` (`pair-task:1347`) executes matching store commands additively after the primary verification — task-scoped entries for their task only, unscoped entries for every task — each required to pass for the slice to be accepted; `finalVerificationCommands` (`pair-task:2172-2184`) merges store commands into the final gate. In the same decision, verification inputs become doer-immutable: `.pair/verify.sh` and `.pair/extra-verify.json` join the hard ownership boundaries in `verifyOwnership` (`pair-task:1313-1325`), so a doer edit fails verification instead of producing the current pass-through warning (`pair-task:1357-1360`) — except when `.pair/verify.sh` is explicitly declared in the task's files.
- **Why:** The only mid-run lever today is editing `.pair/verify.sh`, which is re-read at each verification but per-slice fallback-only (`pair-task:1398-1417`), unscoped, and doer-editable with only a warning while the final gate always executes it (`:2179-2181`). Mid-run plan edits are digest-destructive: test proposals are discarded on digest mismatch (`:2534-2538`) and routing history is keyed by `planDigest` (`:690-698`). A digest-safe runtime store takes effect at the next verification without pausing the loop; protecting it (and `verify.sh`) from the doer is what makes an on-the-fly instruction trustworthy.
- **Consequences:** An absent or empty store leaves behavior byte-identical, so the capability is inherently opt-in (D-1) without a flag. The store holds commands and provenance metadata only — never prompts, transcripts, or secrets. It must not be added to `isPairRuntimeArtifact` (`pair-task:112-131`), so doer edits stay visible to ownership, and it is added to `REVIEWABLE_PAIR_FILES` (`review-snapshot.js:6-10`) so reviewers see it. Complements D-7: plan-time (`extra-verify:`) and runtime (`--add-verify`) share the additive execution path. The hard-boundary tightening is the one intentional default-behavior change in the Work (see Rejection Criteria).

## Engineering Quality Contract

- **Always-on obligations:**
  - *Intent fit:* every code change traces to a Decision (D-1…D-9) and serves the Purpose; no capability outside the approved scope.
  - *Maintainable scope:* extend existing mechanisms (`test-proposal.json`, `applyTestApproval`, `assessAttempt`, review-evidence files, plan parser, `verify()`, `verifyOwnership`, `finalVerificationCommands`); the deletion test is applied to any new module (none expected beyond the review ledger, the extra-verify store, and new flag handlers).
  - *Traceable verification:* every acceptance criterion has an exact `node --test` command and an integration test where it crosses a real loop boundary (A2, B1, C1).
  - *Independent review:* the Work is itself implemented under Pair v4 and passes its own slice and cumulative independent review.
  - *Repository security baseline:* no prompts, transcripts, private reasoning, or secrets are written to the new `.pair/review-ledger.jsonl` or any log; existing redaction is preserved.
- **Fact-activated obligations:**
  - *When the `test-proposal.json` schema changes (D-2):* existing proposals must still validate or be cleanly invalidated — owner: implementer; evidence: a schema round-trip test.
  - *When a persisted store is added (`review-ledger.jsonl` D-4, `extra-verify.json` D-9):* it must be secret-safe, and the review ledger additionally append-only — owner: implementer; evidence: redaction tests asserting no transcript/reasoning fields are written.
  - *When `--review-gate` touches the review→action transition (D-4):* verification guarantees must hold (an override records a reason and still cannot bypass verification) — owner: implementer; evidence: an integration test on the gate boundary. Exclusion authority: user.
  - *When any new flag/env is added:* a default-off run must be behaviorally unchanged — owner: implementer; evidence: a default-behavior assertion per feature.

## Acceptance Criteria

- [ ] AC-1: Under `--hitl`, a proposed test carries and displays an optional freeform technical `spec`; a proposal without it still validates.
- [ ] AC-2: `pair-loop --revise-test <n> --note "…"` records a revision note and the next proposal for that task incorporates it; bare `--approve-tests` behavior is unchanged.
- [ ] AC-3: Under `--review-gate`, a reviewer verdict with findings pauses before the coordinator acts; `--review-decision approve` proceeds as recommended, `--review-decision override --action <action> --reason "…"` applies the chosen action, and both append a secret-safe entry to `.pair/review-ledger.jsonl`; an override never bypasses verification.
- [ ] AC-4: A plan whose only defect is a coordinator-resolvable cross-task ordering conflict yields an approve verdict with an empty findings array (a summary note is permitted) under the refined plan-review policy.
- [ ] AC-5: `pair-loop --review-status [--json]` prints the latest verdict and findings across `.pair/review.json`, `.pair/plan-review.json`, and `.pair/final-review.json`, labeled by kind.
- [ ] AC-6: A task with an `extra-verify` command that fails is not accepted even when its primary `verify` passes; with no `extra-verify`, behavior is unchanged.
- [ ] AC-7: The `skills/pair-v4/SKILL.md` lifecycle diagram shows `blocked` entered from `verifying`/`reviewing`, and "any active phase" remains attached only to the pause boundary.
- [ ] AC-8: With no new flags set, an end-to-end slice run is behaviorally identical to the pre-change loop (sole intended exception: doer edits to verification inputs now fail per D-9).
- [ ] AC-9: `pair-loop --add-verify "<command>" [--task <id>]` records a provenance entry in `.pair/extra-verify.json`; the next verification of a matching task additionally runs the command and a failing command blocks acceptance; the final gate includes store commands; with an absent or empty store, behavior is unchanged.
- [ ] AC-10: A doer change to `.pair/verify.sh` or `.pair/extra-verify.json` fails slice verification as a hard ownership boundary (not a warning), unless `.pair/verify.sh` is among the task's declared files.

## Verification

### AC-1
- **Proof:** `node --test skills/pair-v3/tests/test-proposal-spec.test.js` — asserts the schema accepts a test with `spec`, `printTestProposal` output includes it, and a proposal omitting `spec` still validates.

### AC-2
- **Proof:** `node --test skills/pair-v3/tests/revise-test-feedback.integration.test.js` — records a note via the `--revise-test` path and asserts the next `proposalPrompt` for the task carries it; asserts bare `--approve-tests all|1,3|none` is unchanged.

### AC-3
- **Proof:** `node --test skills/pair-v3/tests/review-gate.integration.test.js` — with `PAIR_REVIEW_GATE=1` and a seeded finding, asserts the loop pauses before `classifyOutcome`, that `--review-decision approve` vs `--review-decision override` produce the expected next phase, that each appends the expected `review-ledger.jsonl` entry, and that no transcript/reasoning field is present in the ledger.

### AC-4
- **Proof:** `node --test skills/pair-v3/tests/plan-review-calibration.test.js` — a crafted plan whose only defect is a coordinator-resolvable cross-task ordering yields an approve verdict with an empty findings array; a plan needing a genuine plan/spec decision still yields a BLOCKER.

### AC-5
- **Proof:** `pair-loop --review-status --json` against fixtures for each of `.pair/review.json`, `.pair/plan-review.json`, and `.pair/final-review.json` returns the latest verdict+findings labeled by kind; asserted in `node --test skills/pair-v3/tests/review-status.test.js`.

### AC-6
- **Proof:** `node --test skills/pair-v3/tests/extra-verify.integration.test.js` — a task whose `extra-verify` fails is not accepted though its primary `verify` passes; a task without `extra-verify` is accepted as before.

### AC-7
- **Proof:** `node --test skills/pair-v3/tests/pair-contract-docs.test.js` (extended) — asserts the `SKILL.md` lifecycle diagram names `verifying`/`reviewing` as `blocked` predecessors and attaches "any active phase" only to the pause boundary.

### AC-8
- **Proof:** `node --test skills/pair-v3/tests/default-behavior-unchanged.integration.test.js` — an end-to-end slice with no new flags matches the pre-change transition sequence and evidence.

### AC-9
- **Proof:** `node --test skills/pair-v3/tests/extra-verify-runtime.integration.test.js` — appends a command via `--add-verify` mid-work, asserts the next `verify()` runs it additively (both task-scoped and unscoped), that a failing store command blocks acceptance, that `finalVerificationCommands` includes it, and that an absent or empty store leaves the transition sequence unchanged.

### AC-10
- **Proof:** `node --test skills/pair-v3/tests/verification-input-ownership.test.js` — a changed `.pair/verify.sh` or `.pair/extra-verify.json` outside the task's declared files yields ownership `fail` (not `warn`); with `.pair/verify.sh` declared in the task's files the same change is accepted as owned.

## Out of Scope

- The reliability family E (brainstorming checkpoint degeneration / `core_anchor` bug, `discoverLiveSession()` isolation hazard, destructive `visual-session stop`) — deferred to a separate Work.
- tmux/Neovim pane cosmetics and keymaps (owned by the external dotfiles repo).
- Any change to default, unflagged loop behavior.
- Cross-provider (Codex/Claude) review-gate behavior beyond preserving existing provider-affinity.
- Implementation-stream decomposition — owned by `pair-promote`.
- Further verification hardening assessed and deferred: disabling the worker-replay tier, structured RED-expectation matching, repeat-run flake guards, clean-room cumulative verification.
