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

**If JetBrains Rider MCP is available** (`mcp__jetbrains__*` tools present in your tool list), use these instead:
- `mcp__jetbrains__get_project_modules` — lists all projects with paths (replaces `rg --files -g '*.csproj'`)
- `mcp__jetbrains__get_project_dependencies <module>` — NuGet packages per project (replaces rg on `.csproj`)

If the repository is not on .NET 10 or C# 14, preserve compatibility and avoid forcing upgrades.

## Apply Guardrails

- Prefer repository conventions over generic templates.
- Prefer primary constructors for new services when the repository uses them.
- Propagate `CancellationToken` through async call chains.
- Use `AsNoTracking` for read-only EF queries.
- Use structured logging message templates instead of string interpolation.
- Remove dead code and unused `using` directives while touching files.
- Add `using` imports rather than writing fully qualified type names inline (e.g. `new AuthenticationHeaderValue(...)` not `new System.Net.Http.Headers.AuthenticationHeaderValue(...)`).
- Prefer EF Core data annotations (`[Key]`, `[MaxLength]`, `[Required]`, `[Column]`, `[Table]`, `[ForeignKey]`, `[Index]`) over `IEntityTypeConfiguration` classes. Only use fluent configuration for things attributes can't express (composite keys, owned types, query filters, table splitting, many-to-many with payload, `HasPrecision`). For value conversions, prefer a reusable converter attribute over fluent `HasConversion`.
- Prefer injecting `DbContext` directly over generic repository wrappers unless the repository adds meaningful, reusable logic.
- Prefer `AddScoped` over `AddSingleton`; use `Singleton` only when the type is truly stateless and thread-safe — think carefully.
- Prefer `JsonSerializerOptions` / naming policies over `[JsonPropertyName]` attribute decoration.
- Avoid broad refactors unless explicitly requested.
- Use `System.Threading.Lock` for explicit lock objects:
- Use source-generated regex for hot paths:
- Use `field` keyword in property accessors when normalization or validation is needed:

```csharp
public string Email
{
    get;
    set => field = value?.Trim().ToLowerInvariant()
        ?? throw new ArgumentNullException(nameof(value));
}
```

## Reference Map

Read only what is relevant:

- `references/project-and-style.md`: solution layout, naming, constants, async, and general coding conventions.
- `references/di-and-api-clients.md`: DI module registration and external API client patterns.
- `references/aspnet-core-10.md`: Minimal API and API-layer patterns.
- `references/testing-nunit.md`: unit and integration testing patterns with NUnit and Testcontainers.

### Debugging failing tests

When an HTTP assertion fails without a clear reason (e.g. unexpected 400/404/500), always read the response body before asserting to see the actual error detail:

```csharp
var response = await HttpClient.PostAsJsonAsync(...);
Console.WriteLine(await response.Content.ReadAsStringAsync()); // add this to see the error
Assert.That(response.StatusCode, Is.EqualTo(HttpStatusCode.OK));
```


## Deliverable Expectations

When implementing changes:

- Explain compatibility decisions (for example, why a .NET 10 feature was used or skipped).
- Add or update tests when behavior changes.
- Provide exact validation commands run, or clearly state what could not be run.

**If JetBrains Rider MCP is available**, enhance verification with:
- `mcp__jetbrains__get_file_problems <file>` on each touched file — Rider inspection results; catches issues before running `dotnet build`
- `mcp__jetbrains__reformat_file <file>` — apply IDE formatting after significant edits
- `mcp__jetbrains__rename_refactoring` — project-wide semantic rename (covers interface impls, mocks, generated code) instead of manual find+replace
