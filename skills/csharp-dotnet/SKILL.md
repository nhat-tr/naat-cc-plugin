---
name: csharp-dotnet
description: C#/.NET 10 patterns, conventions, and best practices. Covers project structure, EF Core 10, ASP.NET Core 10, DI, async, testing with NUnit, and modern C# 14 idioms.
---

# C# / .NET 10 Patterns

Patterns and conventions for .NET 10 / C# 14 codebases.

## When to Activate

- Writing or modifying C# code
- Setting up a new .NET project or solution
- Configuring EF Core models, queries, or migrations
- Building ASP.NET Core APIs (Minimal or Controllers)
- Registering services in DI
- Writing NUnit tests

## Project Structure

### Solution Organization
```
Solution.sln (or .slnx)
├── src/
│   ├── Domain/                  # Entities, value objects, domain events, interfaces
│   ├── Application/             # Use cases, DTOs, validators, MediatR handlers
│   ├── Infrastructure/          # EF Core, external API clients, file system, messaging
│   └── WebApi/                  # Controllers or Minimal APIs, middleware, Program.cs
├── tests/
│   ├── Domain.Tests/
│   ├── Application.Tests/
│   ├── Infrastructure.Tests/
│   └── WebApi.Tests/            # Integration tests with WebApplicationFactory
└── Directory.Build.props        # Shared properties (nullable, implicit usings, TFM)
```

### Directory.Build.props
```xml
<Project>
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
  </PropertyGroup>
</Project>
```

## Coding Conventions

### Primary Constructors (Required)
All classes with dependencies use primary constructors:
```csharp
// Standard service
public class OrderService(
    IOrderRepository repo,
    IShippingApiClient shipping,
    ILogger<OrderService> logger)
{
    public async Task<Order> CreateAsync(CreateOrderRequest req, CancellationToken ct)
    {
        logger.LogInformation("Creating order for {CustomerId}", req.CustomerId);
        // ...
    }
}
```

### Naming Conventions
| Element | Convention | Example |
|---------|-----------|---------|
| Class/Record/Struct | PascalCase | `OrderService` |
| Interface | IPascalCase | `IOrderRepository` |
| Method | PascalCase | `GetOrderAsync` |
| Async method | PascalCase + Async suffix | `CreateOrderAsync` |
| Property | PascalCase | `TotalAmount` |
| Private field | _camelCase | `_logger` |
| Parameter | camelCase | `orderId` |
| Constant | PascalCase | `MaxRetryCount` |
| Local variable | camelCase | `activeOrders` |
| Generic type | T + PascalCase | `TEntity`, `TResult` |

### Constants Over Magic Values
```csharp
// Domain constants grouped by area
public static class OrderConstants
{
    public const int MaxItemsPerOrder = 100;
    public const int PaymentTimeoutSeconds = 30;
    public const string DefaultCurrency = "USD";
}

public static class HttpHeaderNames
{
    public const string CorrelationId = "X-Correlation-Id";
    public const string ApiVersion = "X-Api-Version";
}

public static class CacheKeys
{
    public const string UserProfile = "user:profile:{0}";
    public const string OrderSummary = "order:summary:{0}";
}
```

### No Dead Code
- Remove all unused `using` directives (IDE/analyzer enforced)
- Remove unused variables, parameters, private methods, and fields
- Never commit commented-out code blocks — source control is the history

## External API Client Pattern

Every external API gets a dedicated client interface + implementation:

```csharp
// Interface in Application layer
public interface IPaymentGatewayClient
{
    Task<PaymentResult> ChargeAsync(ChargeRequest request, CancellationToken ct);
    Task<RefundResult> RefundAsync(string paymentId, decimal amount, CancellationToken ct);
}

// Implementation in Infrastructure layer
public class PaymentGatewayClient(HttpClient http, ILogger<PaymentGatewayClient> logger)
    : IPaymentGatewayClient
{
    public async Task<PaymentResult> ChargeAsync(ChargeRequest request, CancellationToken ct)
    {
        var response = await http.PostAsJsonAsync("/v1/charges", request, ct);
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadFromJsonAsync<PaymentResult>(ct)
            ?? throw new InvalidOperationException("Null response from payment gateway");
    }

    public async Task<RefundResult> RefundAsync(string paymentId, decimal amount, CancellationToken ct)
    {
        var response = await http.PostAsJsonAsync($"/v1/refunds", new { paymentId, amount }, ct);
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadFromJsonAsync<RefundResult>(ct)
            ?? throw new InvalidOperationException("Null response from payment gateway");
    }
}

// DI registration via extension method
public static class PaymentServiceCollectionExtensions
{
    public static IServiceCollection AddPaymentServices(
        this IServiceCollection services, IConfiguration config)
    {
        services.AddHttpClient<IPaymentGatewayClient, PaymentGatewayClient>(client =>
        {
            client.BaseAddress = new Uri(config["Payment:BaseUrl"]!);
            client.DefaultRequestHeaders.Add("Authorization", $"Bearer {config["Payment:ApiKey"]}");
            client.Timeout = TimeSpan.FromSeconds(OrderConstants.PaymentTimeoutSeconds);
        });
        return services;
    }
}
```

## DI Registration Pattern

Group registrations by domain in extension methods:

```csharp
// Each domain module has its own extension
public static class OrderServiceCollectionExtensions
{
    public static IServiceCollection AddOrderServices(this IServiceCollection services)
    {
        services.AddScoped<IOrderRepository, OrderRepository>();
        services.AddScoped<IOrderService, OrderService>();
        services.AddScoped<IOrderValidator, OrderValidator>();
        return services;
    }
}

// Program.cs stays clean
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddOrderServices();
builder.Services.AddPaymentServices(builder.Configuration);
builder.Services.AddShippingServices(builder.Configuration);
```

## Async Patterns

### CancellationToken — Always Propagate
```csharp
public async Task<Order> GetOrderAsync(int id, CancellationToken ct)
{
    var order = await repo.FindAsync(id, ct);
    var shipping = await shippingClient.GetStatusAsync(order.TrackingId, ct);
    return order with { ShippingStatus = shipping.Status };
}
```

### Parallel Async — Use Task.WhenAll
```csharp
public async Task<DashboardDto> GetDashboardAsync(int userId, CancellationToken ct)
{
    var ordersTask = orderRepo.GetRecentAsync(userId, ct);
    var notificationsTask = notificationService.GetUnreadAsync(userId, ct);
    var profileTask = userRepo.GetProfileAsync(userId, ct);

    await Task.WhenAll(ordersTask, notificationsTask, profileTask);

    return new DashboardDto(
        Orders: ordersTask.Result,
        Notifications: notificationsTask.Result,
        Profile: profileTask.Result);
}
```

## EF Core 10 Patterns

### DbContext — Scoped, Minimal Configuration
```csharp
public class AppDbContext(DbContextOptions<AppDbContext> options) : DbContext(options)
{
    public DbSet<Order> Orders => Set<Order>();
    public DbSet<Customer> Customers => Set<Customer>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.ApplyConfigurationsFromAssembly(typeof(AppDbContext).Assembly);
    }
}
```

### Read-Only Queries — AsNoTracking
```csharp
public async Task<List<OrderSummaryDto>> GetOrderSummariesAsync(
    int customerId, CancellationToken ct)
{
    return await context.Orders
        .AsNoTracking()
        .Where(o => o.CustomerId == customerId)
        .Select(o => new OrderSummaryDto(o.Id, o.Total, o.Status))
        .ToListAsync(ct);
}
```

### Multiple Collection Includes — AsSplitQuery
```csharp
public async Task<Order?> GetOrderWithDetailsAsync(int id, CancellationToken ct)
{
    return await context.Orders
        .Include(o => o.Items)
        .Include(o => o.Payments)
        .AsSplitQuery()
        .FirstOrDefaultAsync(o => o.Id == id, ct);
}
```

### LeftJoin (EF Core 10)
```csharp
var result = context.Products
    .LeftJoin(context.Categories,
        p => p.CategoryId, c => c.Id,
        (product, category) => new { product.Name, Category = category.Name ?? "Uncategorized" });
```

### Complex Types for JSON (EF Core 10)
```csharp
public class Order
{
    public int Id { get; set; }
    public required OrderMetadata Metadata { get; set; }
}

public class OrderMetadata
{
    public string? Notes { get; set; }
    public required string Source { get; set; }
    public int Priority { get; set; }
}

// Configuration
modelBuilder.Entity<Order>()
    .ComplexProperty(o => o.Metadata, m => m.ToJson());
```

### Named Query Filters (EF Core 10)
```csharp
modelBuilder.Entity<Order>()
    .HasQueryFilter("SoftDelete", o => !o.IsDeleted)
    .HasQueryFilter("Tenant", o => o.TenantId == tenantId);

// Selectively disable
var allOrders = await context.Orders
    .IgnoreQueryFilters(["SoftDelete"])
    .ToListAsync(ct);
```

## ASP.NET Core 10 Patterns

### Minimal API Endpoint
```csharp
public static class OrderEndpoints
{
    public static void MapOrderEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/api/orders").RequireAuthorization();

        group.MapGet("/{id:int}", GetOrderAsync);
        group.MapPost("/", CreateOrderAsync);
    }

    private static async Task<Results<Ok<OrderDto>, NotFound>> GetOrderAsync(
        int id, IOrderService service, CancellationToken ct)
    {
        var order = await service.GetAsync(id, ct);
        return order is not null ? TypedResults.Ok(order) : TypedResults.NotFound();
    }
}
```

### Structured Logging
```csharp
// Message templates — never string interpolation
logger.LogInformation("Order {OrderId} created for customer {CustomerId}", orderId, customerId);
logger.LogWarning("Payment {PaymentId} failed with status {Status}", paymentId, status);
```

## Modern .NET APIs

### System.Threading.Lock
```csharp
private readonly Lock _lock = new();

public void UpdateCache(string key, object value)
{
    lock (_lock) { _cache[key] = value; }
}
```

### GeneratedRegex
```csharp
public partial class Validators
{
    [GeneratedRegex(@"^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$")]
    public static partial Regex EmailRegex();
}
```

### FrozenDictionary
```csharp
private static readonly FrozenDictionary<string, string> MimeTypes =
    new Dictionary<string, string>
    {
        [".pdf"] = "application/pdf",
        [".json"] = "application/json",
        [".csv"] = "text/csv"
    }.ToFrozenDictionary();
```

### TimeProvider (Testable Time)
```csharp
public class TokenService(TimeProvider time)
{
    public bool IsExpired(Token token) => time.GetUtcNow() > token.ExpiresAt;
}
```

### HybridCache
```csharp
public class UserService(HybridCache cache, IUserRepository repo)
{
    public async Task<UserProfile> GetProfileAsync(int userId, CancellationToken ct)
    {
        return await cache.GetOrCreateAsync(
            $"user:profile:{userId}",
            async token => await repo.GetProfileAsync(userId, token),
            cancellationToken: ct);
    }
}
```

## C# 14 Features

### field Keyword
```csharp
public string Email
{
    get;
    set => field = value?.Trim().ToLowerInvariant()
        ?? throw new ArgumentNullException(nameof(value));
}
```

### Null-Conditional Assignment
```csharp
customer?.LastOrderDate = DateTimeOffset.UtcNow;
order?.Status = OrderStatus.Cancelled;
```

### Collection Expressions
```csharp
int[] ids = [1, 2, 3];
List<string> names = ["Alice", "Bob"];
ReadOnlySpan<byte> header = [0xFF, 0xD8, 0xFF];
```

## NUnit Testing

### Test Naming Convention
```
[Action]_When[Scenario]_Then[Expectation]
```

### Test Structure
```csharp
[TestFixture]
public class OrderServiceTests
{
    private IOrderRepository _repo;
    private IShippingApiClient _shipping;
    private OrderService _sut;

    [SetUp]
    public void SetUp()
    {
        _repo = Substitute.For<IOrderRepository>();
        _shipping = Substitute.For<IShippingApiClient>();
        _sut = new OrderService(_repo, _shipping, NullLogger<OrderService>.Instance);
    }

    [Test]
    public async Task CreateOrder_WhenItemsEmpty_ThenThrowsValidationException()
    {
        // Arrange
        var request = new CreateOrderRequest(CustomerId: 1, Items: []);

        // Act
        var act = () => _sut.CreateAsync(request, CancellationToken.None);

        // Assert
        await act.Should().ThrowAsync<ValidationException>()
            .WithMessage("*at least one item*");
    }

    [TestCase(0)]
    [TestCase(-1)]
    [TestCase(-100)]
    public async Task CreateOrder_WhenQuantityInvalid_ThenThrowsValidationException(int quantity)
    {
        // Arrange
        var request = new CreateOrderRequest(
            CustomerId: 1,
            Items: [new OrderItem(ProductId: 1, Quantity: quantity)]);

        // Act
        var act = () => _sut.CreateAsync(request, CancellationToken.None);

        // Assert
        await act.Should().ThrowAsync<ValidationException>();
    }

    [Test]
    public async Task GetOrder_WhenNotFound_ThenReturnsNull()
    {
        // Arrange
        _repo.FindAsync(999, Arg.Any<CancellationToken>()).Returns((Order?)null);

        // Act
        var result = await _sut.GetAsync(999, CancellationToken.None);

        // Assert
        Assert.That(result, Is.Null);
    }
}
```

### Test Categories — Filter by Environment

Use NUnit `[Category]` to control which tests run where:

```csharp
// Custom attributes for clarity and discoverability
[AttributeUsage(AttributeTargets.Method | AttributeTargets.Class)]
public class UnitTestAttribute : CategoryAttribute { }

[AttributeUsage(AttributeTargets.Method | AttributeTargets.Class)]
public class IntegrationTestAttribute : CategoryAttribute { }

[AttributeUsage(AttributeTargets.Method | AttributeTargets.Class)]
public class StagingOnlyAttribute : CategoryAttribute { }
```

Apply to tests:
```csharp
[UnitTest]           // Fast, no infra — runs everywhere
public async Task CreateOrder_WhenItemsEmpty_ThenThrows() { ... }

[IntegrationTest]    // Needs Testcontainers — runs in CI + local
public async Task CreateOrder_WhenValid_ThenPersistsToDb() { ... }

[StagingOnly]        // Hits real external APIs — only staging
public async Task CreateOrder_WhenValid_ThenSendsToPaymentGateway() { ... }
```

Filter via `dotnet test`:
```bash
# Local dev — unit tests only (fast feedback)
dotnet test --filter "TestCategory=UnitTest"

# CI pipeline — unit + integration (Testcontainers in CI)
dotnet test --filter "TestCategory=UnitTest|TestCategory=IntegrationTest"

# Staging — everything including external API tests
dotnet test --filter "TestCategory=UnitTest|TestCategory=IntegrationTest|TestCategory=StagingOnly"

# Exclude slow tests during local dev
dotnet test --filter "TestCategory!=StagingOnly&TestCategory!=IntegrationTest"
```

### Integration Tests with Testcontainers

Use Testcontainers to spin up real databases (PostgreSQL, SQL Server, etc.) in Docker for integration tests. No shared test databases, no cleanup scripts — each test run gets a fresh container.

```csharp
[TestFixture]
[IntegrationTest]
public class OrderRepositoryTests : IAsyncDisposable
{
    private PostgreSqlContainer _postgres = null!;
    private AppDbContext _db = null!;

    [OneTimeSetUp]
    public async Task OneTimeSetUp()
    {
        _postgres = new PostgreSqlBuilder()
            .WithImage("postgres:17")
            .Build();

        await _postgres.StartAsync();

        var options = new DbContextOptionsBuilder<AppDbContext>()
            .UseNpgsql(_postgres.GetConnectionString())
            .Options;

        _db = new AppDbContext(options);
        await _db.Database.MigrateAsync();
    }

    [OneTimeTearDown]
    public async Task OneTimeTearDown()
    {
        await DisposeAsync();
    }

    public async ValueTask DisposeAsync()
    {
        await _db.DisposeAsync();
        await _postgres.DisposeAsync();
    }

    [SetUp]
    public async Task SetUp()
    {
        // Clean data between tests — faster than recreating container
        await _db.Database.ExecuteSqlRawAsync(
            "TRUNCATE TABLE \"Orders\", \"OrderItems\" RESTART IDENTITY CASCADE");
    }

    [Test]
    public async Task CreateOrder_WhenValid_ThenPersistsWithCorrectData()
    {
        // Arrange
        var repo = new OrderRepository(_db);
        var order = new Order { CustomerId = 1, Total = 99.99m };

        // Act
        await repo.AddAsync(order, CancellationToken.None);
        await _db.SaveChangesAsync();

        // Assert
        var saved = await _db.Orders.FindAsync(order.Id);
        Assert.That(saved, Is.Not.Null);
        Assert.That(saved!.Total, Is.EqualTo(99.99m));
    }

    [Test]
    public async Task GetOrders_WhenMultipleExist_ThenReturnsAllForCustomer()
    {
        // Arrange
        var repo = new OrderRepository(_db);
        _db.Orders.AddRange(
            new Order { CustomerId = 1, Total = 10m },
            new Order { CustomerId = 1, Total = 20m },
            new Order { CustomerId = 2, Total = 30m });
        await _db.SaveChangesAsync();

        // Act
        var results = await repo.GetByCustomerAsync(1, CancellationToken.None);

        // Assert
        Assert.That(results, Has.Count.EqualTo(2));
    }
}
```

### Integration Tests with WebApplicationFactory + Testcontainers

Full API integration tests with a real database:

```csharp
[TestFixture]
[IntegrationTest]
public class OrderEndpointTests : IAsyncDisposable
{
    private PostgreSqlContainer _postgres = null!;
    private WebApplicationFactory<Program> _factory = null!;
    private HttpClient _client = null!;

    [OneTimeSetUp]
    public async Task OneTimeSetUp()
    {
        _postgres = new PostgreSqlBuilder()
            .WithImage("postgres:17")
            .Build();

        await _postgres.StartAsync();

        _factory = new WebApplicationFactory<Program>()
            .WithWebHostBuilder(builder =>
            {
                builder.ConfigureServices(services =>
                {
                    // Remove real DbContext registration
                    var descriptor = services.SingleOrDefault(
                        d => d.ServiceType == typeof(DbContextOptions<AppDbContext>));
                    if (descriptor is not null)
                        services.Remove(descriptor);

                    // Add Testcontainers connection
                    services.AddDbContext<AppDbContext>(options =>
                        options.UseNpgsql(_postgres.GetConnectionString()));
                });
            });

        _client = _factory.CreateClient();

        // Run migrations
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        await db.Database.MigrateAsync();
    }

    [OneTimeTearDown]
    public async Task OneTimeTearDown()
    {
        await DisposeAsync();
    }

    public async ValueTask DisposeAsync()
    {
        _client.Dispose();
        await _factory.DisposeAsync();
        await _postgres.DisposeAsync();
    }

    [Test]
    public async Task CreateOrder_WhenValid_ThenReturns201WithLocation()
    {
        // Arrange
        var request = new { customerId = 1, items = new[] { new { productId = 1, quantity = 2 } } };

        // Act
        var response = await _client.PostAsJsonAsync("/api/orders", request);

        // Assert
        Assert.That(response.StatusCode, Is.EqualTo(HttpStatusCode.Created));
        Assert.That(response.Headers.Location, Is.Not.Null);
    }

    [Test]
    public async Task GetOrder_WhenNotFound_ThenReturns404()
    {
        // Act
        var response = await _client.GetAsync("/api/orders/999");

        // Assert
        Assert.That(response.StatusCode, Is.EqualTo(HttpStatusCode.NotFound));
    }
}
```