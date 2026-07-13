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
2. Run `pair-loop --runtime auto` for unattended execution, or perform the same
   lifecycle from the interactive coordinator. When asked to implement or
   continue a plan from an interactive session, invoke `pair-loop --runtime auto
   --once` rather than editing the task directly; this keeps measurement and
   escalation automatic. Use the continuous form only when the user requests
   the whole plan or an unattended loop.
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
8. Use `pair-report` to compare route quality, rework, findings, tokens, and cost.

## Routing Policy

- Minimize expected total cost to accepted code, subject to the quality floor.
- Low/medium/high quality floors are 85%/92%/97%; critical work uses the
   strongest configured route and never explores.
- High uncertainty also uses the strongest route defensively, but a validated
  `.pair/plan.md` should contain only low/medium uncertainty because promotion
  resolves high uncertainty through evidence first.
- One local-fix attempt is allowed for isolated major findings. Blockers,
  repeated majors, repeated verification failures, or substantial rewrites
  escalate. A first infrastructure failure regenerates on the same route. A
  first ambiguity or incorrect-plan verdict adds coordinator-owned recovery
  context and retries on the next stronger route; repetition requires human
  takeover. Interrupted attempts are recovered from `.pair/active-attempt.json`.
- Historical evidence is comparable only within task type, complexity, risk,
  and scope. Invalid runtime/reviewer results do not train routing.

## Evidence

The append-only ledger defaults to `~/.local/share/pair-v3/attempts.jsonl` and
contains metadata, usage, findings, verification, disposition, and cause. Never
store prompts, source, secrets, or full command output in the ledger.

Dispositions: `accepted`, `local-fix`, `substantial-rewrite`, `redesign`,
`regenerated`, `human-takeover`, `abandoned`.

Causes: `model-capability`, `task-ambiguity`, `missing-context`,
`incorrect-plan`, `verification-defect`, `reviewer-error`,
`integration-conflict`, `environment-failure`.

## Commands

```bash
pair-loop --runtime auto
pair-loop --runtime codex --once
pair-loop --runtime claude --model sonnet --effort medium
pair-report
```
