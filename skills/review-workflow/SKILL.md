---
name: review-workflow
description: Review uncommitted code changes for security, correctness, and quality. Use when the user asks for a code review, pre-commit check, or quality gate on staged/unstaged diffs. Scope is uncommitted changes only.
---

# Review Workflow

Use this skill for code-review sessions in Codex.

## Metadata

- Runtime: `codex`
- Claude command: `commands/review.md`
- Claude agent: `agents/code-reviewer.md`
- Claude context: `contexts/review.md`
- Command alias in Claude: `/review`

## Workflow

1. Load these source docs:
   - `../../commands/review.md`
   - `../../agents/code-reviewer.md`
   - `../../contexts/review.md`
2. Run review on uncommitted changes only (`git diff --staged` and `git diff`).
3. If no uncommitted changes exist, return: `No uncommitted changes to review.`
4. Report findings by severity, then by file.
5. End with review summary and verdict.

## Rules

- Prioritize security and correctness over style.
- Apply repository-convention-first gating for style/architecture findings.
- Keep findings evidence-based with file/line references.
- Suggest concrete fixes for each reported issue.
