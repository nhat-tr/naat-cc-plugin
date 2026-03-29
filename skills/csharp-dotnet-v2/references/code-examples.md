# Code Examples

Pure code samples for patterns defined in SKILL.md. No rules here — see SKILL.md for the authoritative guidance.

## Table of Contents

- [LoggerMessage Source Generator](#loggermessage-source-generator)
- [Typed HTTP Client with Options](#typed-http-client-with-options)
- [Module Registration](#module-registration)
- [ProblemDetails Error Handling](#problemdetails-error-handling)
- [Primary Constructor Service](#primary-constructor-service)
- [CancellationToken Propagation](#cancellationtoken-propagation)
- [Task.WhenAll for Concurrent Work](#taskwhenall-for-concurrent-work)
- [IAsyncEnumerable Streaming](#iasyncenumerable-streaming)
- [EF Core Data Annotations](#ef-core-data-annotations)
- [Manual Mapping](#manual-mapping)
- [Test Naming and Structure](#test-naming-and-structure)
- [Test Categories](#test-categories)
- [Testcontainers Setup](#testcontainers-setup)
- [WebApplicationFactory with Testcontainers](#webapplicationfactory-with-testcontainers)

## LoggerMessage Source Generator

Demonstrates: SKILL.md § Logging

```csharp
public sealed partial class OrderService(
    IOrderRepository orderRepo,
    ILogger<OrderService> logger)
{
    public async Task<Order> CreateAsync(CreateOrderRequest request, CancellationToken ct)
    {
        LogCreatingOrder(logger, request.CustomerId);
        var order = await orderRepo.CreateAsync(request, ct);
        LogOrderCreated(logger, order.Id, request.CustomerId);
        return order;
    }

    [LoggerMessage(Level = LogLevel.Information, Message = "Creating order for customer {CustomerId}")]
    private static partial void LogCreatingOrder(ILogger logger, string customerId);

    [LoggerMessage(Level = LogLevel.Information, Message = "Order {OrderId} created for customer {CustomerId}")]
    private static partial void LogOrderCreated(ILogger logger, int orderId, string customerId);
}
```

## Typed HTTP Client with Options

Demonstrates: SKILL.md § Resource Management, § DI

```csharp
// Options
public sealed class ShippingApiOptions
{
    public required string BaseUrl { get; init; }
    public required string ApiKey { get; init; }
    public int TimeoutSeconds { get; init; } = 30;
}

// Interface
public interface IShippingApiClient
{
    Task<ShippingStatus> GetStatusAsync(string trackingId, CancellationToken ct);
}

// Implementation
public sealed class ShippingApiClient(HttpClient httpClient) : IShippingApiClient
{
    public async Task<ShippingStatus> GetStatusAsync(string trackingId, CancellationToken ct)
    {
        var response = await httpClient.GetAsync($"/api/shipments/{trackingId}", ct);
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadFromJsonAsync<ShippingStatus>(ct)
            ?? throw new InvalidOperationException("Null response from shipping API");
    }
}

// Registration
public static class ShippingServiceCollectionExtensions
{
    public static IServiceCollection AddShippingClient(
        this IServiceCollection services, IConfiguration config)
    {
        services.Configure<ShippingApiOptions>(config.GetSection("Shipping"));

        services.AddHttpClient<IShippingApiClient, ShippingApiClient>((sp, client) =>
        {
            var options = sp.GetRequiredService<IOptions<ShippingApiOptions>>().Value;
            client.BaseAddress = new Uri(options.BaseUrl);
            client.DefaultRequestHeaders.Add("X-Api-Key", options.ApiKey);
            client.Timeout = TimeSpan.FromSeconds(options.TimeoutSeconds);
        });

        return services;
    }
}
```

## Module Registration

Demonstrates: SKILL.md § DI

```csharp
public static class OrderServiceCollectionExtensions
{
    public static IServiceCollection AddOrderServices(this IServiceCollection services)
    {
        services.AddScoped<IOrderRepository, OrderRepository>();
        services.AddScoped<IOrderService, OrderService>();
        return services;
    }
}

// Program.cs stays focused on composition
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddOrderServices();
builder.Services.AddShippingClient(builder.Configuration);
builder.Services.AddProblemDetails();
```

## ProblemDetails Error Handling

Demonstrates: SKILL.md § ASP.NET Core, § Error Handling

```csharp
// Program.cs setup
builder.Services.AddProblemDetails();

var app = builder.Build();
app.UseExceptionHandler();
app.UseStatusCodePages();

// Custom exception handler for domain exceptions
app.UseExceptionHandler(errorApp =>
{
    errorApp.Run(async context =>
    {
        var exception = context.Features.Get<IExceptionHandlerFeature>()?.Error;
        var problemDetails = exception switch
        {
            OrderNotFoundException e => new ProblemDetails
            {
                Status = StatusCodes.Status404NotFound,
                Title = "Order not found",
                Detail = e.Message
            },
            InsufficientStockException e => new ProblemDetails
            {
                Status = StatusCodes.Status409Conflict,
                Title = "Insufficient stock",
                Detail = e.Message
            },
            _ => new ProblemDetails
            {
                Status = StatusCodes.Status500InternalServerError,
                Title = "An unexpected error occurred"
            }
        };

        context.Response.StatusCode = problemDetails.Status ?? 500;
        await context.Response.WriteAsJsonAsync(problemDetails);
    });
});
```

## Primary Constructor Service

Demonstrates: SKILL.md § Code Style

```csharp
public sealed class OrderService(
    AppDbContext db,
    IShippingApiClient shipping,
    ILogger<OrderService> logger)
{
    public async Task<Order> CreateAsync(CreateOrderRequest request, CancellationToken ct)
    {
        // Business logic here
    }
}
```

## CancellationToken Propagation

Demonstrates: SKILL.md § Async

```csharp
public async Task<Order> GetOrderAsync(int id, CancellationToken ct)
{
    var order = await db.Orders.AsNoTracking().FirstOrDefaultAsync(o => o.Id == id, ct)
        ?? throw new OrderNotFoundException(id);

    var shipping = await shippingClient.GetStatusAsync(order.TrackingId, ct);
    return order with { ShippingStatus = shipping.Status };
}
```

## Task.WhenAll for Concurrent Work

Demonstrates: SKILL.md § Async

```csharp
public async Task<DashboardDto> GetDashboardAsync(int userId, CancellationToken ct)
{
    var ordersTask = orderRepo.GetRecentAsync(userId, ct);
    var notificationsTask = notificationService.GetUnreadAsync(userId, ct);
    var profileTask = userRepo.GetProfileAsync(userId, ct);

    await Task.WhenAll(ordersTask, notificationsTask, profileTask);

    return new DashboardDto(
        Orders: await ordersTask,
        Notifications: await notificationsTask,
        Profile: await profileTask);
}
```

## IAsyncEnumerable Streaming

Demonstrates: SKILL.md § EF Core

```csharp
public async IAsyncEnumerable<OrderDto> StreamOrdersAsync(
    int customerId,
    [EnumeratorCancellation] CancellationToken ct)
{
    await foreach (var order in db.Orders
        .Where(o => o.CustomerId == customerId)
        .AsNoTracking()
        .AsAsyncEnumerable()
        .WithCancellation(ct))
    {
        yield return order.ToDto();
    }
}
```

## EF Core Data Annotations

Demonstrates: SKILL.md § EF Core

```csharp
[Table("orders")]
public class Order
{
    [Key]
    public int Id { get; set; }

    [Required, MaxLength(50)]
    public string CustomerId { get; set; } = string.Empty;

    [Required]
    public OrderStatus Status { get; set; }

    [Column(TypeName = "decimal(18,2)")]
    public decimal Total { get; set; }

    public List<LineItem> LineItems { get; set; } = [];
}
```

## Manual Mapping

Demonstrates: SKILL.md § Code Style

```csharp
public static class OrderDtoExtensions
{
    public static OrderDto ToDto(this Order order) => new(
        Id: order.Id,
        Status: order.Status.ToString(),
        Total: order.LineItems.Sum(li => li.Price * li.Quantity));

    public static IReadOnlyList<OrderDto> ToDtos(this IEnumerable<Order> orders) =>
        orders.Select(o => o.ToDto()).ToList();
}
```

## Test Naming and Structure

Demonstrates: SKILL.md § Testing

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

Demonstrates: SKILL.md § Testing

```csharp
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

## Testcontainers Setup

Demonstrates: SKILL.md § Testing

```csharp
private PostgreSqlContainer _postgres = null!;

[OneTimeSetUp]
public async Task OneTimeSetUp()
{
    _postgres = new PostgreSqlBuilder()
        .WithImage("postgres:17")
        .Build();
    await _postgres.StartAsync();
}

[OneTimeTearDown]
public async Task OneTimeTearDown()
{
    await _postgres.DisposeAsync();
}
```

## WebApplicationFactory with Testcontainers

Demonstrates: SKILL.md § Testing

```csharp
[TestFixture]
public class OrderApiTests
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
                    var descriptor = services.SingleOrDefault(
                        d => d.ServiceType == typeof(DbContextOptions<AppDbContext>));
                    if (descriptor is not null) services.Remove(descriptor);

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
        _client.Dispose();
        await _factory.DisposeAsync();
        await _postgres.DisposeAsync();
    }

    [Test, IntegrationTest]
    public async Task CreateOrder_WhenValid_ThenReturns201()
    {
        // Arrange
        var request = new CreateOrderRequest("cust-1", [new LineItem("SKU-1", 2)]);

        // Act
        var response = await _client.PostAsJsonAsync("/api/orders", request);

        // Assert
        Assert.That(response.StatusCode, Is.EqualTo(HttpStatusCode.Created));
    }
}
```
