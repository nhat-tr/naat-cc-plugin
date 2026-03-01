---
description: Challenge `.pair/plan.md` before implementation and write `.pair/review.md` with plan-level findings (BLOCKER/IMPORTANT/NIT). Does not implement code.
---

# Pair Plan Challenge

Use the **pair-plan-challenger** agent via the Agent tool (`subagent_type: "pair-plan-challenger"`).

Pass a brief prompt with any relevant context. The agent reads the plan, verifies file paths, writes `.pair/review.md`, updates `.pair/stream-log.md`, and signals readiness.

## When to Use

- After the initial plan draft, before `waiting_for = "implement"`
- When a plan changed and needs a fresh challenge pass