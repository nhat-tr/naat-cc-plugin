# Spec: Pair Evidence-at-Commit Loop

- **Work ID:** `work-20260803-pair-evidence-at-commit`

## Purpose

Replace Pair v3/v4's artifact-heavy, long-lived agent loop with a token-bounded workflow that makes architecture and behavior reviewable in small immutable code checkpoints. Preserve evidence-grounded brainstorming, but judge implementation quality from current code, real call paths, observable behavior, and human-calibrated review—not from a large speculative Implementation Design Contract.

The workflow must distinguish local continuation from architectural novelty. A change within the same feature, owner, lifetime, and established proof boundary may follow the local pattern. A new class, module, owner, lifetime, public contract, persistence boundary, concurrency model, security boundary, or cross-component flow must receive explicit design scrutiny and an early vertical implementation checkpoint.

## Rejection Criteria

- No implementation path may require an Implementation Design Contract, Review Slice Execution Packet, model-generated plan promotion, or model plan challenge.
- No implementation or reviewer provider session may span more than one Review Slice or review request.
- No architecture-sensitive Work may expand through horizontal component slices before one real vertical path and its first usage are checkpointed and reviewed.
- No test label, test count, coverage value, or synthetic RED signal may substitute for proof at the boundary where the behavior can actually fail.
- No model-review finding may trigger an automatic code correction without deterministic failure evidence or explicit human acceptance of that finding.
- No raw Review Outcome history, transcript, prompt, complete patch, or unscoped Review Guidance collection may enter a future model prompt.
- No Pair runtime/specification/review artifact may be merged into the product branch by default.
- No linked-worktree deletion may delete canonical local Pair state or reachable review evidence.

## Contrasts

- Not a smaller Implementation Design schema: the mandatory contract and its compiler are removed.
- Not a shorter warm conversation: implementation and review use fresh bounded sessions.
- Not blanket TDD: each Review Slice requires a risk-appropriate failure proof, which may be unit, integration, end-to-end, runtime, or manual evidence.
- Not review-until-approved: model review is conditional, precision-first, and never an autonomous repair loop.
- Not the `work-20260802-bounded-review-learning` two-round design: this Work replaces its preserved plan-review, warm-coordinator, automatic-correction, and universal-guidance assumptions while retaining immutable Review Outcomes and explicit Review Feedback.
- Not fully autonomous architecture: the human reviews the first architecture-bearing checkpoint while it is still small.

## Constraints

- The approved canonical Work specification remains the intent authority. Later agents receive only the Acceptance Criteria and constraints relevant to their current Review Slice.
- Pair owns a dedicated linked worktree and branch. Repository-local Pair state lives under the Git common directory; reviewed commits remain reachable through local `refs/pair/*` references.
- Pair worktree creation never eagerly installs dependencies or initializes every submodule. Hydration occurs only before a command that needs it, uses repository-native caches keyed by lockfile/runtime/platform, never directly shares mutable `node_modules`, and initializes only required submodules.
- Every implementation and review invocation starts fresh. Resume state contains identifiers, Git references, phase, and next action—not prior prose.
- Routing is based on observed intent and diff facts. An unknown fact takes the architecture-sensitive path.
- The architecture-sensitive path activates for new ownership or lifetime, mutable shared state, DI registration, public API, schema or migration, background processing, concurrency, caching, transactions, retry/failure ownership, security, or a cross-component boundary.
- The routine path is allowed only inside an existing feature and owner with no new lifetime/public/persistence/concurrency behavior and with an established high-fidelity proof boundary. Post-diff inspection may escalate it before acceptance.
- Existing repository code is evidence, not authority. Reuse requires matching responsibility, ownership, lifetime, failure behavior, and concurrency assumptions; same-feature local consistency remains the default when those facts match.
- Approval output contains no narrative. Findings are bounded and evidence-gated. Historical review material is retrieved only for explicit inspection or offline evaluation.
- Pair records per-invocation input, cached-input, output, duration, model, route, result, and Review Slice identity without storing transcripts, prompts, reasoning, secrets, or environment values.
- Local Pair history intentionally ends when the entire repository clone is deleted; no default remote synchronization or external backup is required.
- The provisional phrases “architecture-sensitive path,” “routine path,” “pre-code design check,” and “failure proof” are not yet canonical terms in `UBIQUITOUS_LANGUAGE.md`; glossary alignment is required before they name implementation APIs or persisted fields.

## Evidence

- Paragon Work `work-20260801-nl-catalog-search` recorded 71 coordinator telemetry deltas totaling 123,246,518 input tokens, including 120,877,979 cached input tokens and 273,341 output tokens; reviewer usage was unmeasured.
- That Work generated seven complete Implementation Design revisions totaling 371,051 bytes, ten Execution Packets totaling 97,265 bytes, and a 2,043,763-byte journal for 280 events.
- Nine Review Slices were accepted with zero findings before the final real-Program proof. That final slice then produced repeated verification-defect outcomes and remained incomplete.
- `skills/pair-v3/scripts/lib/implementation-design.js` permits a 128 KiB contract, requires sixteen fields per decision, and requires non-empty pattern references and tests.
- `skills/pair-v3/scripts/pair-task` injects the compiled packet into the visible coordinator and currently makes every task non-delegable; Pair v4 also reuses one Review Session.
- `skills/pair-v3/scripts/pair-plan-challenge` instructs its reviewer to treat supported Implementation Design decisions as approved rather than independently judging their architecture.
- Google code-review guidance identifies overall design as the most important review concern, recommends small self-contained changes with a new API's first usage, and requires human judgment that tests actually fail when behavior breaks.
- OpenAI's CriticGPT results expose a precision/recall tradeoff in model critique and report fewer hallucinated bugs when a human uses the critic than when the critic acts alone.
- Anthropic recommends simple composable agent workflows, outcome-based evaluation, and combined deterministic, model, and human graders with token usage tracked as an explicit metric.

## Decisions

### D-1: Collapse the pre-implementation artifact chain

- **Decision:** Keep the approved specification and a minimal ordered Review Slice manifest containing only stable ID, mapped Acceptance Criteria IDs, intended outcome, dependency IDs, and verification entrypoint. Remove Implementation Design Contracts, Execution Packets, promotion evidence revisions, and model plan challenges.
- **Why:** The current artifacts duplicate intent and repository forecasts without proving that the eventual architecture or tests are good.
- **Consequences:** Detailed design becomes just-in-time and evidence-grounded. The manifest is navigation, not architecture authority.

### D-2: Route by architectural facts

- **Decision:** Evaluate routing before implementation and again against the checkpoint diff. Architecture-sensitive facts require a one-screen pre-code design check and human review of the first code checkpoint. Routine local changes may proceed with deterministic proof and conditional review.
- **Why:** “Follow the existing pattern” is safe only when responsibility and lifecycle facts actually match.
- **Consequences:** A routine attempt that introduces a new class, owner, lifetime, boundary, or state automatically escalates before acceptance.

### D-3: Make the first architecture checkpoint vertical

- **Decision:** The first architecture-bearing Review Slice must exercise one thin real path through the production entrypoint, changed boundary, result, and first usage. Supporting horizontal capabilities follow only after this checkpoint is accepted.
- **Why:** Paragon accepted nine horizontal slices before its real-Program proof exposed integration failure. Small vertical changes expose architecture while rejection is still cheap.
- **Consequences:** Empty abstractions, unused APIs, and infrastructure-first expansion are not acceptable first checkpoints.

### D-4: Use fresh bounded agents

- **Decision:** Each Review Slice receives one fresh implementation session; each selected review receives one separate fresh reviewer session. Model prompts carry references and relevant constraints, never prior conversation history.
- **Why:** A small resume packet cannot bound a long-lived provider context.
- **Consequences:** Pair state, not model memory, provides continuity. Source must be reread selectively from the exact checkpoint.

### D-5: Replace blanket TDD with failure proof

- **Decision:** Every Review Slice declares the narrowest evidence capable of observing its actual risk. Bugs require reproduction against the base when feasible; isolated logic may use unit tests; boundaries use integration/contract proof; user-visible behavior uses end-to-end, runtime, or recorded manual evidence. High-risk assertions require a negative control or selective mutation when practical.
- **Why:** Tests are evidence only when they can detect the behavior being broken.
- **Consequences:** No separate model test-proposal phase or frozen exact-test-name contract exists. Production code and proof normally land in the same checkpoint.

### D-6: Review for precision, not finding count

- **Decision:** Review selection is driven by actual diff facts. A fresh reviewer receives only the checkpoint diff, mapped outcome, applicable design check, named contracts/callers, verification result, and narrowly relevant approved guidance. Approval is terse; at most three findings may be returned, each with a falsifiable claim, reachable failure scenario, exact commit/blob anchor, impact, and pass condition.
- **Why:** Unbounded critique increases hallucinated issues and consumes correction tokens without proportional quality.
- **Consequences:** Style, education, optional hardening, unsupported architecture preference, and speculative edges cannot block.

### D-7: Human-adjudicate model findings before repair

- **Decision:** Model findings are evidence proposals. Pair pauses and records the human disposition `valid`, `false-positive`, `not-worth-fixing`, or `missing-context`. Only a valid finding or deterministic failing proof can trigger one bounded correction; a second failure returns control to the human.
- **Why:** The current reviewer produces many low-value issues, and automatically fixing them amplifies cost and code churn.
- **Consequences:** Reviewer agreement is not acceptance authority. No two-round synthetic approval or autonomous reviewer-fix loop remains.

### D-8: Learn through an offline evaluation bank

- **Decision:** Compact Review Feedback rows reference immutable Review Outcomes and checkpoint evidence. Candidate Review Guidance is synthesized and tested offline against 20–50 representative accepted findings, false positives, missed defects, and manual escapes. Only human-approved, scope-tagged rules that improve measured reviewer performance become active; at most three relevant rules enter one review.
- **Why:** Raw accumulated history is expensive and propagates stale or incorrect lessons.
- **Consequences:** Future sessions improve through evaluated policy changes, not prompt memory. Rules may be retired when counterexamples appear.

### D-9: Keep completion deterministic and risk-triggered

- **Decision:** Every accepted checkpoint passes its declared proof. Work completion runs one cumulative deterministic verification. A fresh combined-diff model review occurs only when post-diff facts reveal an unreviewed cross-slice interaction, rebase/conflict resolution, or architecture-sensitive change—not by default.
- **Why:** Blanket cumulative model review repeats cost; never reviewing newly composed behavior leaves integration risk.
- **Consequences:** The final gate is predictable while still reacting to concrete composition changes.

### D-10: Enforce cost as a product outcome

- **Decision:** Normal routine flow permits one implementation invocation and deterministic proof; selected review adds one reviewer invocation. One automatic correction is permitted only after deterministic failure or human-accepted review evidence. Budget exhaustion pauses with the checkpoint intact. Rollout is gated by a repository eval comparing tokens, blocker precision, known-defect detection, and manual escapes against Pair v4.
- **Why:** Token efficiency cannot remain an aspirational prompt instruction.
- **Consequences:** Pair reports cost per accepted Review Slice and cannot hide retries inside a warm conversation.

## Engineering Quality Contract

- **Always-on obligations:** Preserve approved intent; prefer readable direct code over speculative abstractions; keep Pair lifecycle state below the model-context layer; bind review evidence to immutable Git objects; use deterministic verification where ground truth exists; keep stored evidence secret-safe; and measure tokens, review precision, escaped defects, and human rework per accepted Review Slice.
- **Fact-activated obligations:** Git common-directory writes activate atomic-ref, concurrency, GC-retention, permission, and mirror-push safety tests—owner: Pair infrastructure; fresh provider processes activate cancellation, timeout, session-isolation, and telemetry tests—owner: Pair runtime; dependency hydration activates lockfile fingerprint, cache-isolation, submodule, native-addon, and cleanup tests—owner: worktree infrastructure; architecture routing activates false-routine and post-diff-escalation tests—owner: Pair policy; review learning activates redaction, scope retrieval, counterexample, and offline-eval regression tests—owner: review policy. The user is exclusion authority for ordinary obligations; repository security requirements cannot be excluded.

## Acceptance Criteria

- [ ] AC-1: Pair can open and execute approved Work using only the canonical specification plus a minimal Review Slice manifest; no Implementation Design Contract, Execution Packet, promotion revision, or plan-challenge approval is read or produced.
- [ ] AC-2: Each implementation and model review uses a fresh provider session scoped to exactly one Review Slice or review request, and its initial prompt contains no prior transcript or raw Review Outcome history.
- [ ] AC-3: Any intended or actual change involving a new owner/lifetime, mutable shared state, DI registration, public contract, schema/migration, background process, concurrency, cache, transaction/retry ownership, security boundary, or cross-component flow routes to the architecture-sensitive path before acceptance.
- [ ] AC-4: A change may use the routine path only when it stays within the same feature and owner, introduces none of AC-3's facts, and has an established high-fidelity proof boundary; post-diff routing escalates any violated condition.
- [ ] AC-5: Architecture-sensitive Work checkpoints one thin production path and its first real usage before later horizontal capability slices can be accepted.
- [ ] AC-6: When an implementation reuses an existing pattern, its design evidence states why responsibility, ownership, lifetime, failure behavior, and concurrency assumptions match; mismatched or merely nearby precedent cannot justify reuse.
- [ ] AC-7: Every accepted Review Slice carries a failure proof appropriate to its real boundary, and the proof demonstrates detection of broken behavior through a base failure, negative control, mutation, or equivalent observed evidence when feasible.
- [ ] AC-8: A selected fresh reviewer sees only bounded checkpoint evidence; approval contains no narrative, and no verdict contains more than three findings or a finding without claim, reachable scenario, immutable evidence anchor, impact, and pass condition.
- [ ] AC-9: A model finding alone never modifies code or blocks acceptance automatically; Pair records a human disposition first, and no evidence-triggered correction receives more than one automatic attempt.
- [ ] AC-10: Review Feedback remains compact and absent from runtime prompts; Review Guidance becomes active only after offline evaluation on 20–50 representative cases and explicit human approval, and one review receives at most three scope-relevant rules.
- [ ] AC-11: Removing a linked Pair worktree deletes only its checkout/materialized dependencies; the Work specification, bounded state, checkpoint commits, and Review Outcomes remain available from the repository common Git directory, while deleting the repository intentionally removes them.
- [ ] AC-12: On the repository evaluation bank, Pair vNext catches every retained known blocker/manual escape, reaches at least 60% human-accepted precision for blocking findings, and uses at most 50% of Pair v4's median total input tokens per accepted case; results include uncached/cached input, output, attempts, duration, and human rework.
- [ ] AC-13: Work completion runs cumulative deterministic verification and invokes a combined-diff model review only for evidenced unreviewed composition, rebase/conflict, or architecture-sensitive facts.
- [ ] AC-14: Pair runtime events contain small references and deltas rather than copied attempt snapshots, prompts, patches, verification logs, or Review Outcomes, and status can be rebuilt without a multi-megabyte append-only journal for a ten-slice Work.

## Verification

### AC-1
- **Proof:** `npm run test:pair` includes a canonical-spec fixture that reaches the first Review Slice while the Implementation Design and Execution Packet paths are absent and asserts that no promotion or plan-review model request occurs.

### AC-2
- **Proof:** Provider-spawn integration fixtures record distinct session identities for two implementation slices and two reviews and assert that each captured initial request contains only its bounded current-slice envelope.

### AC-3
- **Proof:** Fact-router tests cover every listed architecture-sensitive fact before implementation and again from representative checkpoint diffs.

### AC-4
- **Proof:** Routine-route fixtures prove a same-feature local edit remains routine while new DI, class ownership, public API, persistence, and concurrency diffs are escalated.

### AC-5
- **Proof:** A Paragon-shaped fixture rejects a manifest that schedules store/crawler/matcher slices before the first real entrypoint-to-result path and accepts the vertical-first ordering.

### AC-6
- **Proof:** Design-check validation accepts a same-responsibility/lifetime precedent and rejects a pattern reference that matches only by location or type shape.

### AC-7
- **Proof:** Proof-gate fixtures cover a base-reproduced bug, isolated unit behavior, integration boundary, user-visible end-to-end path, and a test that passes despite a broken negative control and is therefore rejected.

### AC-8
- **Proof:** Reviewer-contract tests assert fresh bounded input, terse approval, three-finding maximum, immutable anchors, and rejection of style, speculative, anchorless, or pass-condition-free findings.

### AC-9
- **Proof:** Review-lifecycle integration tests prove that an unadjudicated finding cannot dispatch a correction, every human disposition is preserved, one valid correction may run, and a second failure pauses without another model call.

### AC-10
- **Proof:** Review-learning tests build an evaluation bank from compact feedback references, reject fewer than 20 or more than 50 selected cases, compare baseline and candidate precision/escape/token metrics, require explicit approval, and inject no more than three relevant active rules.

### AC-11
- **Proof:** A real temporary Git repository creates two linked worktrees, records local Pair state and review refs, removes the Pair worktree, and proves the state and reviewed commit remain reachable; dependency fixtures prove lazy isolated hydration and targeted submodule initialization.

### AC-12
- **Proof:** The evaluation harness replays 20–50 frozen repository cases through Pair v4 and Pair vNext trials and publishes per-case and aggregate token, precision, known-defect, duration, attempt, and human-rework results; default migration remains blocked unless every threshold passes.

### AC-13
- **Proof:** Completion integration tests show deterministic success with no model review for an already-reviewed composition and require one fresh review after a rebase conflict or newly detected cross-slice architecture fact.

### AC-14
- **Proof:** A ten-slice lifecycle fixture asserts events contain references/deltas only, state rebuild is deterministic, prohibited bulk fields are absent, and total journal size remains within the fixture's explicit bounded threshold.

## Out of Scope

- Training or fine-tuning provider models.
- Global or cross-repository Review Guidance.
- Remote backup of local Pair history.
- Automatically migrating or preserving every Pair v3/v4 runtime artifact.
- Building the Neovim presentation layer in this Work.
- Language-specific architecture rules beyond fact routing and repository-local guidance.
