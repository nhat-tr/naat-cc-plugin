---
description: Diagnose and fix a bug or issue. Systematically reproduces, isolates, and resolves the root cause. Uses opus for deep reasoning about complex failures.
---

# Troubleshoot

Invoke the **troubleshooter** agent to diagnose and fix bugs.

## What This Command Does

1. **Reproduce** — confirm the problem, get exact error/symptom
2. **Isolate** — check recent changes, narrow down the component
3. **Hypothesize** — form a specific, testable theory
4. **Verify** — read the suspected code path, confirm the root cause
5. **Fix** — minimal fix for the root cause, run tests to confirm

## When to Use

- Got an error message or stack trace you can't figure out
- Something broke after a change and you don't know why
- Intermittent failure that's hard to pin down
- Production issue that needs systematic diagnosis

## Usage

```
/troubleshoot NullReferenceException in OrderService.ProcessAsync
/troubleshoot Tests pass locally but fail in CI
/troubleshoot API returns 500 after deploying the new migration
/troubleshoot The Rust service panics under concurrent load
```

## What to Include

Give the agent as much as you have:
- Error message and/or stack trace
- Steps to reproduce (if known)
- When it started (commit, deployment, config change)
- What you've already tried

## What You Get

- Root cause identified with evidence
- Minimal fix applied
- Test written to prevent regression
- Explanation of why it happened (brief, not a lecture)