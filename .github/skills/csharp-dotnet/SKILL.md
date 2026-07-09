---
name: csharp-dotnet
description: C# and .NET implementation guidance for backend, API, and data-layer work. Use when writing or modifying C# code, designing ASP.NET Core endpoints, configuring dependency injection, implementing EF Core queries or model configuration, applying async and concurrency patterns, writing NUnit tests, reviewing C# code, creating new .NET projects, or making NuGet package decisions. Start by matching existing repository conventions and target framework constraints; use modern C# patterns only when the repo's target framework supports them.
---

# C# / .NET — Core Rules

Non-negotiable C#/.NET rules, condensed. Agents, reviewers, and pair sessions read this file first. Full rationale, code samples, and scaffolding live in `references/` — see the Reference Map (§4) before assuming a one-liner below is the whole story.

## 1. Inspect Constraints First

Before choosing patterns, check the repo:

- `rg --files -g '*.csproj'`
- `rg -n '<TargetFramework|<LangVersion|<Nullable|<TreatWarningsAsErrors' -g '*.csproj'`
- `rg -n 'NUnit|xunit|MSTest|FluentAssertions|NSubstitute|Moq|Testcontainers' -g '*.csproj'`

**If JetBrains Rider MCP is available**: `mcp__jetbrains__get_project_modules` (list projects), `get_project_dependencies <module>` (NuGet packages), `get_file_problems <file>` (Rider inspections), `reformat_file <file>` (apply formatting), `rename_refactoring` (project-wide rename).

If the repo is not on the latest .NET/C# version, preserve compatibility — do not force upgrades.

## 2. Core Rules

These apply to ALL C# work. When applying them, **readability is the tiebreaker** — a rule that makes code harder to understand in context should be noted but not blindly followed. Full rationale for every bullet below: `references/core-rules.md`.

Prefer: linear flow over callbacks/indirection, explicit over implicit, named intermediate values over long chains, early returns over deep nesting, fewer abstractions until duplication forces one.

### Async

- Propagate `CancellationToken` through every async call chain.
- **No `async void`** (event handlers only).
- **No sync-over-async** (`.Result`/`.Wait()`/`.GetAwaiter().GetResult()`).
- **No fire-and-forget** — `await` every `Task`.
- `Task.WhenAll` for independent concurrent work.
- **Library code**: `ConfigureAwait(false)`; application code (controllers/services): don't.

### Resource Management

- `using`/`await using` for all `IDisposable`/`IAsyncDisposable`.
- **Never `new HttpClient()` per request** — use `IHttpClientFactory`.
- External APIs via a typed client interface, not scattered `HttpClient` calls.

### EF Core

- `AsNoTracking()` for read-only queries.
- **No N+1** — `Include()`; `AsSplitQuery()` for multiple included collections.
- **No `FromSqlRaw` + string concatenation** — use `FromSql($"...")` interpolation.
- **No client-side evaluation** — avoid `AsEnumerable()`/premature `ToList()`.
- DbContext lifetime: **Scoped**.
- **Data annotations over `IEntityTypeConfiguration`**; fluent config only where annotations can't express it.
- **`DbContext` only in services/query classes, never controllers/endpoints.** Extract a named query class only when duplicated across 2+ services.
- **Never edit generated migrations** — `dotnet ef migrations add/remove`; use `IAsyncEnumerable<T>` (`AsAsyncEnumerable()`) for streaming large result sets.

### Logging

- **New code: `[LoggerMessage]` source generator**, class `partial` — not `_logger.LogXxx(...)`.
- Don't mix styles in one class — migrate fully or keep traditional.
- `[LoggerMessage]` methods: `private static partial void`, grouped at the bottom.
- **No string interpolation** in log calls — structured message templates.
- Traditional `_logger.LogXxx`: guard `LogDebug`/`LogTrace` with `IsEnabled` when args allocate.

### Dependency Injection

Choose service lifetime by the service's characteristics, not a blanket default — **Scoped** (request-scoped resources), **Singleton** (stateless/thread-safe/expensive/shared config), **Transient** (lightweight, short-lived). Full decision table: `references/core-rules.md` § Dependency Injection.

- **No captive dependencies** (Scoped/Transient into a Singleton), **no service locator** (`IServiceProvider.GetService<T>()`), **no `new`-ing services** — everything through DI.
- Register by module via extension methods; keep `Program.cs` composition-only.
- Prefer global `JsonSerializerOptions`/naming policies over per-property `[JsonPropertyName]`; use options objects (`IOptions<T>`) for external config, bound once in module registration.

### ASP.NET Core

- **Controllers are thin** — validate, delegate to service, map response. No business logic.
- **Never inject `DbContext` into a Controller or Minimal API handler** — use a service or query class.
- Middleware order: `UseAuthentication` before `UseAuthorization`; `UseRouting` before `UseEndpoints`.
- Authorization: group-level (not per-endpoint), policy-based (not role checks).
- Built-in Minimal API validation (`[Required]`, `[Range]`); FluentValidation only if already adopted.
- **`ProblemDetails` for all error responses** — `AddProblemDetails()` + exception handler middleware, not custom shapes.

### Error Handling

- **No `throw ex;`** (always `throw;`); **no exception swallowing** (no empty `catch`/catching `Exception` without logging).
- Typed domain exceptions for business rule violations, mapped to HTTP status codes in the API layer; let infrastructure failures propagate to the global handler — don't catch/rewrap without adding context.

### Testing — NUnit

- **Naming: `[Action]_When[Scenario]_Then[Expectation]`**, Arrange-Act-Assert structure.
- `Assert.That` constraint model (not `Assert.AreEqual`), `Assert.Multiple` for grouped assertions, `Assert.ThrowsAsync<T>` for async exceptions.
- **No FluentAssertions. No AutoMapper** — map explicitly (see Code Style § Mapping).
- Test categories (`[UnitTest]`, `[IntegrationTest]`, `[StagingOnly]`) for CI filtering; Testcontainers over shared databases; `WebApplicationFactory<TEntryPoint>` for full API integration tests.

### Packages

- **MIT / Apache-2.0 licenses only** — no commercial NuGet packages.

## 3. Code Style

- Match existing repository conventions — inspect actual code before assuming patterns.
- **Seal classes** not designed for inheritance.
- **Use `record`** for DTOs/API contracts/value objects; `class` for stateful services and entities with identity.
- **Map explicitly** (static methods/extensions). See `references/code-examples.md` § Manual Mapping.
- **Always use braces** for control-flow blocks, even single-statement. Allman style. See `references/code-examples.md` § Braces / Control-Flow Style.
- **Private static readonly fields**: `_camelCase` prefix.
- **Prefer primary constructors**; traditional constructors only when you need body logic. Follow the repo's existing style if it differs.
- **One type per file** — unless tightly coupled (discriminated union variants, record + nested builder, private nested types).
- **Member ordering and blank-line conventions** — full list in `references/core-rules.md` § Member Ordering.
- Add `using` imports — **never** write fully qualified type names inline.
- Named constants over magic values (`nameof()`, `const` fields); remove dead code.
- LINQ: no `ToList()` before `Where()`, no multiple enumerations, use `Any()` not `Count() > 0`.
- **Use collection expressions** (`[.. source]`) instead of `.ToList()` / `.ToArray()`.
- Avoid broad refactors unless explicitly requested.
- **Modern C# feature gating** (source-generated regex, `Lock`, `field` keyword, null-conditional assignment) — see `references/core-rules.md` § Modern C# Features. Use only when the target framework supports it.

## 4. Reference Map

Read only what is relevant:

- `references/core-rules.md` — the "why" behind every Core Rules/Code Style bullet, the full Member Ordering list, Modern C# Features table, and the Aspire CLI non-interactive note.
- `references/code-examples.md` — runtime code samples (DI, EF Core, HTTP clients, auth, error handling, mapping, streaming, braces). No rules.
- `references/test-code-examples.md` — test code samples (NUnit, Testcontainers, WebApplicationFactory, Respawn, parallel execution, Podman, Aspire testing interop, pitfalls).
- `references/project-structure.md` — solution/project scaffolding (layouts, `Directory.Build.props`, `Directory.Packages.props`, `global.json`, `.editorconfig`) for new solutions.
- For .NET Aspire projects, use the `aspire` skill and `mcp__aspire__*` MCP tools.

## 5. Verification

- Build: `dobq` (filtered output — errors only, deduped, short paths; preferred over `dotnet build` for agent use)
- Test: `dotnet test` (or `dotnet test --filter "TestCategory=UnitTest"`)
- If JetBrains Rider MCP is available: run `mcp__jetbrains__get_file_problems` on touched files

### Debugging Failing Tests

When an HTTP assertion fails without a clear reason, read the response body before asserting:

```csharp
var response = await HttpClient.PostAsJsonAsync(...);
Console.WriteLine(await response.Content.ReadAsStringAsync());
Assert.That(response.StatusCode, Is.EqualTo(HttpStatusCode.OK));
```
