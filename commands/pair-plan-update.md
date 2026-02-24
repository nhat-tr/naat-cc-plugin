---
description: Apply plan review feedback from .pair/review.md to .pair/plan.md. Updates the plan for the pair protocol (streams, boundaries, sequencing, acceptance criteria, risks) and does not implement code.
---

# Pair Plan Update

Update `.pair/plan.md` using the **pair-plan-updater** agent.

## What This Command Does

1. **Reads pair artifacts** — `.pair/plan.md` and `.pair/review.md`
2. **Interprets findings** — prioritizes `BLOCKER` and `IMPORTANT`
3. **Updates the plan** — improves streams, tasks, boundaries, criteria, and risks
4. **Preserves structure** — keeps the pair-plan template shape
5. **Reports briefly** — summarizes what changed and what was not applied

## When to Use

- After plan challenge feedback in `.pair/review.md`
- After a human review of the plan
- When the plan needs revision before implementation begins

## Usage

```text
/pair-plan-update Apply review feedback to .pair/plan.md
/pair-plan-update Update the plan based on blockers and important findings in .pair/review.md
```

## Important

- Do **not** implement code.
- If `.pair/review.md` is an implementation review instead of a plan review, only apply plan-relevant changes.
- Preserve useful existing plan content; do not rewrite everything by default.
