---
name: csharp-dotnet
description: C# and .NET implementation guidance for backend, API, and data-layer work. Use when writing or modifying C# code, designing ASP.NET Core endpoints, configuring dependency injection, implementing EF Core queries or model configuration, applying async and concurrency patterns, or writing NUnit tests. Start by matching existing repository conventions and target framework constraints; use .NET 10 and C# 14 patterns only when compatible.
---

# C# / .NET — Single Source of Truth

All C#/.NET rules live here. Agents, reviewers, and pair sessions reference this file — they do not redefine these rules.

## 1. Inspect Constraints First

Before choosing patterns, check the repo:

- `rg --files -g '*.csproj'`
- `rg -n '<TargetFramework|<LangVersion|<Nullable|<TreatWarningsAsErrors' -g '*.csproj'`
- `rg -n 'NUnit|xunit|MSTest|FluentAssertions|NSubstitute|Moq|Testcontainers' -g '*.csproj'`

**If JetBrains Rider MCP is available** (`mcp__jetbrains__*` tools):
- `mcp__jetbrains__get_project_modules` — lists all projects
- `mcp__jetbrains__get_project_dependencies <module>` — NuGet packages per project
- `mcp__jetbrains__get_file_problems <file>` — Rider inspections on touched files
- `mcp__jetbrains__reformat_file <file>` — apply formatting after edits
- `mcp__jetbrains__rename_refactoring` — project-wide semantic rename

If the repo is not on .NET 10 / C# 14, preserve compatibility — do not force upgrades.

## 2. Non-Negotiable Rules

These apply to ALL C# work — implementation, review, pairing, planning. No exceptions.

When applying these rules, **readability is the tiebreaker**. A rule that makes code harder to understand in context should be noted but not blindly followed. Prefer:
- Linear flow over callbacks/indirection
- Explicit over implicit
- Named intermediate values over long chains
- Early returns over deep nesting
- Fewer abstractions until duplication forces one

### Async

- Propagate `CancellationToken` through every async call chain
- **No `async void`** — only valid for event handlers; causes unobservable exceptions
- **No sync-over-async** — never use `.Result`, `.Wait()`, `.GetAwaiter().GetResult()` (blocks threads, causes starvation)
- **No fire-and-forget** — every `Task` returned must be `await`ed
- Use `Task.WhenAll` for independent concurrent work

### Resource Management

- **Use `using` / `await using`** for all `IDisposable` / `IAsyncDisposable` — no leaks
- **Never `new HttpClient()` per request** — use `IHttpClientFactory` (prevents socket exhaustion)
- External API calls must go through a typed client interface, not scattered `HttpClient` usage

### EF Core

- `AsNoTracking()` for all read-only queries
- **No N+1** — use `Include()` for related data; use `AsSplitQuery()` for multiple collection includes (prevents cartesian explosion)
- **No `FromSqlRaw` with string concatenation** — use `FromSql($"...")` interpolation (SQL injection)
- **No client-side evaluation** — avoid `AsEnumerable()` or premature `ToList()` before filtering
- DbContext lifetime must be **Scoped** (not Singleton — it's not thread-safe)
- Prefer data annotations (`[Key]`, `[MaxLength]`, `[Required]`, `[Column]`, `[Table]`, `[ForeignKey]`, `[Index]`) over `IEntityTypeConfiguration`. Use fluent only for: composite keys, owned types, query filters, table splitting, many-to-many with payload, `HasPrecision`
- **Prefer `DbContext` directly for simple queries.** Extract a named query class (e.g. `OrderQueries`) when the same complex query appears in 2+ services or when scattering queries across services hurts readability
- **Never edit generated migration files** — use `dotnet ef migrations add/remove`

### Logging

- Use structured message templates — **no string interpolation** in log calls
- **Always** gate `LogDebug` with `if (logger.IsEnabled(LogLevel.Debug))` — no exceptions
- `LogInformation` / `LogWarning` / `LogError` don't need guards

### Dependency Injection

- Prefer `AddScoped` over `AddSingleton` — Singleton only when truly stateless and thread-safe
- **No captive dependencies** — never inject Scoped/Transient into a Singleton
- **No service locator** — don't use `IServiceProvider.GetService<T>()` to resolve dependencies
- **No `new`-ing services** — everything through DI (breaks testability)
- Register services by module using extension methods; keep `Program.cs` focused on composition
- Prefer `JsonSerializerOptions` / naming policies over per-property `[JsonPropertyName]`
- Use options objects for external config (not scattered string keys)

### ASP.NET Core

- **Controllers are thin** — validate request, delegate to service, map response. No business logic
- Middleware ordering matters: `UseAuthentication` before `UseAuthorization`, `UseRouting` before `UseEndpoints`
- Apply authorization at group level (not per-endpoint) to avoid missing endpoints
- Use policy-based authorization over role checks
- Use built-in Minimal API validation (`[Required]`, `[Range]`); FluentValidation only if already adopted

### Testing — NUnit

- **Test naming: `[Action]_When[Scenario]_Then[Expectation]`**
- Follow Arrange-Act-Assert structure
- Use `Assert.That` with constraint model (`Is.EqualTo`, `Is.True`, etc.) — not `Assert.AreEqual`
- Use `Assert.Multiple` to group related assertions
- Use `Assert.ThrowsAsync<T>` for async exception tests (not `Assert.Throws<T>`)
- **No FluentAssertions** — use NUnit constraint model
- **No AutoMapper** — map explicitly
- Use test categories (`[UnitTest]`, `[IntegrationTest]`, `[StagingOnly]`) for CI filtering
- Prefer Testcontainers for integration tests over shared databases
- Use `WebApplicationFactory` for full API integration tests

### Packages

- **MIT / Apache-2.0 licenses only** — no commercial NuGet packages

## 3. Code Style

- Match existing repository conventions — inspect actual code before assuming patterns
- Prefer primary constructors when the parameter list stays short (≤4). For larger dependency lists, use traditional constructors with `readonly` fields
- **One type per file** — unless types are tightly coupled and more readable together (e.g., discriminated union variants, a record + its nested builder, private nested types)
- **Member ordering** (top → bottom):
  1. Public/internal constants and static fields
  2. Public/internal instance fields and auto-properties
  3. Constructor(s)
  4. Public/internal methods and properties
  5. Protected fields, properties, methods
  6. Private fields and properties
  7. Private methods
- Add `using` imports — **never** write fully qualified type names inline
- Replace magic values with named constants (`nameof()`, `const` fields)
- Remove dead code: unused `using`, parameters, variables, commented-out blocks
- No exception swallowing — empty `catch` or catching `Exception` without logging/rethrowing
- LINQ: no `ToList()` before `Where()`, no multiple enumerations, use `Any()` not `Count() > 0`
- Avoid broad refactors unless explicitly requested

### C# 14 Features (when repo supports)

- `field` keyword in property accessors for validation/normalization
- `System.Threading.Lock` for explicit lock objects
- Source-generated regex for hot paths
- Null-conditional assignment (`x?.Prop = value;`)

## 4. Reference Files

Read only what's relevant to the current task:

- `references/project-and-style.md` — solution layout, naming, constants, async examples
- `references/di-and-api-clients.md` — DI module registration, typed HTTP clients, options pattern
- `references/aspnet-core-10.md` — Minimal API patterns, validation, auth
- `references/testing-nunit.md` — test setup examples, categories, Testcontainers, WebApplicationFactory

## 5. Verification

- Build: `dotnet build`
- Test: `dotnet test` (or `dotnet test --filter "TestCategory=UnitTest"`)
- If JetBrains Rider MCP is available: run `mcp__jetbrains__get_file_problems` on touched files

### Debugging failing tests

When an HTTP assertion fails without a clear reason, read the response body before asserting:

```csharp
var response = await HttpClient.PostAsJsonAsync(...);
Console.WriteLine(await response.Content.ReadAsStringAsync());
Assert.That(response.StatusCode, Is.EqualTo(HttpStatusCode.OK));
```
