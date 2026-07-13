---
description: Promote an approved spec into a capability-first, validated pair-v3 plan without speculative architecture.
---

# Pair Promote

Use `$ARGUMENTS` as the input path when supplied. Otherwise use `.pair/spec.md`, then an approved design from this conversation.

Read and follow the canonical `pair-promote` skill at:

`~/.local/share/my-claude-code/skills/pair-promote/SKILL.md`

When running from the toolkit checkout, use `skills/pair-promote/SKILL.md`. The skill is the source of truth; this command is only the Claude runtime adapter.

Do not write a plan from unapproved requirements. Do not implement.

The canonical plan contract requires:

- `## Intent Contract` preserving Purpose, Rejection Criteria, and Contrasts.
- `## Capability Evidence` grounded in repository usage, pinned dependency APIs, official sources, or a scratch probe.
- Versioned external `Dependency` records kept distinct from application-owned `Repository capability` records.
- A **framework-native baseline** before custom architecture.
- `## Simplicity Contract` rejecting pass-through wrappers and hypothetical seams.
- Vertically sliced streams with stable IDs, AC mappings, files, verification commands, profiles, and tests before implementation.
- No unresolved `[blocking]` question or high-uncertainty implementation task.

Validate until clean:

```bash
~/.local/share/my-claude-code/skills/pair-v3/scripts/validate-plan
```

Report plan counts, evidence sources, justified custom modules, and open questions, then stop.
