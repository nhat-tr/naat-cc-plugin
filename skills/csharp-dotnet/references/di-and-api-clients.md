# DI and API Client Reference

Use this reference when registering services or integrating external HTTP APIs.

## Isolate External APIs Behind Interfaces

Define API interfaces in application-facing layers:

```csharp
public interface IPaymentGatewayClient
{
    Task<PaymentResult> ChargeAsync(ChargeRequest request, CancellationToken ct);
    Task<RefundResult> RefundAsync(string paymentId, decimal amount, CancellationToken ct);
}
```

Implement clients in infrastructure with typed `HttpClient`:

```csharp
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
        var response = await http.PostAsJsonAsync("/v1/refunds", new { paymentId, amount }, ct);
        response.EnsureSuccessStatusCode();

        return await response.Content.ReadFromJsonAsync<RefundResult>(ct)
            ?? throw new InvalidOperationException("Null response from payment gateway");
    }
}
```

## Register Services by Module

Group related registrations in extension methods:

```csharp
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
```

Keep `Program.cs` focused on composition:

```csharp
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddOrderServices();
builder.Services.AddPaymentServices(builder.Configuration);
```

## Prefer DbContext Over Repository Wrappers

Inject `DbContext` directly into services unless the repository class encapsulates genuinely reusable, complex query logic or a multi-step operation that would otherwise be duplicated:

```csharp
// Prefer this for simple data access
public class OrderService(AppDbContext db, ILogger<OrderService> logger)
{
    public async Task<Order?> GetAsync(int id, CancellationToken ct) =>
        await db.Orders.AsNoTracking().FirstOrDefaultAsync(o => o.Id == id, ct);
}

// Add a repository class only when it meaningfully reduces duplication
// across multiple consumers, or when it isolates a complex multi-step query.
```

## Avoid Singleton Traps

Prefer `AddScoped` for services that touch request-scoped resources. Use `AddSingleton` only when the type is:

1. Truly stateless or uses its own internal thread-safe state.
2. Thread-safe for concurrent access without locks on mutable fields.
3. Expensive enough to construct that a single instance is worth sharing.

Common mistake — never inject a `Scoped` or `Transient` dependency into a `Singleton`. The dependency is effectively promoted to `Singleton` lifetime and is never released per request:

```csharp
// Bad — DbContext (Scoped) captured inside a Singleton
services.AddSingleton<ReportGenerator>(); // ReportGenerator takes AppDbContext

// Good — make ReportGenerator Scoped, or pass a factory
services.AddScoped<ReportGenerator>();
```

## Prefer JsonOptions Over JsonPropertyName

Configure JSON naming conventions via `JsonSerializerOptions` or ASP.NET Core JSON options rather than decorating properties with `[JsonPropertyName]`:

```csharp
// Preferred — apply naming policy globally
builder.Services.AddControllers().AddJsonOptions(options =>
{
    options.JsonSerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
    options.JsonSerializerOptions.PropertyNameCaseInsensitive = true;
});

// Or for System.Text.Json serializer directly
var jsonOptions = new JsonSerializerOptions
{
    PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    PropertyNameCaseInsensitive = true,
};

// Avoid scattering [JsonPropertyName("camelCase")] on every property —
// use it only when a single property must deviate from the global policy.
```

## Prefer Options for Client Configuration

Use options objects for URLs and credentials to avoid scattered string keys:

```csharp
public sealed class PaymentOptions
{
    public required string BaseUrl { get; init; }
    public required string ApiKey { get; init; }
}
```

Then bind once and register typed clients from validated options.
