---
description: Create a phased implementation plan for a feature, refactor, or architectural change. Analyzes the codebase first, then presents a plan. WAITS for user confirmation before any code is written.
---

# Plan

Create a comprehensive implementation plan using the **planner** agent. BE BRUTALLY HONEST, NO OPTIMISTIC ASSUMTION, ASK ON AMBIGUITIES, YOU ARE FREE TO PUSH BACK

## What This Command Does

1. **Restate requirements** — clarify what's being asked, surface ambiguities
2. **Analyze codebase** — find affected files, existing patterns, and dependencies
3. **Present design decisions** — options considered with tradeoffs
4. **Break into phases** — each phase independently deliverable and verifiable
5. **Identify risks** — what could go wrong, how to mitigate
6. **WAIT for confirmation** — does NOT write code until you approve

## When to Use

- Starting a new feature
- Making architectural changes
- Complex refactoring across multiple files
- When requirements are unclear — forces clarity before coding
- When you want to think before you act

## Usage

```
/plan Add user authentication with JWT
/plan Migrate from EF Core 6 to EF Core 8
/plan Refactor the order processing pipeline to use CQRS
/plan Add WebSocket support to the Rust API
```

## After Planning

Once you confirm the plan:
- Use `/review` after implementing to review your changes
- The plan stays in conversation context as a reference

## Important

The planner will **NOT** write any code until you explicitly confirm. Respond with:
- **"yes"** / **"proceed"** — start implementation
- **"modify: [changes]"** — adjust the plan
- **"different approach: [alternative]"** — rethink from scratch
- **"skip to phase N"** — jump ahead
