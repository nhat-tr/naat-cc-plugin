# Test Code Examples

Pure test-code samples for patterns defined in SKILL.md § Testing. No rules here — SKILL.md is authoritative.

This file covers: NUnit structure, Testcontainers-based integration testing, WebApplicationFactory, DB reset, parallel execution, Podman compatibility, Aspire testing interop.

## Table of Contents

- [Test Naming and Structure](#test-naming-and-structure)
- [Test Categories](#test-categories)
- [Fixture-Scoped Testcontainer](#fixture-scoped-testcontainer)
- [Database Reset Between Tests (Respawn)](#database-reset-between-tests-respawn)
- [Migrations in Test Setup](#migrations-in-test-setup)
- [WebApplicationFactory + Testcontainers](#webapplicationfactory--testcontainers)
- [Parallel Test Execution](#parallel-test-execution)
- [Container Reuse Across Runs](#container-reuse-across-runs)
- [Podman Compatibility](#podman-compatibility)
- [When to Use Aspire.Hosting.Testing Instead](#when-to-use-aspirehostingtesting-instead)
- [Common Pitfalls](#common-pitfalls)

## Test Naming and Structure

Demonstrates: SKILL.md § Testing.

```csharp
[Test]
public async Task CreateOrder_WhenItemsEmpty_ThenThrowsValidationException()
{
    // Arrange
    var request = new CreateOrderRequest(CustomerId: "cust-1", Items: []);

    // Act & Assert
    Assert.ThrowsAsync<ValidationException>(
        async () => await sut.CreateAsync(request, CancellationToken.None));
}

[Test]
public async Task GetOrder_WhenExists_ThenReturnsCorrectDetails()
{
    // Arrange
    var order = await CreateTestOrder();

    // Act
    var result = await sut.GetAsync(order.Id, CancellationToken.None);

    // Assert
    Assert.Multiple(() =>
    {
        Assert.That(result, Is.Not.Null);
        Assert.That(result!.Id, Is.EqualTo(order.Id));
        Assert.That(result.Status, Is.EqualTo(OrderStatus.Created));
    });
}
```

## Test Categories

```csharp
// NUnit derives the category name from the attribute type, stripping "Attribute":
//   [UnitTest]        -> "UnitTest"
//   [IntegrationTest] -> "IntegrationTest"
//   [StagingOnly]     -> "StagingOnly"
[AttributeUsage(AttributeTargets.Method | AttributeTargets.Class)]
public sealed class UnitTestAttribute : CategoryAttribute { }

[AttributeUsage(AttributeTargets.Method | AttributeTargets.Class)]
public sealed class IntegrationTestAttribute : CategoryAttribute { }

[AttributeUsage(AttributeTargets.Method | AttributeTargets.Class)]
public sealed class StagingOnlyAttribute : CategoryAttribute { }
```

Filter in CI:

```bash
dotnet test --filter "TestCategory=UnitTest"
dotnet test --filter "TestCategory!=StagingOnly&TestCategory!=IntegrationTest"
```

## Fixture-Scoped Testcontainer

Default lifecycle: **one container per test fixture** (`[OneTimeSetUp]` / `[OneTimeTearDown]`). Per-test containers are too slow (2–5s × test count); fixture-scoped balances isolation and speed.

```csharp
[TestFixture, IntegrationTest]
public class OrderRepositoryTests
{
    private const string PostgresImage = "postgres:17"; // pin — match prod / Aspire version

    private PostgreSqlContainer _postgres = null!;

    [OneTimeSetUp]
    public async Task OneTimeSetUp()
    {
        _postgres = new PostgreSqlBuilder()
            .WithImage(PostgresImage)
            .Build();

        await _postgres.StartAsync();
    }

    [OneTimeTearDown]
    public async Task OneTimeTearDown()
    {
        await _postgres.DisposeAsync();
    }
}
```

`PostgreSqlBuilder` has built-in readiness logic — it polls the DB with actual queries before `StartAsync` returns. Do NOT rely on a naive `UntilPortIsAvailable` for databases; Postgres starts listening before it's ready to accept queries.

## Database Reset Between Tests (Respawn)

Per-test fresh containers = too slow. Transactional rollback = breaks when the code-under-test opens its own transactions. **Respawn** is the default: fast SQL-level DELETE/TRUNCATE of all non-system tables between tests.

```csharp
using Respawn;
using Respawn.Graph;

private Respawner _respawner = null!;
private string _connectionString = null!;

[OneTimeSetUp]
public async Task OneTimeSetUp()
{
    _postgres = new PostgreSqlBuilder().WithImage(PostgresImage).Build();
    await _postgres.StartAsync();
    _connectionString = _postgres.GetConnectionString();

    // ... apply migrations here (see next section)

    await using var conn = new NpgsqlConnection(_connectionString);
    await conn.OpenAsync();
    _respawner = await Respawner.CreateAsync(conn, new RespawnerOptions
    {
        DbAdapter = DbAdapter.Postgres,
        SchemasToInclude = ["public"],
        TablesToIgnore = [new Table("__EFMigrationsHistory")],
    });
}

[SetUp]
public async Task SetUp()
{
    await using var conn = new NpgsqlConnection(_connectionString);
    await conn.OpenAsync();
    await _respawner.ResetAsync(conn);
}
```

Key points:
- `TablesToIgnore` **must** include the EF migration history table — otherwise Respawn wipes it and the next test can't see the schema.
- `SchemasToInclude` scopes the reset — keep it to your app schemas to avoid wiping extensions.
- Respawn handles FK ordering automatically.

## Migrations in Test Setup

Use `MigrateAsync` (real migrations), NOT `EnsureCreated`. `EnsureCreated` builds schema from the model and silently diverges from what migrations produce — check constraints, default values, computed columns, and any raw SQL in migrations go missing.

```csharp
[OneTimeSetUp]
public async Task OneTimeSetUp()
{
    _postgres = new PostgreSqlBuilder().WithImage(PostgresImage).Build();
    await _postgres.StartAsync();

    var options = new DbContextOptionsBuilder<AppDbContext>()
        .UseNpgsql(_postgres.GetConnectionString())
        .Options;

    await using var db = new AppDbContext(options);
    await db.Database.MigrateAsync();
}
```

If migrations take >5s on every fixture, consider container reuse (next sections) or a pre-migrated image baked in CI.

## WebApplicationFactory + Testcontainers

Use `ConfigureTestServices`, **not** `ConfigureServices` — the former runs AFTER the app's own registration, so overrides actually win. Use `RemoveAll<T>` from `Microsoft.Extensions.DependencyInjection.Extensions` for clean replacement.

```csharp
using Microsoft.Extensions.DependencyInjection.Extensions;

[TestFixture, IntegrationTest]
public class OrderApiTests
{
    private const string PostgresImage = "postgres:17";

    private PostgreSqlContainer _postgres = null!;
    private WebApplicationFactory<Program> _factory = null!;
    private HttpClient _client = null!;

    [OneTimeSetUp]
    public async Task OneTimeSetUp()
    {
        _postgres = new PostgreSqlBuilder().WithImage(PostgresImage).Build();
        await _postgres.StartAsync();

        _factory = new WebApplicationFactory<Program>()
            .WithWebHostBuilder(builder =>
            {
                builder.ConfigureTestServices(services =>
                {
                    services.RemoveAll<DbContextOptions<AppDbContext>>();
                    services.RemoveAll<AppDbContext>();
                    services.AddDbContext<AppDbContext>(options =>
                        options.UseNpgsql(_postgres.GetConnectionString()));
                });
            });

        _client = _factory.CreateClient();

        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        await db.Database.MigrateAsync();
    }

    [OneTimeTearDown]
    public async Task OneTimeTearDown()
    {
        // Reverse order of acquisition: factory owns _client.
        await _factory.DisposeAsync();
        await _postgres.DisposeAsync();
    }

    [Test]
    public async Task CreateOrder_WhenValid_ThenReturns201()
    {
        var request = new CreateOrderRequest("cust-1", [new LineItem("SKU-1", 2)]);

        var response = await _client.PostAsJsonAsync("/api/orders", request);

        Assert.That(response.StatusCode, Is.EqualTo(HttpStatusCode.Created));
    }
}
```

Common mistake: removing `DbContextOptions<T>` but leaving the `DbContext` registration itself. The DI container then resolves the DbContext with the NEW options — usually fine — but any direct `IOptions<DbContextOptions<T>>` injection sees the original options. Remove both to avoid surprises.

## Parallel Test Execution

Within a single fixture, tests share the container — run them sequentially inside the fixture. Across fixtures, each fixture owns its container — parallel-safe.

```csharp
// AssemblyInfo.cs — top of the test project
[assembly: Parallelizable(ParallelScope.Fixtures)]
[assembly: LevelOfParallelism(4)]
```

Rules:
- `ParallelScope.Fixtures` — fixtures run in parallel, tests within a fixture run sequentially. **Correct default for Testcontainers.**
- `ParallelScope.Children` — tests within a fixture run in parallel. Breaks shared-container fixtures. Only use if every test creates its own container (slow).
- If a specific fixture must not parallelize (e.g. uses global state), add `[NonParallelizable]` to that class.

Port conflicts aren't an issue — Testcontainers binds to random high ports. CPU/memory contention can be; tune `LevelOfParallelism` to CPU count.

## Container Reuse Across Runs

For local dev, reuse containers across `dotnet test` invocations to skip the 2–5s startup per run. Off by default (shared state is a footgun in CI).

```csharp
_postgres = new PostgreSqlBuilder()
    .WithImage(PostgresImage)
    .WithReuse(true)           // opts THIS container into reuse
    .Build();
```

Must also set the environment variable globally (per-user):

```bash
export TESTCONTAINERS_REUSE_ENABLE=true
```

Testcontainers hashes the builder configuration to find a reusable container. Change any `.With*` call → new hash → new container. Keep a stable builder config for reuse to work.

**Do NOT enable reuse in CI.** CI should always start clean. Gate via env var in test code if needed:

```csharp
var builder = new PostgreSqlBuilder().WithImage(PostgresImage);
if (Environment.GetEnvironmentVariable("CI") is null)
    builder = builder.WithReuse(true);
_postgres = builder.Build();
```

Reuse + Respawn: reused container has data from previous runs. Respawn on `[SetUp]` handles this — wipes tables to a clean slate regardless of container age.

## Podman Compatibility

Testcontainers for .NET (3.x+) works with Podman. Two environment variables are the usual fix when tests fail to start:

```bash
# Point Testcontainers at the Podman socket (rootless mode)
export DOCKER_HOST="unix:///run/user/$(id -u)/podman/podman.sock"

# Disable Ryuk reaper if it fails to attach on Podman
export TESTCONTAINERS_RYUK_DISABLED=true
```

Without Ryuk, orphaned containers accumulate if tests crash hard. Manual cleanup:

```bash
podman ps -a --filter "label=org.testcontainers" -q | xargs -r podman rm -f
```

For rootful Podman or a user-systemd socket, the `DOCKER_HOST` path differs — run `podman info --format '{{.Host.RemoteSocket.Path}}'` to get the exact path.

Verify the setup before running a whole suite:

```bash
podman run --rm hello-world  # sanity check that podman itself works
dotnet test --filter "TestCategory=IntegrationTest" --logger "console;verbosity=detailed"
```

## When to Use Aspire.Hosting.Testing Instead

`Aspire.Hosting.Testing` spins up the entire AppHost for a test — useful when verifying cross-service flows (WebApi → message broker → worker → DB). Testcontainers stays better for single-service tests.

Decision:

| Scenario | Tool |
|---|---|
| Repository / service unit-ish test against a real DB | Testcontainers + WebApplicationFactory |
| API integration test for one service + its dependencies | Testcontainers + WebApplicationFactory |
| End-to-end test across multiple services coordinated by Aspire | `Aspire.Hosting.Testing` |
| Contract test between services | `Aspire.Hosting.Testing` |

Aspire testing pattern:

```csharp
using Aspire.Hosting.Testing;

[Test]
public async Task CreateOrder_FlowsThroughToWorker()
{
    await using var app = await DistributedApplicationTestingBuilder
        .CreateAsync<Projects.Solution_AppHost>();

    await using var host = await app.BuildAsync();
    await host.StartAsync();

    var httpClient = host.CreateHttpClient("webapi");
    var response = await httpClient.PostAsJsonAsync("/api/orders", new { ... });

    Assert.That(response.StatusCode, Is.EqualTo(HttpStatusCode.Created));
    // Assert downstream effect (DB row, queue message, etc.)
}
```

Aspire internally orchestrates containers for declared resources — no separate Testcontainers setup needed when using this pattern. The tradeoff is startup cost: an Aspire test host takes longer to boot than a single container.

## Common Pitfalls

- **Pin image versions.** `postgres:17` not `postgres:latest`. `latest` changes under you — silent test drift on CI refresh.
- **Match prod's image.** Postgres 15 locally but 17 in prod = you're not testing prod. Keep `PostgresImage` in sync with the Aspire / prod resource definition.
- **Don't mix `ConfigureServices` and `ConfigureTestServices`.** `ConfigureTestServices` runs after — use it. `ConfigureServices` in tests silently gets overridden by app `Program.cs`.
- **Never `new HttpClient()` in tests.** Use `factory.CreateClient()` — the factory wires auth handlers, base address, and test routing.
- **Dispose in reverse order of acquisition.** Factory before container. Otherwise in-flight requests can hit a stopped DB and confuse stack traces.
- **Don't share Respawner across fixtures.** `Respawner.CreateAsync` snapshots schema; if two fixtures differ in schema (migrations not applied to both), the wrong one gets reset.
- **Don't parallelize tests within a fixture that shares a container.** Deadlocks, data races, and flakiness. Use `ParallelScope.Fixtures`, not `Children`.
- **EnsureCreated is a trap for integration tests.** Always `MigrateAsync`. If migrations are slow, bake a pre-migrated image in CI or use container reuse locally.
- **Unhandled container leaks on Podman.** If Ryuk is disabled, add a CI post-step to `podman rm -f` any leftover testcontainers-labelled containers.
- **Test host port conflicts.** `WebApplicationFactory` binds to a random port by default — don't hardcode ports in test URLs. Use `factory.Server.BaseAddress` or the `HttpClient` base address.
