---
name: csharp-dotnet
description: C# and .NET implementation guidance for backend, API, and data-layer work. Use when writing or modifying C# code, designing ASP.NET Core endpoints, configuring dependency injection, implementing EF Core queries or model configuration, applying async and concurrency patterns, or writing NUnit tests. Start by matching existing repository conventions and target framework constraints; use .NET 10 and C# 14 patterns only when compatible.
---

# C# / .NET Implementation Workflow

Use this skill to implement production-safe .NET changes with repository-first compatibility.

## Execute This Workflow

1. Inspect repository constraints before editing.
2. Match the existing architecture and coding conventions.
3. Load only the reference file(s) needed for the current task.
4. Implement the smallest change that solves the request.
5. Validate with build and test commands, then report any unverified areas.

## Inspect Constraints First

Run these checks before choosing patterns:

- `rg --files -g '*.csproj'`
- `rg -n '<TargetFramework|<TargetFrameworks|<LangVersion|<Nullable|<TreatWarningsAsErrors' -g '*.csproj'`
- `rg -n 'NUnit|xunit|MSTest|FluentAssertions|NSubstitute|Moq|Testcontainers' -g '*.csproj'`
- `rg -n 'AddDbContext|UseSqlServer|UseNpgsql|UseSqlite|MapGroup|AddControllers' src tests`

If the repository is not on .NET 10 or C# 14, preserve compatibility and avoid forcing upgrades.

## Apply Guardrails

- Prefer repository conventions over generic templates.
- Prefer primary constructors for new services when the repository uses them.
- Propagate `CancellationToken` through async call chains.
- Use `AsNoTracking` for read-only EF queries.
- Use structured logging message templates instead of string interpolation.
- Remove dead code and unused usings while touching files.
- Avoid broad refactors unless explicitly requested.

## Reference Map

Read only what is relevant:

- `references/project-and-style.md`: solution layout, naming, constants, async, and general coding conventions.
- `references/di-and-api-clients.md`: DI module registration and external API client patterns.
- `references/ef-core-10.md`: EF Core guidance, including .NET 10-era features with compatibility notes.
- `references/aspnet-core-10.md`: Minimal API and API-layer patterns.
- `references/testing-nunit.md`: unit and integration testing patterns with NUnit and Testcontainers.
- `references/modern-csharp-and-dotnet.md`: modern C# and .NET APIs and language features.

## Deliverable Expectations

When implementing changes:

- Explain compatibility decisions (for example, why a .NET 10 feature was used or skipped).
- Add or update tests when behavior changes.
- Provide exact validation commands run, or clearly state what could not be run.
