# Spec: Bounded Pair Review Learning

- **Work ID:** `work-20260802-bounded-review-learning`

## Purpose

Pair v4 must produce bounded, useful review evidence without open-ended token burn. Each Review Slice gets at most two review rounds: round 1 may trigger one visible-coordinator correction; round 2 is persisted without further automatic correction.

All Review Outcomes must remain available for later human review. Curated Review Feedback must become compact, repository-local Review Guidance only after explicit human approval, improving future reviews without injecting raw history.

## Rejection Criteria

- No Review Slice may trigger more than two model review requests, including failed reviewer requests.
- Round-2 findings must never trigger automatic correction or block acceptance after deterministic verification passes.
- Unapproved Review Feedback, raw review history, prompts, transcripts, or private reasoning must never enter future reviewer prompts.
- The human workflow must not require remembering backend CLI syntax.

## Contrasts

- Not review-until-approved, because review cost must be deterministic.
- Not removal of independent review, because material findings remain useful evidence.
- Not opaque model memory, because every learned rule must be repository-local, attributable, bounded, and human-approved.
- Not a cross-repository implementation attempt, because the engine and Neovim adapter require separate Work ownership.

## Constraints

- Preserve the existing Review Slice, Work ID, Work event journal, exact-phase pause/resume, deterministic verification, and review-policy selection contracts.
- Keep the independent plan review unchanged.
- Remove the cumulative AI review while preserving cumulative deterministic verification.
- Treat every attempted model review request as one round, including invalid output and infrastructure failure.
- Run round 2 only when round 1 produced a fixable implementation finding and the corrected patch passes deterministic verification.
- Keep reviewer-origin plan and environment findings as evidence; they do not create an automatic correction loop.
- Use Node.js built-ins and the repository's existing `node:test` infrastructure; add no runtime dependency.
- Expose a versioned, strict JSON backend contract for the Neovim adapter.
- Keep at most 20 active Review Guidance rules and at most 4,096 compact UTF-8 bytes in a reviewer prompt.
- Store raw Review Outcomes and Review Feedback in repository-local Pair authority; never place them in the prompt wholesale.

## Decisions

### D-1: Two-round Review Slice lifecycle

- **Decision:** A policy-selected Review Slice receives round 1 after GREEN verification. A clean round 1 accepts the slice immediately. Fixable implementation findings produce exactly one correction brief; after the corrected patch passes deterministic verification, round 2 reviews that patch and is evidence-only.
- **Why:** This retains one useful correction opportunity while creating a hard, observable upper cost bound.
- **Consequences:** Round-2 findings remain pending for later human adjudication. Anchor sampling and cumulative AI review cannot add hidden review requests in Pair v4.

### D-2: Review Outcome identity and inbox

- **Decision:** Persist one immutable `review.completed` event per request with a stable Review Outcome ID, Work ID, Review Slice ID, attempt ID, round, patch digest, reviewer identity, usage, verdict, and stable finding IDs.
- **Why:** Existing `attempt.completed` evidence is durable but does not expose every round as an independently addressable human-review item.
- **Consequences:** A read-only backend can derive pending and complete inbox projections across every Work without duplicating lifecycle authority.

### D-3: Human Review Feedback

- **Decision:** Record judgments `useful`, `false-positive`, `unclear`, and `missed` as append-only `review-feedback.recorded` events bound to a Review Outcome or finding ID.
- **Why:** Structured judgments are manageable and attributable; a required human reason supplies the semantic evidence needed for learning.
- **Consequences:** Feedback never rewrites historical Review Outcomes. A missed issue may target the Review Outcome when no finding exists.

### D-4: Human-approved Review Guidance

- **Decision:** An on-demand, provider-affine agent request consumes at most eight unlearned Review Feedback events plus the active guidance and emits a strict bounded proposal. The human may edit, approve, or reject it. Only approved rules become active.
- **Why:** Agent-assisted synthesis makes the process easy while explicit approval prevents bad feedback from silently changing future behavior.
- **Consequences:** Guidance has stable IDs, source feedback IDs, active/retired status, and an append-only decision history. Oversized proposals fail before approval.

### D-5: Repository-local management backend

- **Decision:** Add a focused `pair-review` backend with strict JSON output for inbox listing, detail, feedback recording, guidance proposal, approval/rejection, and current guidance. The Neovim adapter is the primary human surface.
- **Why:** A separate deep module keeps review-learning behavior out of the already-large Pair lifecycle CLI while remaining scriptable and testable.
- **Consequences:** Humans do not need to memorize the backend commands; the contract remains available for automation and headless tests.

### D-6: Persistent optional pause boundaries

- **Decision:** Persist `off`, `review`, `task`, or `both` in repository-local Pair settings. Review pauses occur after evidence persistence and before correction or acceptance; task pauses occur after acceptance and before the next Review Slice. Adjacent round-2 and task pauses coalesce.
- **Why:** Existing exact-phase pause/resume already provides the lifecycle mechanism.
- **Consequences:** `off` remains autonomous. Resuming continues the saved transition without rerunning the reviewer.

### D-7: Completion without cumulative AI review

- **Decision:** When the final Review Slice is accepted, run cumulative deterministic verification and complete the Work without a cumulative model review.
- **Why:** Review Slice evidence is already bounded and addressable; the final model pass duplicates review cost without producing trusted outcomes.
- **Consequences:** Deterministic failures remain blocking. Pending round-2 findings remain visible in the Review Inbox after Work completion.

## Engineering Quality Contract

- **Always-on obligations:** Preserve approved intent; keep changes readable and repository-bounded; use tests-first implementation; retain strict schema validation, deterministic verification, independent Review Slice review, secret-safe evidence, and exact lifecycle recovery.
- **Fact-activated obligations:** New persisted review events require atomic append, stable identity, schema validation, symlink resistance, and migration-safe reducer tests. New model input requires injection-safe serialization and hard byte/count bounds. Removing cumulative AI review requires integration proof that cumulative deterministic verification still gates Work completion. The cross-repository JSON contract requires versioned fixtures consumed by both Work units.

## Acceptance Criteria

- [ ] AC-1: Every policy-selected Review Slice performs at most two model review requests, counting invalid or failed requests.
- [ ] AC-2: Round 1 either accepts a clean slice or produces at most one correction brief from fixable implementation findings.
- [ ] AC-3: Round 2 runs only after a round-1 correction passes deterministic verification, and its findings are persisted without correction or acceptance blocking.
- [ ] AC-4: Each review request and finding has a stable addressable identity and appears in pending/all inbox projections after process restart.
- [ ] AC-5: Human Review Feedback is append-only, reasoned, bound to an existing Review Outcome or finding, and never mutates historical evidence.
- [ ] AC-6: One on-demand learning request processes at most eight pending feedback entries and cannot activate guidance without explicit human approval.
- [ ] AC-7: Future reviewer prompts contain only active approved Review Guidance, capped at 20 rules and 4,096 UTF-8 bytes.
- [ ] AC-8: Repository pause mode supports off, review, task, and both; resume never reruns a completed review and adjacent round-2/task pauses coalesce.
- [ ] AC-9: Work completion retains cumulative deterministic verification but performs no cumulative or anchor model review in Pair v4.
- [ ] AC-10: The versioned JSON backend supports the Neovim Review Inbox and returns strict, secret-safe errors without raw model output.
- [ ] AC-11: The repository vocabulary defines Review Outcome, Review Feedback, and Review Guidance consistently with Work and Review Slice lineage.

## Verification

### AC-1

- **Proof:** `node --test skills/pair-v3/tests/review-rounds.test.js` proves request counting across approval, finding, invalid-output, and infrastructure-failure paths.

### AC-2

- **Proof:** `node --test skills/pair-v3/tests/review-rounds.test.js` proves one round-1 correction brief and no second correction dispatch.

### AC-3

- **Proof:** `node --test skills/pair-v3/tests/review-rounds.integration.test.js` proves GREEN → round 1 → correction → GREEN → round 2 → accepted, with round-2 findings preserved.

### AC-4

- **Proof:** `node --test skills/pair-v3/tests/review-inbox.test.js` restarts the projection and resolves stable Review Outcome and finding IDs across Work runs.

### AC-5

- **Proof:** `node --test skills/pair-v3/tests/review-feedback.test.js` rejects unknown IDs, missing reasons, duplicate/conflicting judgments, malformed events, and mutation of earlier evidence.

### AC-6

- **Proof:** `node --test skills/pair-v3/tests/review-learning.integration.test.js` proves the eight-feedback input cap, strict proposal schema, editable proposal, and explicit approval gate.

### AC-7

- **Proof:** `node --test skills/pair-v3/tests/review-guidance.test.js` proves only approved active rules enter the review prompt and enforces both count and UTF-8 byte limits.

### AC-8

- **Proof:** `node --test skills/pair-v3/tests/loop-modes.test.js` proves each persisted pause mode, exact resume targets, and boundary coalescing.

### AC-9

- **Proof:** `node --test skills/pair-v3/tests/review-rounds.integration.test.js` proves final deterministic failure blocks completion and final deterministic success completes without another model invocation.

### AC-10

- **Proof:** `node --test skills/pair-v3/tests/pair-review-cli.integration.test.js` validates every JSON operation, schema version, exit status, and redaction boundary.

### AC-11

- **Proof:** `node scripts/ci/validate-global-instructions.js && npm run test:pair` validates generated documentation alignment and the full Pair suite.

## Out of Scope

- Training or fine-tuning provider models.
- Global or cross-repository Review Guidance.
- Automatic activation of unreviewed guidance.
- Replacing deterministic verification, plan review, Work lineage, or security/ownership gates.
- Implementing Neovim UI inside this repository.

