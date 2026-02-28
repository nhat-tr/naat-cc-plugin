---
description: Challenge `.pair/plan.md` before implementation and write `.pair/review.md` with plan-level findings (BLOCKER/IMPORTANT/NIT). Does not implement code.
---

# Pair Plan Challenge

Review `.pair/plan.md` and write `.pair/review.md` using the **pair-plan-challenger** agent.

## What This Command Does

1. Reads `.pair/plan.md` and relevant context docs
2. Challenges stream boundaries, sequencing, coupling, and acceptance criteria
3. Writes structured findings to `.pair/review.md`
4. **Signal next agent**: if any BLOCKER found, run `bash ~/.dotfiles/scripts/pair-signal.sh plan-update` to auto-chain the planner to revise. If no blockers, do NOT signal (human decides to implement).
5. Responds briefly with verdict and top changes

## When to Use

- After the initial plan draft
- Before `waiting_for = "implement"`
- When a plan changed and needs a fresh challenge pass

## Usage

```text
/pair-plan-challenge
/pair-plan-challenge Review .pair/plan.md for stream boundaries and sequencing risk
```

## Important

- Do **not** implement code.
- Focus on execution risk and plan quality, not code style.
