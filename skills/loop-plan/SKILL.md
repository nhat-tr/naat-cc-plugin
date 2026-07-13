---
name: loop-plan
description: Create a gate-protected .claude-loop.md for an automatic Codex or Claude coding loop. Use when the user asks for loop-plan, a long-running loop, an unattended task plan, or pair-loop without a full pair spec.
---

# Create an Automatic Loop Plan

Derive the goal, observable acceptance criteria, and task breakdown from the
approved conversation. If the done condition is ambiguous, stop and ask rather
than inventing it.

Write `.claude-loop.md`:

```markdown
# Goal: <one sentence>

## Acceptance Criteria
- [ ] <observable criterion>
- [ ] Tests pass; no new lint errors

## Tasks
- [ ] write failing tests for <behavior> [type:test] [risk:low] [scope:local] [uncertainty:low] - files: `tests/...` - **S**
- [ ] implement <behavior> [type:feature] [risk:medium] [scope:local] [uncertainty:medium] - files: `src/...` - **M**
- [ ] integration test: <scenario> [type:test] [risk:medium] [scope:cross-module] [uncertainty:low] - files: `tests/...` - **M**

## Log
```

Keep the file out of version control through `.git/info/exclude`. Do not
implement while planning. Start the automatic quality-constrained loop with:

```bash
pair-loop --runtime auto
```
