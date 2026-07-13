---
name: pair-v2
description: Headless pair workflow — the interactive session (or /loop) is the doer; an independent one-shot reviewer runs against the diff and feeds BLOCKERs back through the plan and the nvim notes system. No tmux/cmux cockpit, no orchestrator.
---

# Pair v2 — Headless Doer/Reviewer Workflow

Two agents, zero cockpit. The **doer** is the normal interactive Claude session
(or a `/loop` run). The **reviewer** is a fresh-context `claude -p` one-shot
that reads only the diff + plan, so it is never anchored by the doer's
conversation. State lives in `.pair/` files; the Stop hook enforces completion.

## Artifacts

| File | Purpose |
|---|---|
| `.pair/spec.md` | What/why + acceptance criteria (from brainstorming, plan mode, or by hand) |
| `.pair/plan.md` | Implementable plan: intent/capability/simplicity contracts + validated TDD tasks |
| `.pair/review.md` | Human-readable review from the last reviewer run |
| `.pair/review.json` | Machine findings — imported into nvim notes with `<leader>ni` |
| `.pair/verify.sh` | Optional executable; if present, the stop-gate blocks "done" while it fails |

## Flow

1. **Spec → Plan**: `/pair-promote` converts a spec (or Claude plan-mode output)
   into an implementable `.pair/plan.md`. A spec is NOT implementable — promotion
   is mandatory. Run pair-v3's canonical parser so validation and execution
   cannot drift:
   `~/.local/share/my-claude-code/skills/pair-v3/scripts/validate-plan`
   The old `pair-v2/scripts/validate-plan.sh` path remains a compatibility wrapper.
2. **Implement — TDD order is mandatory**: work the plan in the normal session
   or `/loop`. Each stream starts with its failing-test task: write the tests,
   run them, watch them fail for the right reason, THEN implement until they
   pass. Never reorder implementation ahead of tests, and never skip the
   stream's integration-test task. Check off tasks (`- [x]`) as they complete.
   The Stop hook (`stop-gate.sh`) blocks premature "done" while unchecked
   tasks remain or `.pair/verify.sh` fails.
   **Unattended/overnight**: `skills/pair-v2/scripts/pair-loop [interval] [--auto]`
   launches the whole efficient-loop recipe in one command (fresh session,
   sonnet/medium, interval wakeups that ride out token-limit outages; `--auto`
   prevents stalls on permission prompts).
3. **Review — the DOER fires it, at every Review boundary**: when the last
   task before a `**Review boundary**` marker is checked, the doer immediately
   spawns the **pair-reviewer agent** (fresh context, opus, writes
   `.pair/review.md`/`review.json`, appends BLOCKERs to the plan) — never wait
   for a human to trigger it, including inside `/loop` runs. The human can
   also fire it any time:
   `~/.local/share/my-claude-code/skills/pair-v2/scripts/pair-review` (nvim `<leader>pv`)
   - Default: strong model (settings default), targeted file reads allowed.
   - `--eco`: diff-only on sonnet — use ONLY for S-complexity changes.
     Review is judgment work; do not downgrade the model to save tokens —
     the savings come from the small context (diff+plan), not the model tier.
4. **Fix loop**: BLOCKER findings are auto-appended to `.pair/plan.md` as
   unchecked tasks — the stop-gate holds the doer until they are fixed.
   In nvim, `<leader>ni` imports findings as `[rv]` notes for triage;
   reply to a note with `@cc ...` to dispatch a question/instruction.
   **Context hygiene**: once a stream's review is clean, `/clear` before
   starting the next stream — it is free and lossless here (gate-orient
   re-injects the plan status; the plan file carries everything else).
   Prefer `/clear` at boundaries over `/compact` mid-stream; if you must
   compact mid-task, steer it: `/compact keep: current task, files touched,
   decisions, open questions`.
   **Plan slimming**: at the same moment (stream reviewed clean), collapse
   that stream's tasks into one line —
   `- [x] Stream N: <name> — done, reviewed (detail: plan-archive.md)` —
   and MOVE the task detail to `.pair/plan-archive.md`. The plan is re-read
   every wakeup; slimming makes that read get cheaper as work progresses
   instead of growing (a live plan hit 56KB ≈ 14k tokens per wakeup).
5. **Done**: all boxes checked, verify passes, reviewer verdict `approve`.

## Rules for the doer agent

- Never edit `.pair/review.md` / `review.json` — they belong to the reviewer.
- When picking up review fixes, work the `## Review Fixes` checklist in
  `.pair/plan.md`; mark each `[x]` only after the specific finding is addressed.
- If a finding is wrong, do not silently skip it: mark it `[x]` with a
  one-line rebuttal underneath, so the human can arbitrate.
- Never game the gate: do not check a box without doing the work, do not
  edit/delete tests or `.pair/verify.sh` to make them pass, and never weaken
  an acceptance criterion to satisfy it. "No change needed" is a valid task
  outcome — record it as a rebuttal, not as fake work.

## Model guidance

- Reviewer default = settings default model (strong). Judgment work.
- `--eco` (sonnet, diff-only) only when the change is small and mechanical.
- `PAIR_REVIEW_MODEL=<model>` overrides explicitly.
