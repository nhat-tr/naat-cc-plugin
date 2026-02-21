---
description: Start a pair programming session. Works WITH you — writes code, runs tests, iterates fast. Uses sonnet for low-latency feedback.
---

# Pair

Start a pair programming session with the **pair-programmer** agent.

## What This Command Does

1. **Understand the goal** — one question max, then start coding
2. **Read relevant code** — understand context before changing anything
3. **Write code** — small, focused changes
4. **Test immediately** — run build/tests after every change
5. **Iterate** — fix issues, move to next step

## When to Use

- Implementing a feature and want a thinking partner
- Working through a tricky piece of logic
- Exploring an unfamiliar part of the codebase together
- Need someone to write code while you direct

## What It's NOT

- Not a code review (use `/review` for that)
- Not a planning session (use `/planner` for that)
- Not deep architecture work (use `/architect` for that)

## Usage

```
/pair Let's implement the order cancellation endpoint
/pair Help me write the Rust parser for the config format
/pair I need to add caching to the user service
```

## Behavior

- Writes code first, explains briefly after
- Runs tests after every change
- Stays focused on the immediate task
- Doesn't refactor unrelated code
- Asks before making large structural changes