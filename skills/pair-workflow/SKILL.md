---
name: pair-workflow
description: Interactive pair-programming workflow for implementing code with fast feedback. Use when the user asks to build features together, iterate quickly, or code while directing implementation.
---

# Pair Workflow

Use this skill for interactive implementation sessions.

## Metadata

- Runtime: `codex`
- Claude command: `commands/pair.md`
- Claude agent: `agents/pair-programmer.md`
- Command alias in Claude: `/pair`

## Workflow

1. Load source docs:
   - `../../commands/pair.md`
   - `../../agents/pair-programmer.md`
2. Clarify only what is necessary, then start coding.
3. Make small, focused changes.
4. Run relevant verification after each meaningful change.
5. Iterate quickly and stay in task scope.

## Language Routing

- C# / .NET work:
  - `../csharp-dotnet/SKILL.md`
  - `../csharp-dotnet/references/testing-nunit.md`
  - NUnit test method names: `[Action]_When[Scenario]_Then[Expectation]`
- TypeScript React / Next work:
  - `../typescript/SKILL.md`
  - `../typescript/references/react-next.md`

## Rules

- Code first, explain briefly after.
- Avoid unrelated refactors.
- Ask before large structural changes.
- Keep momentum and fast feedback loops.
