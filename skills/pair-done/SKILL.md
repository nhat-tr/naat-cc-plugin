---
name: pair-done
description: Finish the pair harness workflow — verify tests pass, then present merge/PR/keep/discard options. Invokes finishing-a-development-branch skill.
---

# Pair Done

All streams are complete and reviewed. Wrap up the feature.

## Workflow

Invoke `/superpowers:finishing-a-development-branch`. The skill will:

1. Run the project's full test suite
2. If tests fail, report failures and stop
3. If tests pass, present 4 options: merge locally, create PR, keep as-is, discard
4. Execute the chosen option and clean up

Wait for human input on the option choice. Do not auto-select.

If the skill is not available, do the above steps manually.
