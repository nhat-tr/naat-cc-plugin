# Spec: Pair Loop — Visible, Resumable, Repository-Centered Control

- **Work ID:** `work-20260719-pair-loop-observable-control`
- **Status:** Design approved through the Architecture Canvas decisions

## Purpose

Pair becomes an observable, repository-centered execution loop that completes approved Work without repeated pushes. The user can see the current phase, changed files, verification evidence, review outcome, recovery action, and latest attempt from the active chat and from repository-local status.

The redesign removes bookkeeping as a source of false failure. Process exit, session exit, a verification-launch interruption, or a file outside a Review Slice's expected files does not by itself invalidate implementation. Pair preserves useful work, resumes the exact actionable phase, and asks the user only for a material decision, an explicit pause, or a genuinely unrecoverable blocker.

## Rejection Criteria

- Ordinary implementation remains opaque because a headless worker is still the default.
- A changed repository file outside a Review Slice's expected files automatically invalidates an attempt, restores files, or prevents otherwise acceptable Work from advancing.
- Pair returns control merely because a task command, verification phase, review phase, status command, or agent process ended while approved Work remains actionable.
- Diagnosing the latest attempt depends on finding or writing an external home-directory ledger or scratch artifact.
- A resumable or green attempt becomes an `interrupted` or unstable-environment failure solely because a process or chat session ended.
- Status, doctor, report, retry budgets, plan progress, and continuation hooks can disagree because they independently interpret runtime records.

## Contrasts

- This is not continuous headless implementation; the active chat is the visible coordinator by default.
- This does not remove ownership evidence; expected, cross-slice, and unmapped changes remain explicit and reviewable.
- This is not prompt-only persistence; deterministic repository state and runtime-native continuation adapters enforce resumability.

## Constraints

- Preserve the approved Work specification, Review Slice identity, independent verification, independent review, and the Engineering Quality Contract.
- Keep canonical semantic lineage Git-trackable under `docs/work/<work-id>/`; keep mutable runtime records Git-ignored under `.pair/`.
- Use Node.js built-ins already available in the repository. `package.json` provides the required test and validation commands; no new runtime dependency is justified.
- Reuse and deepen `skills/pair-v3/scripts/review-index.cjs`, which already represents `expected_files`, `cross_slice_changes`, and `unmapped_changes`.
- Keep raw prompts, private reasoning, environment values, credentials, and capability tokens out of status, events, review packets, and automatically displayed logs.
- Create private runtime directories with mode `0700` and files with mode `0600`; use atomic replacement for projections and serialized appends for events.
- Treat the continuation hook as a guardrail. Correct recovery must still work when hooks are absent, disabled, rejected by a runtime, or invoked from another chat.
- Preserve unrelated dirty work and never restore user changes automatically.
- Preserve existing CLI entry points during migration. Legacy ceremony flags may become compatibility aliases, but bare `pair-loop` is the canonical state-aware command.

## Evidence

### Repository behavior

- `skills/pair-v3/scripts/pair-task:403-449` recovers any unchecked active attempt as interrupted before the next invocation can resume it.
- `skills/pair-v3/scripts/lib/pair-core.js:969-1005` turns repeated interruption records into an unstable-environment cap.
- `skills/pair-v3/scripts/pair-task:1071-1109` treats every changed path outside declared task files as a failing ownership result before normal verification and review can complete.
- `skills/pair-v3/scripts/pair-task:1324-1398` builds a Review Slice patch from `ownedChanged`, omitting additional changed files.
- `skills/pair-v3/scripts/pair-task:1741-1818` builds cumulative review from declared task-file unions, so additional accepted files can remain outside final review.
- `skills/pair-v3/scripts/review-index.cjs:152-220` already derives expected, cross-slice, and unmapped change attribution without forcing every path into a Review Slice.
- `skills/pair-v3/scripts/pair-task:533-566` and `skills/pair-v3/scripts/pair-report:7-22` interpret terminal history differently and read an external ledger by default.
- `hooks/stop-gate.sh:37-86` depends on a live process marker and emits one runtime's Stop response shape; `hooks/stop-gate.sh:107-142` counts checkbox changes rather than evidence progress and eventually allows stop after an unchanged count.
- `skills/pair-v3/scripts/pair-task:2511-2540` automatically delegates qualifying implementation, including work requested through the inline path.
- `npm run test:pair` currently passes all 180 tests, including assertions for the strict ownership retry and two-interruption stop. The painful behavior is encoded policy, not an unexplained flaky test.

### Observed incident

- The Paragon Work recorded five terminal completion events for Task 3.1 across two attempt IDs: two interrupted and three accepted.
- The approved plan showed Tasks 3.1 and 3.2 complete while one history reader still projected both Task 3.1 attempts as interrupted.
- The Task 3.1 verification passed directly with 12 of 12 tests, but Pair bookkeeping prevented normal acceptance and advancement.

### Runtime contract

- The current Codex hooks contract supplies a `session_id` and uses `continue: false` with `stopReason` to request continuation; the installed shell hook currently emits `decision: "block"` with `reason`.
- The Codex contract is documented in [Codex hooks](https://learn.chatgpt.com/docs/hooks.md). Runtime acceptance still requires an installed-hook integration test rather than a shell-JSON unit assertion alone.

## Decisions

### D-1: Repository-local event journal with one reducer

- **Decision:** Store each active Work under `.pair/runs/<work-id>/`: `events.jsonl` is the authoritative append-only journal; `state.json` is an atomic machine projection; `status.md` is a secret-safe human projection; and `attempts/<attempt-id>/` contains bounded summaries, verification logs, reviews, and complete patches.
- **Why:** The external ledger is hard to inspect, can be unwritable, and currently permits readers to disagree. A single reducer gives every command the same answer from the same evidence.
- **Consequences:** Status, doctor, report, budgets, plan checkboxes, orientation, and Stop adapters must consume the reducer projection. Each attempt has one effective terminal outcome; a later correction explicitly supersedes the earlier outcome instead of becoming another independently counted terminal record.

### D-2: Attempts survive processes and resume phases

- **Decision:** An attempt identity survives CLI and agent-process exits. Terminal attempt outcomes are accepted, rejected, or explicitly discarded; a concrete subprocess termination is recorded as execution evidence but leaves the attempt and its current phase resumable.
- **Why:** Process liveness is not evidence that implementation failed, and an absent completion handshake is not evidence that a green attempt was interrupted.
- **Consequences:** Bare `pair-loop` opens the next Review Slice only when none is active; otherwise it resumes implementation, verification, review, or acceptance for the existing attempt. A phase failure remains actionable with its evidence and next recovery action.

### D-3: Visible coordinator by default

- **Decision:** The active chat implements ordinary Work and narrates phase, scope, elapsed time, changed files, command results, evidence, and verdict. Headless implementation requires explicit opt-in; a bounded read-only independent reviewer may remain headless.
- **Why:** Raw byte heartbeats do not reveal what the agent is doing, and automatic delegation hides the part of the workflow the user most needs to inspect.
- **Consequences:** Pair surfaces observable actions and evidence, never private chain-of-thought. Delegated execution must identify its scope, owner, start time, latest useful evidence, and return condition in the visible coordinator.

### D-4: Expected files are advisory ownership evidence

- **Decision:** Review Slice file lists become expected files. Additional in-repository changes produce visible warnings and explicit unmapped or cross-slice attribution, but the warning itself is not a blocking finding.
- **Why:** Plans cannot perfectly predict every necessary supporting change. Existing review-index capability already represents uncertainty without erasing ownership evidence.
- **Consequences:** Verification and review receive the complete patch, including additional tracked and untracked files. Acceptance may proceed when the reviewer finds the complete patch correct. Material correctness, security, policy, or scope findings can still block on their substance.

### D-5: Keep narrow hard boundaries

- **Decision:** Hard path failures remain for Pair's mutable control state, the canonical active Work contract, credentials or policy-forbidden paths, and changes outside the repository.
- **Why:** Those paths cross real ownership or security boundaries; an ordinary additional source, test, documentation, or configuration file does not.
- **Consequences:** A hard-boundary result identifies the exact path and governing rule. It never generalizes into “all undeclared files are invalid.”

### D-6: Preserve green work across evidence-infrastructure failures

- **Decision:** Verification-launch, reviewer-runtime, hook, or reporting failures preserve the implementation and resume the failed evidence phase.
- **Why:** Evidence infrastructure failure does not invalidate already observed code or passing tests.
- **Consequences:** Automatic restoration is limited to an explicitly rejected, isolated headless attempt whose owned patch can be proven safe to discard. All other discard or restoration requires an explicit command and shows the affected paths first.

### D-7: Session-scoped continuation over durable repository state

- **Decision:** Repository state records an owner session ID only to scope automatic continuation. Runtime-specific adapters emit native Codex or Claude Stop responses for the owning chat; other chats in the same repository are allowed to stop normally.
- **Why:** Repository-wide Stop gates trap unrelated conversations, while process-owned markers become inert whenever an inline handoff ends.
- **Consequences:** `pair-loop --pause` releases continuation ownership without deleting Work state. `pair-loop --takeover` explicitly transfers ownership. Progress includes state transitions, patch changes, verification deltas, finding reduction, and new recovery evidence—not only checked-task count. Repeated failure becomes genuinely blocked only when the same evidenced cause remains after all safe in-scope recovery actions, not because a counter expired.

### D-8: Bounded legacy import and CLI compatibility

- **Decision:** On first use, import legacy history as a read-only, digested source summary with explicit conflict and incomplete-history warnings. Never require the legacy path after initialization and never rewrite or delete it.
- **Why:** Blind replay would preserve contradictory terminal records, while refusing to start when an external path is missing or unwritable recreates the current failure.
- **Consequences:** An unreadable legacy source is visible but non-blocking. Existing `--once`, `--inline`, and `--complete` entry points remain compatible aliases with deprecation guidance; they are no longer required for normal resumption or acceptance.

## Engineering Quality Contract

### Always-on obligations

- **EQC-BASE — Intent fit and maintainable scope:** Every change maps to Purpose, Rejection Criteria, a Decision, and an Acceptance Criterion; the state reducer must replace competing interpretations rather than add another layer beside them. Owner: Pair coordinator.
- **EQC-VERIFY — Traceable verification:** Tests are written failing first and include real multi-process integration coverage for every lifecycle outcome. Owner: implementation worker; independently replayed by reviewer.
- **EQC-REVIEW — Independent review:** The reviewer sees the complete patch and state evidence, including expected, cross-slice, and unmapped changes. Owner: independent reviewer.
- **EQC-SEC — Repository security baseline:** Runtime state is private, secret-safe, path-confined, and never used to overwrite unrelated dirty work. Owner: runtime owner.

### Fact-activated obligations

- **EQC-REL — Durable lifecycle:** Append-only state, atomic projections, locking, process death, retry, correction, and takeover activate crash-consistency, idempotency, and concurrency tests. Owner: runtime owner. Exclusion authority: user.
- **EQC-COMP — Compatibility and migration:** External ledgers, installed hooks, old flags, and current reports activate forward migration, unavailable-source, backout, and compatibility evidence. Owner: Pair coordinator. Exclusion authority: user.
- **EQC-BOUNDARY — Runtime adapters:** Codex and Claude Stop contracts activate installed-runtime contract tests proving correct response shape and session isolation. Owner: runtime owner. Exclusion authority: user.
- **EQC-PRIV — Stored diagnostics:** Commands, logs, patches, and status activate redaction and permission tests proving secrets, environment values, tokens, and private reasoning are absent. Owner: security reviewer. Exclusion authority: user.

## Acceptance Criteria

- [ ] AC-1: Every active Work has repository-local authoritative events, an atomic machine projection, a readable human status, and per-attempt evidence that remain usable when external home-directory state is unavailable.
- [ ] AC-2: Status, doctor, report, retry budgets, plan progress, orientation, and continuation decisions produce the same effective attempt outcomes, including when legacy history contains conflicting terminal records.
- [ ] AC-3: An inline attempt that loses its originating process resumes with the same attempt ID and preserved phase; a subsequently passing verification can be reviewed and accepted without an interruption cap.
- [ ] AC-4: Bare `pair-loop` advances actionable Work through implementation, verification, review, acceptance, and the next Review Slice without requiring `--once`, `--inline`, `--complete`, or another user push between phases.
- [ ] AC-5: Ordinary implementation runs in the visible coordinator by default and displays useful phase, scope, elapsed-time, changed-file, verification, recovery, and verdict evidence; headless implementation occurs only after explicit opt-in.
- [ ] AC-6: A changed in-repository file outside expected files produces a visible attribution warning, remains in the implementation, appears in Review Slice and cumulative patches, and can be accepted when complete-patch review finds no material defect.
- [ ] AC-7: Changes to Pair control state, the canonical active Work contract, credentials or policy-forbidden paths, or paths outside the repository stop with exact boundary evidence, while ordinary additional repository files do not.
- [ ] AC-8: Verification, reviewer, reporting, or hook infrastructure failure preserves implementation and resumes the failed evidence phase without automatic restoration.
- [ ] AC-9: Codex and Claude Stop adapters use their native contracts, auto-continue only the owning chat, allow unrelated chats to stop, and support explicit pause and takeover without losing Work state.
- [ ] AC-10: Progress recognizes phase, patch, verification, finding, and recovery-evidence changes; Pair does not stop merely after a fixed number of unchanged checkboxes and reports a genuine blocker only with an evidenced cause and exhausted safe recovery actions.
- [ ] AC-11: Legacy external history imports deterministically with source digest, conflict summary, and incomplete-history warning; missing, unreadable, or unwritable legacy storage never blocks new Work.
- [ ] AC-12: Repository-local status and artifacts use private permissions and expose no credential values, environment secrets, capability tokens, raw prompts, or private reasoning.
- [ ] AC-13: Existing Pair CLI entry points remain usable during migration, while their projections and outcomes match the canonical bare `pair-loop` lifecycle.
- [ ] AC-14: Complete Pair and repository validation passes, including integration tests that spawn separate processes for resume, hook, migration, and evidence-infrastructure recovery scenarios.

## Verification

### AC-1

- **Proof:** `node --test skills/pair-v3/tests/pair-state.integration.test.js --test-name-pattern "repository-local authoritative state"`

### AC-2

- **Proof:** `node --test skills/pair-v3/tests/pair-state.integration.test.js --test-name-pattern "one reducer projects every reader|superseding outcome"`

### AC-3

- **Proof:** `node --test skills/pair-v3/tests/pair-state.integration.test.js --test-name-pattern "resumes the same inline attempt after process exit"`

### AC-4

- **Proof:** `node --test skills/pair-v3/tests/loop-modes.test.js --test-name-pattern "bare pair-loop advances actionable Work"`

### AC-5

- **Proof:** `node --test skills/pair-v3/tests/loop-modes.test.js --test-name-pattern "visible coordinator is the default|headless implementation requires opt-in"`

### AC-6

- **Proof:** `node --test skills/pair-v3/tests/pair-task.test.js skills/pair-v3/tests/review-slice.test.js --test-name-pattern "additional file warns and remains in complete review"`

### AC-7

- **Proof:** `node --test skills/pair-v3/tests/pair-task.test.js --test-name-pattern "hard ownership boundaries remain narrow"`

### AC-8

- **Proof:** `node --test skills/pair-v3/tests/pair-state.integration.test.js --test-name-pattern "evidence infrastructure failure preserves green work"`

### AC-9

- **Proof:** `node --test skills/pair-v3/tests/stop-gate.integration.test.js --test-name-pattern "native Stop contract|owning session|pause and takeover"`

### AC-10

- **Proof:** `node --test skills/pair-v3/tests/stop-gate.integration.test.js --test-name-pattern "evidence progress|genuine blocker"`

### AC-11

- **Proof:** `node --test skills/pair-v3/tests/pair-state.integration.test.js --test-name-pattern "legacy import|external storage unavailable"`

### AC-12

- **Proof:** `node --test skills/pair-v3/tests/pair-state.integration.test.js --test-name-pattern "private permissions|secret-safe projection"`

### AC-13

- **Proof:** `node --test skills/pair-v3/tests/loop-modes.test.js --test-name-pattern "legacy flags project the canonical lifecycle"`

### AC-14

- **Proof:** `npm run test:pair && npm run validate`

## Out of Scope

- Exposing private chain-of-thought, raw prompts, or unrestricted live worker logs.
- A hosted dashboard, remote control plane, or database-backed ledger.
- Removing specifications, Review Slices, independent verification, independent review, or the Engineering Quality Contract.
- Automatically accepting a material correctness, security, policy, credential, canonical-contract, or repository-escape violation.
- Deleting or mutating legacy external ledgers during migration.
- Unlimited retries without explicit pause, takeover, discard, or an evidenced genuinely blocked state.
- Replacing Codex Plan mode; Pair remains the execution, evidence, review, and recovery protocol for approved Work.
