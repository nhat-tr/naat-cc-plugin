# DR-003: Bounded resume checkpoint without cache pings

- **Schema:** 1
- **Status:** accepted
- **Work ID:** `work-20260719-pair-loop-observable-control`
- **Origin Spec:** `docs/work/work-20260719-pair-loop-observable-control/spec.md`
- **Acceptance Criteria:** AC-3, AC-5, AC-9, AC-10, AC-12, AC-14
- **Supersedes:** none
- **Superseded By:** none

## Context

Pause and manual edits need a compact recovery contract, but same-session resume can cause the provider to restore conversation history whose token cost Pair cannot control. Codex exposes cached-input telemetry but no supported cache-retention setting. Periodic model pings would spend requests and tokens without guaranteeing that a later resume remains cached.

## Decision

Use an 8,192-byte Pair-authored Resume Checkpoint, resume the same runtime session by default, measure the first resumed turn, and never send automatic cache-warming pings.

- The deterministic JSON checkpoint is capped at 8,192 UTF-8 bytes before dispatch.
- It contains only Work, runtime, role, phase, session, and attempt identity; plan and patch digests; the exact resume target; one next action capped at 512 bytes; and bounded Acceptance Criterion and finding ID lists.
- Plans, patches, diffs, logs, evidence bodies, and transcripts remain outside the prompt behind repository-relative paths and SHA-256 digests.
- After the first resumed turn, Pair records checkpoint bytes, input tokens, cached input, uncached input, cache-hit ratio, output and reasoning tokens when exposed, and the delta from the prior three turns for the same runtime, role, and phase.
- Pair warns when uncached resumed input exceeds twice that prior three-turn median. Missing telemetry is reported as unknown, never efficient.
- The warning is observable and non-blocking because provider cache eviction is outside Pair's correctness boundary.
- Plan edits send the semantic diff, prior findings, and new digest to closure review. Code edits reference the complete patch artifact and affected Acceptance Criteria rather than embedding the patch or transcript.

## Rationale

The byte cap gives Pair a hard bound over the only input it owns while same-session resume preserves continuity. Post-turn measurement exposes actual cached and uncached cost without pretending to control provider-restored history. Avoiding pings removes recurring spend, rate-limit pressure, and a false cache-liveness guarantee.

## Alternatives Rejected

- **Fresh phase session from the checkpoint every time (6/10):** provides a more predictable total-input boundary but loses same-session continuity and is unnecessary as the default.
- **Measured optional cache-ping experiment (5/10):** can be evaluated later but adds requests before evidence shows a net saving.
- **Automatic periodic cache ping (3/10):** spends tokens and rate limits without a supported cache-retention guarantee.
- **Full transcript restart (2/10):** creates unbounded Pair-authored input and duplicates durable repository evidence.
- **Hard token correctness gate (4/10):** could stop correct Work solely because the provider cache cooled.

## Consequences

- Checkpoint serialization and byte-size validation happen before resume dispatch; an oversized checkpoint is a deterministic validation error, not a model failure.
- The repository stores only secret-safe usage totals and digest/path references, never raw prompts, transcripts, credentials, environment values, or capability tokens.
- Status and report distinguish Pair-authored checkpoint size from provider-restored input and total billed input.
- A fresh phase session remains an explicit fallback when the user requires a predictable total-input bound or the original runtime session is unavailable.
- Token-efficiency regressions create visible audit evidence but do not invalidate verification or independent review.

## Evidence

- Approved Architecture Canvas Revision: `57462d46`
- Codex CLI exposes `cached_input_tokens` but no cache-retention flag
- Current Pair telemetry captures input, cached input, output, and reasoning tokens for Codex and Claude and aggregates them in `pair-report`
- OpenAI prompt-cache behavior is provider-owned and cannot be used as a process-liveness contract
- Canonical security criterion: `docs/work/work-20260719-pair-loop-observable-control/spec.md#ac-12`

## Implementation

- Base: not started
- Changes: not started

## Outcomes

None yet.

## Learning

A bounded Resume Checkpoint controls only new Pair-authored context. Total resumed input remains observable provider behavior, not a hard budget Pair can promise.
