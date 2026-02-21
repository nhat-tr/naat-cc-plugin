---
description: Review changed files for security, correctness, and quality. Invokes the code-reviewer agent across C#, TypeScript, Rust, and Python.
---

# Code Review

Review all uncommitted changes using the **code-reviewer** agent. Be direct, evidence-based, and push back on risky changes. Ask when ambiguity affects severity.



## What This Command Does

1. **Detect changes** — `git diff --staged` and `git diff` to find all modified files
2. **Stop on empty diff** — if both are empty, return `No uncommitted changes to review.`
3. **Identify languages** — route to language-specific checklists (.cs, .ts, .rs, .py)
4. **Read full context** — read each changed file completely, not just the diff
5. **Apply review checklist** — security (CRITICAL), correctness (HIGH), quality (MEDIUM), style (LOW)
6. **Report findings** — severity-ordered findings with file:line, issue, and fix
7. **Verdict** — APPROVE, REQUEST CHANGES, or BLOCK

## When to Use

- Before committing — catch issues before they enter history
- After implementing a feature — review your own work
- After a refactor — verify nothing broke
- When picking up unfamiliar code — understand what changed

## What Gets Checked

| Language | Key Checks |
|----------|------------|
| C# | async/await misuse, IDisposable leaks, EF Core N+1, null safety, DI anti-patterns, NUnit coverage |
| TypeScript | `any` abuse, missing null checks, React hook deps, unvalidated input, floating promises |
| Rust | `unwrap()` in prod, unsafe without SAFETY comment, clone abuse, error propagation |
| Python | mutable defaults, bare except, missing type hints, context managers |
| All | hardcoded secrets, SQL injection, path traversal, auth bypasses |

## Output

Findings grouped by severity, ending with a summary table and verdict.

BLOCK if any CRITICAL issues. REQUEST CHANGES if HIGH issues. Otherwise APPROVE.
