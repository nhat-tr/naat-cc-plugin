# Project and Solution Structure

Scaffolding reference for **new** .NET solutions. For an existing repo, match its structure — everything below is a default, not a rule.

## 1. Pick a Layout

Three common shapes. Pick by team size and blast radius of a typical change, not by fashion.

### Option A — Clean / Onion (layered)

Best when: multiple bounded contexts, long-lived system, domain logic worth isolating from infra.

```text
Solution.slnx
├── src/
│   ├── Domain/            # Entities, value objects, domain rules (no framework refs)
│   ├── Application/       # Use cases, DTOs, validators, port interfaces
│   ├── Infrastructure/    # EF Core, integrations, file/messaging, adapter impls
│   └── WebApi/            # Endpoints, middleware, composition root
└── tests/
    ├── Domain.UnitTests/
    ├── Application.UnitTests/
    ├── Infrastructure.IntegrationTests/
    └── WebApi.IntegrationTests/
```

### Option B — Vertical Slice / Feature folders

Best when: CRUD-heavy API, small team, few cross-cutting abstractions. Each feature is self-contained.

```text
Solution.slnx
├── src/
│   └── WebApi/
│       ├── Features/
│       │   ├── Orders/    # endpoint + handler + dto + validator + ef config together
│       │   └── Customers/
│       ├── Infrastructure/
│       └── Program.cs
└── tests/
    └── WebApi.Tests/
        └── Features/
            └── Orders/
```

### Option C — Flat single-project API

Best when: prototype, internal tool, single-purpose microservice with <~10 endpoints.

```text
Solution.slnx
├── src/WebApi/
└── tests/WebApi.Tests/
```

**Tradeoff summary** (1–10; higher = more of that trait):

| Layout | Isolation | Discoverability | Ceremony cost | When to grow out of it |
|---|---|---|---|---|
| A (Clean) | 9 | 6 | 8 | Rarely — it scales |
| B (Vertical Slice) | 6 | 9 | 4 | When cross-feature rules emerge (move to A) |
| C (Flat) | 3 | 10 | 2 | At ~10 endpoints or first shared abstraction (move to B) |

Default to **B** for new APIs. Move to A only when shared domain rules surface.

## 2. .NET Aspire Layout

Required when running with `aspire` CLI (see CLAUDE.md). Add an AppHost and ServiceDefaults project alongside the API.

```text
Solution.slnx
├── src/
│   ├── Solution.AppHost/         # Aspire orchestration, resource graph
│   ├── Solution.ServiceDefaults/ # Shared OTel, health checks, resilience
│   └── WebApi/                   # References ServiceDefaults; registered by AppHost
└── tests/
    └── WebApi.Tests/
```

`AppHost` references `WebApi` as a project reference for the resource graph. `WebApi` references `ServiceDefaults` for the `builder.AddServiceDefaults()` call.

## 3. Solution File: `.sln` vs `.slnx`

| Format | When |
|---|---|
| `.sln` | SDK < 9, any team/tooling not yet on VS 17.10+ / Rider 2024.3+. Still the safe default. |
| `.slnx` | SDK ≥ 9 and confirmed tool support across the team's IDEs and CI. XML format, diff-friendly. |

If unsure, stay on `.sln` — swapping later is one `dotnet sln migrate` call.

## 4. Core Repo-Root Files

Every new solution should have these at the repository root:

```text
.
├── Solution.slnx (or .sln)
├── Directory.Build.props      # Shared MSBuild properties
├── Directory.Packages.props   # Central Package Management (CPM)
├── .editorconfig              # Style + analyzer severity
├── global.json                # Pin SDK version
└── .gitignore
```

### `Directory.Build.props`

Shared properties across all projects. Test projects override `IsPackable` and opt out of CPM where needed.

```xml
<Project>
  <PropertyGroup>
    <LangVersion>latest</LangVersion>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
    <AnalysisLevel>latest-recommended</AnalysisLevel>
    <EnforceCodeStyleInBuild>true</EnforceCodeStyleInBuild>
    <GenerateDocumentationFile>true</GenerateDocumentationFile>
    <NoWarn>$(NoWarn);CS1591</NoWarn> <!-- missing XML docs -->
  </PropertyGroup>

  <!-- Test projects: never pack, always use the test SDK defaults -->
  <PropertyGroup Condition="$(MSBuildProjectName.EndsWith('.Tests')) or $(MSBuildProjectName.EndsWith('.UnitTests')) or $(MSBuildProjectName.EndsWith('.IntegrationTests'))">
    <IsPackable>false</IsPackable>
    <IsTestProject>true</IsTestProject>
  </PropertyGroup>
</Project>
```

Set `TargetFramework` here only when the repository intentionally centralizes it. Otherwise leave it per-project so individual libraries can diverge when needed.

### `Directory.Packages.props` (Central Package Management)

Pin every NuGet version in one file. Prevents version drift across projects — a common source of runtime-only bugs when two projects load different versions of the same assembly.

```xml
<Project>
  <PropertyGroup>
    <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
    <CentralPackageTransitivePinningEnabled>true</CentralPackageTransitivePinningEnabled>
  </PropertyGroup>

  <ItemGroup>
    <PackageVersion Include="Microsoft.EntityFrameworkCore" Version="9.0.0" />
    <PackageVersion Include="Npgsql.EntityFrameworkCore.PostgreSQL" Version="9.0.2" />
    <PackageVersion Include="NUnit" Version="4.2.2" />
    <PackageVersion Include="Testcontainers.PostgreSql" Version="4.0.0" />
  </ItemGroup>
</Project>
```

Project files then reference packages **without** versions:

```xml
<PackageReference Include="Microsoft.EntityFrameworkCore" />
```

### `global.json`

Pin the SDK so `dotnet` picks the intended version in CI, containers, and on every dev machine.

```json
{
  "sdk": {
    "version": "9.0.100",
    "rollForward": "latestFeature"
  }
}
```

### `.editorconfig`

Pair with `Directory.Build.props` to enforce style and analyzer severity. Minimum:

```ini
root = true

[*.cs]
indent_style = space
indent_size = 4
end_of_line = lf
insert_final_newline = true
charset = utf-8

# Treat a handful of style rules as errors — catches them in build, not review.
dotnet_diagnostic.IDE0005.severity = error       # unused usings
dotnet_diagnostic.CA1822.severity = error        # mark members static
dotnet_diagnostic.CA2007.severity = none         # ConfigureAwait — app code, see SKILL.md § Async
```

## 5. Test Project Naming

Match test type to suffix so `dotnet test --filter` and CI wiring stay mechanical:

| Suffix | Contents |
|---|---|
| `.UnitTests` | Fast, no I/O, no containers. Run on every push. |
| `.IntegrationTests` | Testcontainers, `WebApplicationFactory`, real DB. Run on PR + main. |
| `.Tests` | Only when the split doesn't exist yet — migrate to the suffixed names once it does. |

The `[UnitTest]` / `[IntegrationTest]` category attributes (see `code-examples.md`) are the second filter layer — project name is the first.

## 6. Warnings Ratchet (`Directory.Build.props`)

Compiler-enforced replacement for the prose `dobw` gate. Session mining (2026-08) showed warnings recur invisibly for weeks (NU1902 37× across 16 sessions, never surfaced) when enforcement is left to filtered build output.

```xml
<Project>
  <PropertyGroup>
    <AnalysisLevel>latest</AnalysisLevel>
    <Nullable>enable</Nullable>
    <!-- Ratchet, don't boil the ocean: promote the categories that bite in
         multi-pod services first; widen once the repo is clean. -->
    <WarningsAsErrors>$(WarningsAsErrors);nullable;CS0618;NU1901;NU1902;NU1903;NU1904</WarningsAsErrors>
  </PropertyGroup>
</Project>
```

**Rollout order (per repo, never blind):**
1. `dobw` the full solution; triage every existing warning into fix-now vs `docs/known-warnings.md`.
2. Fix or `<NoWarn>` (with a comment naming the backlog entry) everything in the promoted categories — CI must be green on day one.
3. Land `Directory.Build.props` at repo root. It applies to every project beneath it; a project can opt out locally only with a written reason.
4. Widen `WarningsAsErrors` as the backlog shrinks.

This is a shared-CI change — coordinate with the team before landing; teammates' local builds inherit it immediately.
