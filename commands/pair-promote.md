---
description: Promote an approved spec into a compact, evidence-grounded Pair v4 plan with finite exact-digest review.
---

# Pair Promote

Use `$ARGUMENTS` as the input path when supplied. Otherwise use `.pair/spec.md`, then an approved design from this conversation.

Read and follow the canonical `pair-promote` skill at:

`~/.local/share/my-claude-code/skills/pair-promote/SKILL.md`

When running from the toolkit checkout, use `skills/pair-promote/SKILL.md`. The skill is the source of truth; this command is only the Claude runtime adapter. Do not write a plan from unapproved requirements and do not implement.

The default executable contract is compact:

- `**Pair mode:** lite`.
- One `## Intent Contract` with the canonical Spec, Purpose, decisive Repository evidence, Constraints, and full Verification.
- Behavior-sized Stream tasks with stable IDs, risk, AC mapping, test boundary, owned files/tests, exact verification, and S/M/L size. Put the outcome on the checkbox line and show those facts as indented labeled rows, not one metadata-dense sentence.
- One tests-first visible coordinator session per slice; no separately reviewed RED/GREEN/test/wiring mini-epics.
- At least one real integration/e2e slice covering the Acceptance Criteria.
- Acceptance Criteria as completion state, never extra model tasks.

Validate and challenge once:

```bash
skills/pair-v3/scripts/validate-plan .pair/plan.md
pair-loop --challenge-plan --runtime auto
```

After a semantic revision, run a focused closure verdict carrying prior findings. Pair challenges a Work at most twice by default; if the second reviewer verdict still has material plan findings, it records an exact-digest `human-override`, retains those findings for mandatory coordinator work, and does not start a third challenge. Reviewer-environment failures are never approved. `--max-plan-reviews` selects a different positive cap. If the user deliberately overrides earlier, use `pair-loop --approve-plan <digest> --reason "..."`, which records honest `human-override` provenance. Report the plan digest, task/AC counts, decisive evidence, verification, plan-review summary path, and approval kind, then stop.
