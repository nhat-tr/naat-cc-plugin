---
name: csharp-dotnet
description: C# and .NET implementation guidance for backend, API, and data-layer work. Use when writing or modifying C# code, designing ASP.NET Core endpoints, configuring dependency injection, implementing EF Core queries or model configuration, applying async and concurrency patterns, writing NUnit tests, reviewing C# code, creating new .NET projects, or making NuGet package decisions. Start by matching existing repository conventions and target framework constraints; use modern C# patterns only when the repo's target framework supports them.
---

# C# / .NET — Single Source of Truth

All C#/.NET rules live here. Agents, reviewers, and pair sessions reference this file — they do not redefine these rules. For longer code examples, see `references/code-examples.md`.

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

If the repo is not on the latest .NET/C# version, preserve compatibility — do not force upgrades.

## 2. Core Rules

These apply to ALL C# work. When applying them, **readability is the tiebreaker** — a rule that makes code harder to understand in context should be noted but not blindly followed.

Prefer:
- Linear flow over callbacks/indirection
- Explicit over implicit
- Named intermediate values over long chains
- Early returns over deep nesting
- Fewer abstractions until duplication forces one

### Async

- Propagate `CancellationToken` through every async call chain. Without it, long-running operations can't be cancelled on request abort, wasting server resources.
- **No `async void`** — only valid for event handlers. Exceptions in `async void` crash the process because they can't be observed.
- **No sync-over-async** — never use `.Result`, `.Wait()`, `.GetAwaiter().GetResult()`. These block the calling thread and cause thread pool starvation under load.
- **No fire-and-forget** — every `Task` must be `await`ed. Unobserved tasks swallow exceptions silently.
- Use `Task.WhenAll` for independent concurrent work.
- **Library code**: use `ConfigureAwait(false)` on all awaits. Library code doesn't need the synchronization context, and capturing it causes deadlocks in non-ASP.NET consumers (WPF, WinForms). Application code (controllers, services in ASP.NET) should NOT use `ConfigureAwait(false)`.

### Resource Management

- **Use `using` / `await using`** for all `IDisposable` / `IAsyncDisposable` — prevents resource leaks.
- **Never `new HttpClient()` per request** — use `IHttpClientFactory`. Each `HttpClient` instance holds a socket; creating them per-request exhausts the OS socket pool.
- External API calls must go through a typed client interface, not scattered `HttpClient` usage. This centralizes retry/timeout policies and makes the dependency explicit for testing.

### EF Core

- `AsNoTracking()` for all read-only queries. Tracking adds overhead for change detection that's wasted on queries that never call `SaveChanges`.
- **No N+1** — use `Include()` for related data. Use `AsSplitQuery()` when including multiple collections to avoid cartesian explosion (one row per combination).
- **No `FromSqlRaw` with string concatenation** — use `FromSql($"...")` interpolation. EF Core parameterizes interpolated `FromSql` automatically; `FromSqlRaw` with concatenation is a SQL injection vector.
- **No client-side evaluation** — avoid `AsEnumerable()` or premature `ToList()` before filtering. This pulls the entire table into memory.
- DbContext lifetime must be **Scoped** (not Singleton — DbContext isn't thread-safe).
- **Prefer data annotations** (`[Key]`, `[MaxLength]`, `[Required]`, `[Column]`, `[Table]`, `[ForeignKey]`, `[Index]`) over `IEntityTypeConfiguration`. Annotations colocate constraints with the property, making them visible without navigating to a separate config class. Use fluent config only for things annotations can't express: composite keys, owned types, query filters, table splitting, many-to-many with payload, `HasPrecision`.
- **Prefer `DbContext` directly for simple queries — in services or query classes, NEVER in controllers/endpoints.** Extract a named query class (e.g., `OrderQueries`) only when the same complex query appears in 2+ services or when scattering queries across services hurts readability.
- **Never edit generated migration files** — use `dotnet ef migrations add/remove`.
- Use `IAsyncEnumerable<T>` with `AsAsyncEnumerable()` when streaming large result sets to avoid buffering everything in memory.

### Logging

- **New code: use `[LoggerMessage]` source generator** — not `_logger.LogXxx(...)`. The source generator avoids boxing, allocations, and string formatting when the log level is disabled. Make the class `partial` to enable it.
- **Existing code using traditional `_logger.LogXxx`**: don't mix styles in the same class. Either migrate the whole class to `[LoggerMessage]` or keep traditional — consistency within a file matters more than the pattern choice.
- Define `[LoggerMessage]` methods as `private static partial void` at the bottom of the class, grouped together.
- Use structured message templates — **no string interpolation** (`$"..."`) in log calls. Interpolation defeats structured logging because the message becomes a flat string.
- When using `[LoggerMessage]`, no manual `IsEnabled` guards are needed — the generated code handles level checks. When using traditional `_logger.LogXxx`, guard `LogDebug`/`LogTrace` with `IsEnabled` if arguments involve allocation or computation.

### Dependency Injection

Choose service lifetime by the service's characteristics, not a blanket default:

| Lifetime | When |
|---|---|
| **Scoped** | Touches request-scoped resources (DbContext, current user, unit-of-work) |
| **Singleton** | Stateless or internally thread-safe, expensive to construct, or shared config (`JsonSerializerOptions`, channel readers, `IHttpClientFactory` handlers) |
| **Transient** | Lightweight, no shared state, short-lived (validators, mappers) |

- **No captive dependencies** — never inject Scoped/Transient into a Singleton. The dependency is promoted to Singleton lifetime and never released per request.
- **No service locator** — don't resolve via `IServiceProvider.GetService<T>()`. It hides dependencies and makes the class untestable without a full container.
- **No `new`-ing services** — everything through DI. Direct instantiation breaks testability and bypasses lifetime management.
- Register services by module using extension methods; keep `Program.cs` focused on composition.
- Prefer `JsonSerializerOptions` / naming policies over per-property `[JsonPropertyName]`. Global policies avoid repetitive annotations and ensure consistency.
- Use options objects for external config (not scattered string keys). Bind once in the module registration, inject `IOptions<T>` where needed.

### ASP.NET Core

- **Controllers are thin** — validate request, delegate to service, map response. No business logic. Business logic in controllers is untestable without HTTP plumbing.
- **Never inject `DbContext` (or a derived `ApplicationDbContext`/`AppDbContext` etc.) into a Controller or a Minimal API endpoint handler.** The HTTP boundary depends on a service, query class, or handler — never on EF Core directly. Reasons: couples HTTP plumbing to persistence; prevents unit testing without spinning up a DB; bypasses cross-cutting concerns (transactions, caching, authorization filtering, tenancy). Applies to both MVC controllers and Minimal API delegates. If you see `DbContext` in a controller, move the query into a service or a dedicated query class and inject that instead.
- Middleware ordering matters: `UseAuthentication` before `UseAuthorization`, `UseRouting` before `UseEndpoints`.
- Apply authorization at group level (not per-endpoint) to avoid accidentally leaving endpoints unprotected.
- Use policy-based authorization over role checks. Policies are composable and testable; role strings are fragile.
- Use built-in Minimal API validation (`[Required]`, `[Range]`); FluentValidation only if already adopted.
- **Use `ProblemDetails` for all error responses.** Call `builder.Services.AddProblemDetails()` and let the exception handler middleware produce consistent RFC 9457 responses. Don't invent custom error shapes.

### Error Handling

- **No `throw ex;`** — always use `throw;` to preserve the original stack trace.
- **No exception swallowing** — empty `catch` blocks or catching `Exception` without logging/rethrowing hide bugs.
- Use typed domain exceptions (e.g., `OrderNotFoundException`, `InsufficientStockException`) for business rule violations. Map them to appropriate HTTP status codes in the API layer.
- For infrastructure failures (database timeouts, API call failures), let exceptions propagate to the global error handler. Don't catch and rewrap unless you're adding meaningful context.

### Testing — NUnit

- **Test naming: `[Action]_When[Scenario]_Then[Expectation]`**
- Follow Arrange-Act-Assert structure.
- Use `Assert.That` with constraint model (`Is.EqualTo`, `Is.True`, etc.) — not `Assert.AreEqual`. The constraint model provides better error messages and composability.
- Use `Assert.Multiple` to group related assertions — all assertions run even if one fails, giving a complete picture.
- Use `Assert.ThrowsAsync<T>` for async exception tests (not `Assert.Throws<T>` — it won't unwrap the task).
- **No FluentAssertions** — NUnit's constraint model covers the same ground without an extra dependency.
- **No AutoMapper** — map explicitly (see Code Style § Mapping).
- Use test categories (`[UnitTest]`, `[IntegrationTest]`, `[StagingOnly]`) for CI filtering.
- Prefer Testcontainers for integration tests over shared databases — each test run gets an isolated container.
- Use `WebApplicationFactory<TEntryPoint>` for full API integration tests.

### Packages

- **MIT / Apache-2.0 licenses only** — no commercial NuGet packages.

## 3. Code Style

- Match existing repository conventions — inspect actual code before assuming patterns.
- **Seal classes not designed for inheritance.** `sealed` enables JIT devirtualization and signals intent. Only leave a class unsealed when you've designed it for extension.
- **Use `record` for DTOs, API contracts, and value objects** — they get value equality, `with` expressions, and deconstruction for free. Use `class` for stateful services and entities with identity.
- **Map explicitly** using static methods or extensions on the target type. Explicit mapping is searchable, debuggable, and fails at compile time when shapes change. See `references/code-examples.md` § Manual Mapping.
- **Private static readonly fields** use `_camelCase` prefix.
- **Prefer primary constructors** for all classes and records — including large dependency lists. Use traditional constructors only when you need constructor body logic (validation, computed fields, conditional assignment). If the repo uses classic constructors, follow that style — don't mix.
- **One type per file** — unless types are tightly coupled (discriminated union variants, a record + nested builder, private nested types).
- **Member ordering** (top to bottom):
  1. Public/internal constants and static fields
  2. Public/internal instance fields and auto-properties
  3. Constructor(s)
  4. Public/internal methods and properties
  5. Protected fields, properties, methods
  6. Private fields and properties
  7. Private methods
- **Blank line between access-level groups.**
- Add `using` imports — **never** write fully qualified type names inline.
- Replace magic values with named constants (`nameof()`, `const` fields).
- Remove dead code: unused `using`, parameters, variables, commented-out blocks.
- LINQ: no `ToList()` before `Where()`, no multiple enumerations, use `Any()` not `Count() > 0`.
- **Use collection expressions** (`[.. source]`) instead of `.ToList()` / `.ToArray()` for collection initialization. Rider flags `.ToList()` as simplifiable — prefer `[.. query]` which is shorter and lets the compiler pick the optimal backing type.
- Avoid broad refactors unless explicitly requested.

### Modern C# Features

Use only when the repo's target framework supports the feature:

| Feature | Since | Use For |
|---|---|---|
| Source-generated regex (`[GeneratedRegex]`) | .NET 7 / C# 11 | Hot-path regex without runtime compilation cost |
| `System.Threading.Lock` | .NET 9 / C# 13 | Explicit lock objects with better semantics than `object` |
| `field` keyword in property accessors | .NET 10 / C# 14 | Validation/normalization without backing field boilerplate |
| Null-conditional assignment (`x?.Prop = value;`) | .NET 10 / C# 14 | Concise null-safe property setting |

## 4. References

- `references/code-examples.md` — runtime code samples (DI, EF Core, HTTP clients, auth, error handling, mapping, streaming). No rules.
- `references/test-code-examples.md` — test code samples (NUnit structure, Testcontainers, WebApplicationFactory, Respawn for DB reset, parallel execution, Podman compatibility, Aspire testing interop, common pitfalls).
- `references/project-structure.md` — solution/project scaffolding: layouts, `Directory.Build.props`, `Directory.Packages.props`, `global.json`, `.editorconfig`. Use when creating new solutions.
- For .NET Aspire projects, use the `aspire` skill and `mcp__aspire__*` MCP tools.
- **Aspire CLI in non-interactive agents**: All `aspire` commands that target a running AppHost require `--apphost <full-path>`, otherwise the CLI opens an interactive selector that fails in non-interactive terminals. Always run `aspire ps` first to get the full AppHost `.csproj` path, then pass it to every subsequent command (e.g. `aspire logs <resource> --apphost /full/path/to/AppHost.csproj`, `aspire otel logs <resource> --apphost ...`, `aspire resource <name> restart --apphost ...`).

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
