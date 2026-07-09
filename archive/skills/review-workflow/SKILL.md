---
name: review-workflow
description: Review uncommitted code changes for security, correctness, and quality. Use when the user asks for a code review, pre-commit check, or quality gate on staged/unstaged diffs. Scope is uncommitted changes only.
---

# Review Workflow

Use this skill for code-review sessions in Codex.

## Metadata

- Runtime: `codex`
- Claude command: `commands/review.md`
- Command alias in Claude: `/review`

## Workflow

1. Load these source docs:
   - `../../commands/review.md`
2. Run review on uncommitted changes only (`git diff --staged` and `git diff`).
3. If no uncommitted changes exist, return: `No uncommitted changes to review.`
4. Report findings by severity, then by file.
5. End with review summary and verdict.

## Language Routing (REQUIRED — do this BEFORE reviewing)

<!-- BEGIN RUNTIME POINTERS -->
- Claude Code: `~/.claude/CLAUDE.md`
- Codex: `~/.codex/AGENTS.md` or `~/.agents/AGENTS.md`
<!-- END RUNTIME POINTERS -->

Read the active runtime's global instruction file from the block above, then find the absolute path under "Global Language Rules" and `Read` that skill file. All rules in section 2 (Non-Negotiable Rules) are mandatory review criteria.

- **C# / .NET**: Read the C# skill file + testing reference. NUnit test names: `[Action]_When[Scenario]_Then[Expectation]`
- **TypeScript / React / Next**: Read the TypeScript skill file + react-next reference.

## Readability Checks (HIGH)

Flag these in new or modified code:

- Method requires scrolling to understand — extract named steps
- Nesting deeper than 2 levels — use early returns or extract
- Unnamed boolean expressions with 2+ clauses — assign to named variable
- Long LINQ/method chain (>3 operations) without intermediate names
- Parameter list > 4 on new methods — introduce request/options object

## Rules

- Optimize for **readability → maintainability → correctness patterns → performance**.
- Apply repository-convention-first gating for style/architecture findings.
- Keep findings evidence-based with file/line references.
- Suggest concrete fixes for each reported issue.
