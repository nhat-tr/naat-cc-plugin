---
name: csharp-dotnet
description: C# and .NET implementation guidance for backend, API, and data-layer work. Use when writing or modifying C# code, designing ASP.NET Core endpoints, configuring dependency injection, implementing EF Core queries or model configuration, applying async and concurrency patterns, writing NUnit tests, reviewing C# code, creating new .NET projects, or making NuGet package decisions. Start by matching existing repository conventions and target framework constraints; use modern C# patterns only when the repo's target framework supports them.
---

# C# / .NET — Core Rules

Non-negotiable C#/.NET rules, condensed. Agents, reviewers, and pair sessions read this file first. Full rationale, code samples, and scaffolding live in `references/` — see the Reference Map (§4) before assuming a one-liner below is the whole story.

## 1. Inspect Constraints First

**Skip these scans when the task is scoped to user-pinned files and adds no new pattern/dependency/project** (see the global Scoped Prompts rule — CLAUDE.md/AGENTS.md). Otherwise:

- `rg --files -g '*.csproj'`
- `rg -n '<TargetFramework|<LangVersion|<Nullable|<TreatWarningsAsErrors' -g '*.csproj'`
- `rg -n 'NUnit|xunit|MSTest|FluentAssertions|NSubstitute|Moq|Testcontainers' -g '*.csproj'`
- Scaffolding against an internal gateway (`dotnet graphql init`, client codegen): grep the repo's auth/tenant header conventions first (e.g. `X-TENANT-ID`, token providers) and include them (`--headers`) — never propose the bare command.

**If JetBrains Rider MCP is available**: `mcp__jetbrains__get_project_modules` (list projects), `get_project_dependencies <module>` (NuGet packages), `get_file_problems <file>` (Rider inspections), `reformat_file <file>` (apply formatting), `rename_refactoring` (project-wide rename). **Verify the MCP is actually connected before claiming IDE diagnostics were checked**; if not, say so — compiler output (`dobw`) and the local `csharp-lsp-proxy` plugin are the diagnostics channels (official csharp-lsp plugin stays disabled, upstream #1359).

If the repo is not on the latest .NET/C# version, preserve compatibility — do not force upgrades.

### Search & Read Discipline (token efficiency)

- **User-pinned files are the scope** — read those and only those; any other file needs a one-line justification (see the global Scoped Prompts rule — CLAUDE.md/AGENTS.md).
- **Use the runtime's native search tools (Claude Code Grep/Glob) where available** — gitignore-aware, `type: cs` filters, `head_limit`; in shell-only runtimes use `rg`, never `grep -r`/`find`.
- **Bound every search**: `head_limit` ≤ 20; no `-A`/`-B` on a first-pass existence check.
- **Grep first, then Read a window** (`offset`/`limit`); whole-file Read only under ~200 lines.
- **Never read whole patches/logs/`.trx`** — extract the needed lines (`sed -n`, `jq`, XML parse).
- **Never repeat an identical search/read in one session**; poll growing logs with `tail`, not whole-file greps.
- **Batch symbol lookups against a known file** into one combined-pattern grep.

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
- **Shared connection clients** (e.g. `ConnectionMultiplexer`): wire `ConnectionFailed`/`ConnectionRestored`/`ConfigurationChanged` logging at construction — silent stalls are invisible until a request breaks.

### State & Ambient Context

- **No `AsyncLocal<T>`/static ambient accessors for request/turn state** — pass an explicit context object. If the pattern already exists, add a fitness test forbidding `AsyncLocal<` before extending it (template: `references/test-code-examples.md` § Architecture Fitness Tests).

### EF Core

- `AsNoTracking()` for read-only queries.
- **No N+1** — `Include()`; `AsSplitQuery()` for multiple included collections.
- **No `FromSqlRaw` + string concatenation** — use `FromSql($"...")` interpolation.
- **No client-side evaluation** — avoid `AsEnumerable()`/premature `ToList()`.
- DbContext lifetime: **Scoped**.
- **Data annotations over `IEntityTypeConfiguration` for new entities — even in repos whose older entities use fluent config**; fluent only where annotations can't express it (composite keys, owned types, cascade details).
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

- **Services must be stateless — deployment is multi-pod.** Singleton only for immutable/thread-safe infrastructure (options, typed `HttpClient` handlers, `ConnectionMultiplexer`, source-gen loggers); mutable in-process state silently diverges per pod — cross-request state lives in the database or Redis.

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

### Static-Analysis & Review Fixes

- **Fix every instance of the defect pattern in the touched file**, check public-contract blast radius (Swagger), and treat review comments as intent, not diffs — details: `references/core-rules.md` § Static-Analysis & Review Fixes.

### LLM-Facing Tool Contracts (agent/tool repos)

- **`[Description]` must state what the implementation currently does; never return `null`/empty as an "already handled" signal; specific value-echoing messages for every LLM-visible exception** — details: `references/core-rules.md` § LLM-Facing Tool Contracts.

### Testing — NUnit

- **Naming: behavior sentences** — `Capability_verb_fact` (e.g. `Sync_merges_...`), trailing `when_<condition>` only for non-default paths; never the SUT method name or an `Async` suffix. Arrange-Act-Assert structure.
- `Assert.That` constraint model (not `Assert.AreEqual`), `Assert.Multiple` for grouped assertions, `Assert.ThrowsAsync<T>` for async exceptions.
- **No FluentAssertions. No AutoMapper** — map explicitly (see Code Style § Mapping).
- Test categories (`[UnitTest]`, `[IntegrationTest]`, `[StagingOnly]`) for CI filtering; Testcontainers over shared databases; `WebApplicationFactory<TEntryPoint>` for full API integration tests.
- **Testcontainers `.WithReuse(true)` needs reuse enabled on the runner, or every run leaks a container** (Ryuk is off on rootless Podman) — see `references/test-code-examples.md` § Container Reuse Across Runs.

### Packages

- **MIT / Apache-2.0 licenses only** — no commercial NuGet packages.

## 3. Code Style

- **Touched files: follow the file's existing pattern and conventions** — inspect actual code before assuming patterns. **New files: use the best option this skill prescribes**, even when older files carry a legacy pattern — do not propagate legacy patterns into new code.
- **Seal classes** not designed for inheritance.
- **Use `record`** for DTOs/API contracts/value objects; `class` for stateful services and entities with identity.
- **Map explicitly** (static methods/extensions). See `references/code-examples.md` § Manual Mapping.
- **Always use braces** for control-flow blocks, even single-statement. Allman style. See `references/code-examples.md` § Braces / Control-Flow Style.
- **Private static readonly fields**: `_camelCase` prefix.
- **Prefer primary constructors**; traditional constructors only when you need body logic. Follow the repo's existing style if it differs.
- **One type per file** — unless tightly coupled (discriminated union variants, record + nested builder, private nested types).
- **Member ordering and blank-line conventions** — full list in `references/core-rules.md` § Member Ordering.
- Add `using` imports — **never** write fully qualified type names inline.
- Named constants over magic values (`nameof()`, `const`); remove dead code — including rename-orphaned constants/policies (registered, referenced nowhere).
- **Parenthesize every mixed `&&`/`||` expression explicitly** — a missing paren silently produces an always-false/always-true sub-clause that compiles cleanly.
- **Repo wrapper over raw stdlib** (e.g. `RegexHelper` over `Regex`): use it for every call in the idiom family; if it lacks a method, use its equivalent (`Match(...).Success` for `IsMatch`); prefer the file's dominant idiom.
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

- Iterate: `dobq` (errors only). **Final gate: `dobw`** (errors + warnings, deduped).
- **A new warning in a touched file is blocking — fix it.** Defer pre-existing warnings by name into `docs/known-warnings.md` (repo-level human backlog; Pair's automated warning baseline is separate). "0 Warning(s)" proves nothing when the build was filtered (`-clp:ErrorsOnly` strips warnings). Compiler-enforced upgrade: `references/project-structure.md` § Warnings Ratchet.
- **Sandbox distrust**: a sandboxed build that runs ~5 min and reports `Build FAILED` with `0 Warning(s) 0 Error(s)` hung on MSBuild node handshake — re-run with `-m:1` or unsandboxed.
- **Formatting is a separate CI gate**: if the repo pins CSharpier (`.csharpierrc`), run the formatter check before declaring a build fixed.
- Test: `dotnet test` (or `--filter "TestCategory=UnitTest"`)
- **Green tests don't prove changed lines run** — when coverage of a risky change is in doubt, mutation-test: revert, confirm the test fails for the right reason, restore.
- If JetBrains Rider MCP is connected: run `mcp__jetbrains__get_file_problems` on touched files

### Debugging Failing Tests

When an HTTP assertion fails without a clear reason, read the response body before asserting:

```csharp
var response = await HttpClient.PostAsJsonAsync(...);
Console.WriteLine(await response.Content.ReadAsStringAsync());
Assert.That(response.StatusCode, Is.EqualTo(HttpStatusCode.OK));
```
