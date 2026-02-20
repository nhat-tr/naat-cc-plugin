---
description: Start a system design / architecture session. Analyzes current architecture, proposes changes with tradeoffs, and produces ADRs. Uses opus for deep reasoning.
---

# Architect

Invoke the **architect** agent for system design and architectural decisions.

## What This Command Does

1. **Map current state** — reads project structure, dependency graph, existing patterns
2. **Clarify requirements** — asks about constraints, scale, non-functional requirements
3. **Propose architecture** — components, responsibilities, data flow, API contracts
4. **Analyze tradeoffs** — options considered, pros/cons, recommendation with rationale
5. **Produce ADR** — Architecture Decision Record for significant decisions

## When to Use

- Designing a new system or major feature
- Evaluating technology choices (framework, database, messaging, etc.)
- Deciding on component boundaries or service splits
- Reviewing existing architecture for problems
- Preparing for scale changes

## Usage

```
/architect How should we structure the new payment processing module?
/architect Evaluate whether we should split the monolith into services
/architect Review the current data access layer architecture
/architect Should we use CQRS for the order management domain?
```

## What You Get

- Component diagram with responsibilities
- Tradeoff analysis table for each decision
- ADR for the recommended approach
- Anti-patterns identified in current architecture
- Concrete file/project paths for where changes would go