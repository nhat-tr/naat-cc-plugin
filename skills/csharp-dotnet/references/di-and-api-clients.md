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
