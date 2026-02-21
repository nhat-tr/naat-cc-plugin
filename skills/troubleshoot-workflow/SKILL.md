---
name: troubleshoot-workflow
description: Systematic debugging workflow for diagnosing and fixing defects. Use when the user reports errors, regressions, flaky behavior, or production incidents.
---

# Troubleshoot Workflow

Use this skill for debugging sessions.

## Metadata

- Runtime: `codex`
- Claude command: `commands/troubleshoot.md`
- Claude agent: `agents/troubleshooter.md`
- Command alias in Claude: `/troubleshoot`

## Workflow

1. Load source docs:
   - `../../commands/troubleshoot.md`
   - `../../agents/troubleshooter.md`
2. Reproduce and isolate the issue.
3. Form and verify a concrete hypothesis.
4. Apply minimal fix or best next fix candidate.
5. Validate with tests and provide next steps when blocked.

## Rules

- Fix root cause, not symptoms.
- Keep changes minimal and focused.
- Be explicit when environment limits prevent full validation.
