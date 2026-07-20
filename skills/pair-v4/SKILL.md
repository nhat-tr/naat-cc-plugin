---
name: pair-v4
description: Visible, resumable Pair v4 workflow for Codex and Claude. Use when implementing `.pair/plan.md`, running pair-loop, reviewing Work, recovering an attempt, inspecting Pair status/history, pausing, taking over, or evaluating generated-code quality.
---

# Pair v4 — Visible, Repository-Local Pairing

Pair v4 keeps ordinary implementation in the visible Codex or Claude coordinator, persists one recoverable Work lifecycle in the repository, and uses one reusable independent read-only Review Session. The coordinator owns the whole tests-first Review Slice; do not delegate implementation or reproduce lifecycle state manually.

## Runtime Topology

`pair-loop --host` creates or reuses exactly three tmux panes:

```text
┌────────────────┬──────────────────────────┬──────────────────────────┐
│ editor         │ coordinator              │ reviewer                 │
│ Neovim/control │ active Codex/Claude chat │ read-only Review Session │
│ human edits    │ implementation + tests   │ plan/slice/final review  │
└────────────────┴──────────────────────────┴──────────────────────────┘
                         │                              │
                         └──── .pair/runs/<work-id> ───┘
```

The Review Session command itself runs in the reviewer pane; the pane is not a decorative log mirror. Plan review, Review Slice review, and cumulative review resume the same provider session and bind each verdict to the supplied digest. No implementation worker or worktree exists in v4.

## Canonical Lifecycle

```text
plan validation → plan review → implementing → verifying → reviewing → accepting
                                         ↑          │            │
                                         └──────────┴ local fix ─┘
                                                              │
                                            next Review Slice ┘

after final slice: cumulative verification → cumulative review ─────────→ complete
                              ↑                 │
                              └─ local fix ← cumulative-correction

any active phase ── pause boundary ──→ paused ── resume ──→ exact saved phase
in-flight request ── Cancel now ─────→ last completed checkpoint
material decision/hard boundary ─────→ blocked (files preserved)
```

One attempt ID survives CLI exits, agent exits, verification-launch failures, and Review Session failures. Those are evidence events, not terminal attempt outcomes. A later correction remains on the same attempt. Only accepted, explicitly discarded, or legacy isolated-headless work is terminal.

## Coordinator Runbook

1. If `.pair/plan.md` is absent, use brainstorming and `pair-promote` first.
2. Run `pair-loop --host`, then `pair-loop --doctor`. Resolve only reported `fail` results before dispatch.
3. Run bare `pair-loop --runtime auto`. `--once`, `--inline`, and `--complete` remain compatibility aliases; the normal lifecycle does not require them.
4. When Pair prints an inline Review Slice brief, implement it directly in this visible coordinator. Write the failing test first, prove the intended failure, implement the minimum behavior, and run the exact verification.
5. Run bare `pair-loop` yourself. It resumes the saved phase, independently replays verification, invokes the Review Session when policy requires it, records the verdict, accepts the slice, and immediately opens the next Review Slice when one remains.
6. Continue without asking the user to push ordinary phase transitions. Stop only for an explicit pause, a material plan/security/policy decision, exclusive human editing, or an evidenced blocker with no safe in-scope recovery action.

Plan challenge is automatic when canonical approval is missing or stale. `auto` remains provider-affine. Cross-provider fallback requires explicit user authorization.

## Repository Authority

For canonical Work, all authority lives under `.pair/runs/<work-id>/`:

- `events.jsonl` — append-only authoritative events.
- `state.json` — atomic reducer projection used by status, doctor, report, orientation, and Stop adapters.
- `status.md` — secret-safe human projection.
- `attempts/<attempt-id>/` — private bounded status, complete patches, verification metadata, and review evidence.
- `review-session.json` — reusable read-only Review Session identity.

`.pair/current-run.json` is only a locator. `.pair/plan.md` markers are derived scanability: `[ ]` queued, `[-]` active, `[x]` accepted. All three normalize to the same semantic plan digest.

Legacy home-directory history is optional import evidence, never authority. Missing or unwritable legacy storage warns once and cannot block new Work. `pair-report --json` reads repository events by default.

## Review and Boundary Policy

- Expected files are advisory ownership evidence. Additional in-repository files stay in the patch, receive expected/cross-slice/unmapped attribution, and are reviewed on substance.
- Hard boundaries are narrow: Pair mutable control state, the canonical active Work contract, credential or policy-forbidden paths, and paths outside the repository. A hard result names the exact path and governing rule.
- Verification or reviewer infrastructure failure preserves code and resumes only the failed evidence phase. Green verification remains cached when review infrastructure fails.
- A material implementation finding returns the same attempt to implementation and waits for the patch digest to change before re-verifying.
- Pair v4 never silently restores visible coordinator work. `pair-loop --discard-attempt` previews affected paths; only the exact follow-up command with the attempt ID and `--confirm-discard` restores the pre-attempt snapshot. The discarded complete patch remains in attempt evidence.

Routine slice review defaults to critical risk; `PAIR_TASK_REVIEW=high-risk|all|off` is an explicit policy choice. The final complete-Work patch always receives cumulative verification and independent review.

## Pause, Resume, Takeover, and Human Editing

- `pair-loop --pause` waits for the current model/tool boundary, records the exact phase, releases continuation ownership, and preserves tmux processes and files.
- `pair-loop --resume` resumes and dispatches the exact saved phase in the same invocation.
- `pair-loop --cancel-now` terminates only the journaled in-flight process group and returns to the last completed checkpoint. It never freezes or discards code.
- `pair-loop --takeover [SESSION]` explicitly transfers automatic continuation ownership.
- Human plan/code editing requires pause, `--begin-human-edit plan|code`, then `--end-human-edit`. Semantic plan edits invalidate exact-digest approval; marker-only progress does not. Code edits stale only affected evidence and resume verification.

Codex and Claude Stop adapters use their native response shapes and continue only the owning chat. Codex claims from its command thread identity; Claude captures the guaranteed hook `session_id` only after that chat invokes Pair. Unrelated commands and chats cannot claim or continue the Work. There is no checkbox counter or interruption counter. A blocked lifecycle releases automatic continuation.

## Bounded Resume and Privacy

Same-session review resumption receives one Pair-authored Resume Checkpoint capped at 8,192 UTF-8 bytes, including a next action capped at 512 bytes and only digest/path references. Pair sends no cache-warming ping. First-turn cached/uncached usage is measured and reported as nonblocking telemetry.

Events, logs, patches, reviews, status, report data, and hook output must omit raw prompts, transcripts, private reasoning, environment maps, credentials, capability tokens, and secret-like values. Runtime files are private. Never weaken redaction to make debugging easier; retain only bounded secret-safe evidence.

## Review Results and Genuine Blockers

Reviewers report only BLOCKER or MAJOR findings with a concrete reachable failure scenario and `origin: implementation|plan|environment`. Style, optional hardening, speculative edges, and a file merely being additional are not findings.

Pair has no default two-interruption, two-attempt, two-plan-review, or two-final-review stops. Each CLI invocation remains finite, unchanged rejected patches do not re-dispatch, and explicit `--max-*` options remain optional operator ceilings. Report `blocked` only for a material decision or when the same evidenced cause remains after every safe in-scope recovery action.

## Commands

```bash
pair-loop --host
pair-loop --attach
pair-loop --doctor
pair-loop --runtime auto
pair-loop --status
pair-loop --status --json
pair-loop --pause
pair-loop --resume
pair-loop --cancel-now
pair-loop --takeover [SESSION]
pair-loop --begin-human-edit plan|code
pair-loop --end-human-edit
pair-loop --discard-attempt
pair-loop --discard-attempt <ATTEMPT> --confirm-discard
pair-loop --challenge-plan --runtime auto
pair-loop --approve-plan <digest> --reason "..."
pair-report --json
```

`pair-v4` is a CLI alias for `pair-loop`. `pair-loop --legacy-v3 ...` is the only explicit route to the old split headless lifecycle.
