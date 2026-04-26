# Code Examples

Pure code samples for runtime patterns defined in SKILL.md. No rules here — see SKILL.md for the authoritative guidance. For test-related code samples (NUnit, Testcontainers, WebApplicationFactory, Respawn, Aspire testing, podman), see `test-code-examples.md`.

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
- [Group-Level Authorization](#group-level-authorization)
- [Policy-Based Authorization Setup](#policy-based-authorization-setup)
- [Global JsonSerializerOptions](#global-jsonserializeroptions)

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

Class is `sealed partial` — `sealed` per Code Style, `partial` required by the `[LoggerMessage]` source generator.

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

Use `IExceptionHandler` (.NET 8+) — the framework writes the RFC 9457 response from `AddProblemDetails()` automatically. One `UseExceptionHandler()` call, no manual JSON writing.

```csharp
public sealed class DomainExceptionHandler(IProblemDetailsService problemDetailsService) : IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(
        HttpContext httpContext,
        Exception exception,
        CancellationToken cancellationToken)
    {
        var (status, title) = exception switch
        {
            OrderNotFoundException => (StatusCodes.Status404NotFound, "Order not found"),
            InsufficientStockException => (StatusCodes.Status409Conflict, "Insufficient stock"),
            _ => (0, string.Empty),
        };

        if (status == 0) return false; // let the next handler / default pipeline take it

        httpContext.Response.StatusCode = status;
        return await problemDetailsService.TryWriteAsync(new ProblemDetailsContext
        {
            HttpContext = httpContext,
            Exception = exception,
            ProblemDetails = { Status = status, Title = title, Detail = exception.Message },
        });
    }
}
```

Registration:

```csharp
builder.Services.AddProblemDetails();
builder.Services.AddExceptionHandler<DomainExceptionHandler>();

var app = builder.Build();
app.UseExceptionHandler();
app.UseStatusCodePages();
```

## Primary Constructor Service

Demonstrates: SKILL.md § Code Style

```csharp
public sealed partial class OrderService(
    AppDbContext db,
    IShippingApiClient shipping,
    ILogger<OrderService> logger)
{
    public async Task<Order> CreateAsync(CreateOrderRequest request, CancellationToken ct)
    {
        LogCreating(logger, request.CustomerId);
        var order = await db.Orders.AddAsync(Order.From(request), ct);
        await db.SaveChangesAsync(ct);
        await shipping.GetStatusAsync(order.Entity.TrackingId, ct);
        return order.Entity;
    }

    [LoggerMessage(Level = LogLevel.Information, Message = "Creating order for {CustomerId}")]
    private static partial void LogCreating(ILogger logger, string customerId);
}
```

## CancellationToken Propagation

Demonstrates: SKILL.md § Async

```csharp
public async Task<OrderDto> GetOrderAsync(int id, CancellationToken ct)
{
    var order = await db.Orders.AsNoTracking().FirstOrDefaultAsync(o => o.Id == id, ct)
        ?? throw new OrderNotFoundException(id);

    var shipping = await shippingClient.GetStatusAsync(order.TrackingId, ct);
    return order.ToDto() with { ShippingStatus = shipping.Status };
}
```

`Order` is a persistence class (see EF Core Data Annotations); `OrderDto` is a record, so `with` is valid there. Pass `ct` through every await.

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

    [MaxLength(50)]
    public required string CustomerId { get; set; }

    [MaxLength(100)]
    public required string TrackingId { get; set; }

    public OrderStatus Status { get; set; }

    [Column(TypeName = "decimal(18,2)")]
    public decimal Total { get; set; }

    public List<LineItem> LineItems { get; set; } = [];
}
```

`required` (C# 11+) replaces the `[Required]` + `= string.Empty` pattern — the compiler forces initialization at construction, and EF Core still respects the NOT NULL column shape. Left unsealed because EF Core proxies (`UseLazyLoadingProxies`) subclass entities at runtime; seal entities only if you are certain proxies will never be enabled.

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

## Group-Level Authorization

Apply authorization at the group, not per-endpoint — avoids accidentally leaving endpoints unprotected.

```csharp
var group = app.MapGroup("/api/orders")
    .RequireAuthorization("OrderPolicy");

group.MapGet("/", GetOrders);
group.MapPost("/", CreateOrder);

// Public override when explicitly needed
group.MapGet("/public", GetPublicOrders).AllowAnonymous();
```

## Policy-Based Authorization Setup

Prefer policies over role-string checks. Policies compose and are testable.

```csharp
builder.Services.AddAuthorizationBuilder()
    .AddPolicy("OrderPolicy", policy =>
        policy.RequireAuthenticatedUser()
              .RequireClaim("scope", "orders"));
```

## Global JsonSerializerOptions

Configure naming globally — avoids sprinkling `[JsonPropertyName]` on every property. Use the attribute only when a single property must deviate.

MVC controllers use `AddJsonOptions`; Minimal APIs use `ConfigureHttpJsonOptions`. If the app hosts both, configure both — they don't share the same options instance.

```csharp
// Minimal APIs (Results.*, TypedResults.*, app.MapPost JSON binding)
builder.Services.ConfigureHttpJsonOptions(options =>
{
    options.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
    options.SerializerOptions.PropertyNameCaseInsensitive = true;
});

// MVC controllers
builder.Services.AddControllers().AddJsonOptions(options =>
{
    options.JsonSerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
    options.JsonSerializerOptions.PropertyNameCaseInsensitive = true;
});

// Standalone System.Text.Json serializer (outside the HTTP pipeline)
var jsonOptions = new JsonSerializerOptions
{
    PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    PropertyNameCaseInsensitive = true,
};
```
