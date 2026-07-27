---
description: Promote an approved spec into a compact, evidence-grounded Pair v4 plan with finite exact-digest review.
---

# Pair Promote

Use `$ARGUMENTS` as the input path when supplied. Otherwise use `.pair/spec.md`, then an approved design from this conversation.

Read and follow the canonical `pair-promote` skill at:

`~/.local/share/my-claude-code/skills/pair-promote/SKILL.md`

When running from the toolkit checkout, use `skills/pair-promote/SKILL.md`. The skill is the source of truth; this command is only the Claude runtime adapter. Do not write a plan from unapproved requirements and do not implement.

The default executable contract is compiled and provider-neutral for Codex and Claude Code:

- `**Pair mode:** compiled`.
- One immutable, Work-indexed Implementation Design Contract containing exact symbols/call paths, before/after/error behavior, state/wiring/failure handling, tests/RED signals, deletions, and non-goals. Validate it, then persist it with `work-lineage.cjs record-evidence`.
- One `## Intent Contract` with the canonical Spec, digest-bound Implementation Design Contract, Purpose, decisive Repository evidence, Constraints, and full Verification.
- Behavior-sized Stream tasks with stable IDs, explicit type/risk/scope/uncertainty, AC and `IMP-NNN` design mapping, test boundary, owned files/tests, exact verification, and S/M/L size. Put the outcome on the checkbox line and show those facts as indented labeled rows, not one metadata-dense sentence.
- One tests-first visible coordinator session per slice; no separately reviewed RED/GREEN/test/wiring mini-epics.
- At least one real integration/e2e slice covering the Acceptance Criteria.
- Acceptance Criteria as completion state, never extra model tasks.
- A validator-compiled Review Slice Execution Packet no larger than 8,192 bytes for cheap-ready work. S/M alone is insufficient: cheap-ready also requires low uncertainty, low/medium risk, local/cross-module scope, and completely closed mappings.

Validate and challenge once:

```bash
validate-plan .pair/plan.md
pair-loop --challenge-plan --runtime auto
```

After a semantic revision, run a focused closure verdict carrying prior findings. Pair challenges a Work at most twice by default; if the second reviewer verdict still has material plan findings, it records an exact-digest `human-override`, retains those findings for mandatory coordinator work, and does not start a third challenge. Reviewer-environment failures are never approved. `--max-plan-reviews` selects a different positive cap. If the user deliberately overrides earlier, use `pair-loop --approve-plan <digest> --reason "..."`, which records honest `human-override` provenance. Report the Implementation Design Contract and plan digests, task/AC counts, every slice's cheap-ready/recommended-strength/packet-bytes result, decisive evidence, verification, plan-review summary path, and approval kind, then stop.
