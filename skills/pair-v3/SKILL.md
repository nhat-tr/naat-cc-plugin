---
name: pair-v3
description: Automatic, token-efficient pair workflow for Codex and Claude. Use when implementing a .pair/plan.md, delegating plan tasks, running pair-loop, evaluating generated-code quality, routing tasks to cost-appropriate models, or reviewing and escalating failed delegated attempts.
---

# Pair v3 - Automatic Quality-Constrained Pair Loop

Pair v3 completes `.pair/plan.md` or `.claude-loop.md` one task at a time. The normal coordinator or
`pair-loop` owns attempt lifecycle automatically; users never need to invoke
`pair-task` directly.

## Workflow

1. Ensure `.pair/plan.md` passes the shared parser and contains its Intent
   Contract, versioned Dependency and grounded Repository capability evidence,
   Simplicity Contract, stable task IDs, AC
   mappings, owned files, exact verification, tests-first order, and integration
   verification. High-uncertainty work must return to promotion first.
   Optional explicit routing tags override inference: `[type:bugfix]`,
   `[risk:medium]`, `[scope:local]`, `[uncertainty:low]`.
2. Interactive coordinator sessions: run `pair-loop --doctor` once, then drive one
   task at a time with `pair-loop --runtime auto --once --inline`. Delegable work
   (risk:low, scope:local) runs on a headless worker; anything harder is handed
   back as an INLINE TASK BRIEF — implement it in the session with full context,
   then run `pair-loop --complete` so verification replay, independent review,
   classification, and the ledger still happen. Never mark the task yourself.
   Use `pair-loop --runtime auto` (fully headless) only for unattended terminal
   runs of the whole plan.
3. Before delegation, open an attempt with task profile, route, baseline, and
   owned files. Only the coordinator may edit `.pair/*`.
4. Delegate exactly one task. Workers do not update the plan and do not work on
   adjacent tasks.
5. Require workers to use the plan's pinned dependency evidence and
   framework-native baseline. An absent load-bearing API is an incorrect plan,
   not permission to invent a wrapper or substitute architecture.
6. Verify with `.pair/verify.sh` or coordinator replay of worker-reported
   commands, independently review, classify the outcome, record evidence, and
   then complete, locally fix, escalate, regenerate, redesign, or stop the task.
7. Review with the deletion test: reject pass-through modules, one-adapter
   interfaces, duplicated framework capability, and work not mapped to an AC.
   Reviews report only material findings — BLOCKER or MAJOR, each with a concrete
   failure scenario this repository can actually reach. Style notes, hypothetical
   edge cases, and robustness suggestions are omitted entirely, and a fix/rewrite/
   redesign recommendation backed by no material finding is ignored: verified work
   is accepted rather than burning an attempt on noise.
8. Use `pair-report` to compare route quality, rework, findings, tokens, and cost.

## Routing Policy

- Routing is static by task profile: second tier for low/medium-risk local work,
  third tier for high risk, L complexity, or contract/architecture scope, and the
  strongest configured route for critical work, which never explores. Code-writing
  tasks never route to the cheapest tier — it is reserved for docs-type tasks,
  because ledger evidence shows the cheapest tier cannot reliably emit structured
  worker results.
- High uncertainty also uses the strongest route defensively, but a validated
  `.pair/plan.md` should contain only low/medium uncertainty because promotion
  resolves high uncertainty through evidence first.
- One local-fix attempt is allowed for isolated major findings. Blockers,
  repeated majors, repeated verification failures, or substantial rewrites
  escalate. A first infrastructure failure (non-zero runtime exit) regenerates on
  the same route, but a clean run whose output cannot be parsed into the worker
  schema retries on the next stronger route, since a weaker model often cannot emit
  structured output. A first ambiguity or incorrect-plan verdict adds coordinator-owned
  recovery context and retries on the next stronger route; repetition requires human
  takeover. Interrupted attempts are recovered from `.pair/active-attempt.json` and the
  ledger, do not consume the retry budget, and stop the task if they recur back-to-back.
- The ledger is the audit record for route quality and cost (`pair-report`); it
  does not steer routing. Invalid runtime/reviewer results are marked and excluded
  from quality statistics.

## Evidence

The append-only ledger defaults to `~/.local/share/pair-v3/attempts.jsonl` and
contains metadata, usage, findings, verification, disposition, and cause. Never
store prompts, source, secrets, or full command output in the ledger.

Dispositions: `accepted`, `local-fix`, `substantial-rewrite`, `redesign`,
`regenerated`, `human-takeover`, `abandoned`.

Causes: `model-capability`, `task-ambiguity`, `missing-context`,
`incorrect-plan`, `verification-defect`, `reviewer-error`,
`integration-conflict`, `environment-failure`.

## Operating Modes and Limits

"Automatic" means the attempt lifecycle — routing, verification, review, classification,
escalation, and evidence — runs without hand-holding. It is not a background scheduler:
nothing advances between turns unless a process is running.

- **Interactive (`--once --inline`)**: the coordinator runs `pair-loop --runtime auto
  --once --inline`, which executes exactly one task and exits. Low-risk local tasks are
  delegated headless; harder tasks come back as an inline brief for the warm session to
  implement, closed with `pair-loop --complete`. The human (or an outer `/loop`) is the
  driver between tasks. Use this from inside a Claude Code / Codex session.
- **Unattended (continuous)**: `pair-loop --runtime auto` runs every open task to
  completion. Run it in a terminal. Do not start the continuous form from inside a hosted
  agent session: that session then owns the Stop gate for the whole multi-hour run and
  cannot cleanly stop. Opt out with `PAIR_STOP_GATE=off` when a supervised stop is needed.
- **Interruptions self-heal**: a crash/kill leaves an attempt record open; the next
  `pair-loop` run reconciles it (recorded `status: interrupted`) and continues. An orphaned
  `.pair/active-attempt.json` no longer traps a session — only a live loop owner blocks a
  stop. Interrupted attempts do not consume the retry budget, but repeated back-to-back
  interruptions stop the task as an unstable-environment signal.
- **Editing the plan**: only toggle task/AC checkboxes. Any prose edit to `.pair/plan.md`
  changes the contract digest and blocks the loop until the Work plan is re-promoted; add
  blockers through the plan's Open Questions via promotion, not ad-hoc notes.
- **Reviewer cost/limits**: the review step dominates latency and can hit account session
  limits on the strongest models. A truncated review is treated as `reviewer-error` and
  retried rather than accepted; set `PAIR_CLAUDE_REVIEW_MODEL=sonnet` to reduce cost/limit risk.
- **Rejected work never pollutes the next attempt**: any escalate/redesign/retry outcome
  restores the worktree to its pre-attempt state (earlier accepted uncommitted work and
  `.pair/` evidence are preserved); the rejected diff is saved as a scratch patch.
- **HITL mode (`--hitl` or `PAIR_HITL=1`)**: before a `[type:test]` task writes anything,
  a read-only proposal run lists the exact tests (name, one-line purpose, file) and the
  loop pauses for approval. On a terminal you approve inline; otherwise approve with
  `pair-loop --approve-tests all` (indexes like `1,3` approve a subset, `none` rejects) and
  rerun. The worker then writes exactly the approved set — rejected proposals are never
  written — and retries of the same task reuse the approval without re-asking. The proposal
  is bound to the task and plan contract, so editing the plan invalidates it automatically.

## Commands

```bash
pair-loop --doctor                # preflight: verify the environment before spending anything
pair-loop --runtime auto --once --inline   # one task; hard tasks hand back an inline brief
pair-loop --complete              # close an inline attempt through verify + review + ledger
pair-loop --runtime auto          # run every open task headless; terminal only
pair-loop --hitl --once           # human approves each test task's proposed tests first
pair-loop --approve-tests all     # apply approval to a pending proposal (1,3 | none)
pair-report            # ledger summary by route/type/risk (--json, --help supported)
```
