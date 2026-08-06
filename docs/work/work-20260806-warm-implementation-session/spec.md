# Spec: Warm Implementer, Fresh Reviewer — session continuity for Pair v4/vNext

- **Work ID:** `work-20260806-warm-implementation-session`

## Purpose

Pair v4/vNext spawns a fresh `claude -p` / `codex exec` session for every step — implementation, review, and every correction round — abandoning the implementation context each time; every spawn re-reads the codebase from zero. Across five ParagonAgent work items in 11 days this produced ≈541M cached input tokens at a ≈98.9% cache-hit rate (the same context re-sent on almost every call), with per-correction context regrowth measured at 837K → 2.77M → 5.97M cached tokens across three successive calls on one slice.

Desired: implementation of a Review Slice lives in one warm provider session that carries through the whole cycle — it implements, the result becomes ready for review (manual user review or a user-triggered independent review session), the user submits their or the reviewer's findings, and the same implementation session applies the fixes. The human can steer that session when needed: interrupt a running attempt, add direction, and continue in the same session. For big features with many slices the session is kept light by deliberate rotation — not discarded per step, not allowed to bloat.

It matters because context re-ingestion is the dominant token cost, and "fix my findings with a brand-new zero-memory agent" is both expensive and slow (30–55 minutes observed review-round latency).

## Rejection Criteria

- Findings applied by a newly spawned implementation agent instead of the warm session — or a warm session left to bloat until ineffective with no rotation strategy.
- Independent fresh-eyes review stops being available alongside manual review.
- The loop cycles or spends autonomously when it should be waiting for human input — including any cache keep-alive pinging.

## Contrasts

- Not eliminating monitor sessions — those were voluntary self-improvement extras, not required babysitting.
- Not an autonomous self-converging machine — the loop stays human-paced at review and adjudication.
- Not saving tokens by thinning review — savings come from session continuity and orchestration, not weaker review.

## Constraints

- Backward compatible: Work state without warm-session fields behaves exactly as today (fresh spawns). No state migration; the live ParagonAgent Work continues untouched.
- Both runtimes: `claude -p --resume <session-id>` (proven live, including `--json-schema` composition and turn-1 recall) and `codex exec resume <SESSION_ID> [PROMPT]` (help-verified; composition proven by shim tests; degrade-to-fresh when resume fails).
- No daemon and no long-lived child process; the engine stays invoke-and-exit (crash-recovery and tmux env-failure history argue against a daemon).
- A warm session's provider flag-set (schema, permission mode, disallowed tools) stays constant for the session's lifetime so its request prefix stays cache-stable.
- Human steering text is bounded generously (8 KiB), not by the 1000-char caps that bound model-facing fields.
- Config lives in `~/.config/pair/config.json`; every new key has a safe default.

## Decisions

### D-1: Warm implementation session per slice (resume-based)
- **Decision:** The first implementation call of a slice persists the provider session (implementation mode drops `--no-session-persistence`/`--ephemeral`) and records its session id and runtime in slice state; correction and steer calls resume that session.
- **Why:** Both CLIs ship resume. Live round-trip proved 0.1× cache-read continuation ($0.004 vs $0.022) with full turn-1 recall; today's engine never captures a session id at all.
- **Consequences:** Reviews and post-diff design stay fresh (D-2); slice state gains warm-session fields; resume failure must degrade to fresh (D-4).

### D-2: Reviews stay ephemeral; the coordinator inlines the diff
- **Decision:** Review and post-diff-design calls remain one-shot fresh sessions; the review prompt inlines the `base..checkpoint` unified diff when it fits a configured cap (default 24 KiB), else falls back to today's instruct-to-diff.
- **Why:** Fresh eyes are a Rejection-Criterion guarantee; the reviewer re-deriving a diff the coordinator already holds as two commit ids is pure waste.
- **Consequences:** Oversized diffs keep current behavior; inlined diffs land in the call-variable tail of the D-3 layout.

### D-3: Stable-first, cache-friendly prompt assembly
- **Decision:** Every prompt is assembled stable-first: kind boilerplate at byte 0 → slice-stable block (outcome, acceptance criteria, Design Check) → call-variable tail (findings, verification failure, direction, checkpoint ids). Warm resumed calls omit the slice-stable block entirely — the session history already holds it.
- **Why:** Prefix caching matches from byte 0; today per-call-unique content sits first, so identical trailing boilerplate never hits. Cross-process prefix hits are real: a fresh smoke session cache-read 17.9K tokens of identical boot prefix.
- **Consequences:** Same-slice re-review rounds prefix-hit within the cache TTL; smallest lever of the set but free; prompt-builder tests must assert prefix identity.

### D-4: Rotation keeps sessions light
- **Decision:** Retire the warm session at slice acceptance. Rotate mid-slice — a fresh session seeded with the full carryover package — when the last call's context size exceeds `warm_session_context_budget_tokens` (default 120000), when the runtime switches, or when resume fails. Every rotation records an event with its reason.
- **Why:** Continuity must not mean unbounded growth (user constraint); the same budget caps the worst-case post-TTL cache re-write after a long human review gap.
- **Consequences:** Rotation is exactly today's fresh-spawn path, so it is always available as a fallback; the default budget is config-tunable.

### D-5: Submit triggers the fix
- **Decision:** Closing adjudication with at least one valid finding, or a human `finding --submit`, immediately dispatches the correction into the warm session (`dispatch_correction_on_submit`, default true).
- **Why:** The submit is the human input; observed expectation verbatim: "after submitting … coding agent fix my issue immediately".
- **Consequences:** No autonomous cycling is introduced — nothing dispatches without a human act; disabling the flag restores today's explicit run.

### D-6: Human steering — interrupt / steer / continue
- **Decision:** `pair-loop interrupt` SIGINTs the in-flight child and records outcome `interrupted-by-human` (spends no correction; never classified environment-failure). `pair-loop steer --text "…"` delivers a bounded human message into the warm session as a resumed turn; the next run continues that same session.
- **Why:** Explicit user requirement; matches observed asks ("can I pause/stop/resume it?"). Interrupted attempts must not repeat the historical misclassification of interrupts as environment failures.
- **Consequences:** nvim keymaps for interrupt/steer are a small dotfiles follow-up outside this repo.

### D-7: Telemetry proves the win
- **Decision:** Every provider call record gains session id, resumed flag, rotation reason, and the cache-read / cache-write (per TTL tier) / input / output / cost split; `pair-report` surfaces warm-vs-fresh counts and per-slice context growth.
- **Why:** Makes the optimization falsifiable against the mined baseline (≈541M cached tokens across 62 calls; 837K→5.97M per-slice growth curve).
- **Consequences:** The result envelope already carries every field; no extra provider round-trips.

### D-8: Child boot diet
- **Decision:** Spawned children boot lean — no user MCP servers or plugins (`--strict-mcp-config` for claude; codex equivalent).
- **Why:** Measured ≈28K tokens of boot context per spawn; jetbrains MCP connects inside headless one-shot children today and is never used by them.
- **Consequences:** Applies to fresh and warm spawns alike; pure savings.

## Engineering Quality Contract

- **Always-on obligations:** intent fit to the warm-implementer anchor; maintainable scope — extend the provider layer and slice state, no daemon, no new state machine; traceable verification — every AC has a named executable test; independent review through Pair's own fresh reviewer; repository security baseline — children keep their sandbox and permission modes, and persisted session transcripts contain nothing beyond what stream logs already contain.
- **Fact-activated obligations:**
  - **Fact:** the provider invocation layer and dispatch policy change. **Response:** shim-CLI integration tests assert exact spawn arguments and envelope parsing for both runtimes and both envelope shapes (event array and single envelope). **Owner:** implementer. **Exclusion authority:** user.
  - **Fact:** a live ParagonAgent Work runs on these installed scripts. **Response:** all new behavior is inert for state lacking warm-session fields; no migration; land while that Work is blocked or completed. **Owner:** implementer. **Exclusion authority:** user.

## Acceptance Criteria

- [ ] AC-1: A slice's first implementation call persists its provider session and records session id, runtime, and token/cache telemetry in Pair state — for both result-envelope shapes (event array and single envelope).
- [ ] AC-2: A correction dispatch for a slice holding a warm session resumes that session instead of spawning fresh, and its prompt carries only call-variable content (adjudicated findings, deterministic failure, correction direction) — no slice-stable package.
- [ ] AC-3: The warm session retires at slice acceptance; a fresh rotated session with full carryover starts when the last call's context exceeded the configured budget, the runtime switched, or resume failed — and every rotation is recorded with its reason.
- [ ] AC-4: Review prompts include the base→checkpoint unified diff when it fits the configured cap and fall back to current behavior otherwise; review calls remain fresh one-shots.
- [ ] AC-5: For every prompt kind, two calls of the same kind share a byte-identical prefix covering the kind boilerplate — and the slice-stable block for same-slice calls — with call-variable content strictly after it.
- [ ] AC-6: `pair-loop interrupt` ends an in-flight attempt with outcome `interrupted-by-human` (no correction spent, never environment-failure); `pair-loop steer --text` reaches the warm session as a resumed turn; the next run continues that session.
- [ ] AC-7: With `dispatch_correction_on_submit` enabled (default), closing adjudication with a valid finding or `finding --submit` immediately dispatches the correction; disabled restores manual run.
- [ ] AC-8: Every provider call record includes session id, resumed flag, rotation reason, cache-read/cache-write/input/output tokens and cost; `pair-report` shows warm-vs-fresh counts and per-slice context growth.
- [ ] AC-9: Spawned children boot without user MCP servers or plugins on both runtimes.
- [ ] AC-10: Resume composes with structured-output flags on both runtimes without altering their result envelopes.

## Verification

### AC-1
- **Proof:** `node --test skills/pair-v3/tests/warm-session-capture.test.js`
### AC-2
- **Proof:** `node --test skills/pair-v3/tests/warm-correction-resume.test.js`
### AC-3
- **Proof:** `node --test skills/pair-v3/tests/warm-session-rotation.test.js`
### AC-4
- **Proof:** `node --test skills/pair-v3/tests/review-diff-inlining.test.js`
### AC-5
- **Proof:** `node --test skills/pair-v3/tests/stable-first-prompts.test.js`
### AC-6
- **Proof:** `node --test skills/pair-v3/tests/steering.test.js`
### AC-7
- **Proof:** `node --test skills/pair-v3/tests/submit-triggers-fix.test.js`
### AC-8
- **Proof:** `node --test skills/pair-v3/tests/provider-telemetry.test.js`
### AC-9
- **Proof:** `node --test skills/pair-v3/tests/child-boot-diet.test.js`
### AC-10
- **Proof:** `node --test skills/pair-v3/tests/provider-flag-composition.test.js` (optional human-run live check: `PAIR_SMOKE_LIVE=1 node skills/pair-v3/tests/live-resume-smoke.js`)

## Out of Scope

- env-failure / review-infrastructure misclassification family (24 instances across 4 work items) — follow-up Work.
- Handover double-adopt race and monitor-session forking — follow-up Work.
- Registry/ledger unbounded growth (settled conversation rows, `events.jsonl`) — follow-up Work.
- Finding-entry UX ceremony in nvim (`<leader>pf` flow) — follow-up Work.
- Correction budget for combined-diff (composition) review — follow-up Work.
- nvim keymaps for interrupt/steer — dotfiles repo change.
