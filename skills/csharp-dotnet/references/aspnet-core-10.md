# ASP.NET Core 10 Reference

Use this reference for API endpoint design, composition, and logging.

## Prefer Cohesive Endpoint Modules

Group endpoints by route area:

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
        int id,
        IOrderService service,
        CancellationToken ct)
    {
        var order = await service.GetAsync(id, ct);
        return order is not null ? TypedResults.Ok(order) : TypedResults.NotFound();
    }
}
```

Use controllers when a repository already follows controller conventions.

## Keep Composition Root Clean

Use extension methods for domain registration and call them from `Program.cs`.

## Use Structured Logging

Use message templates with named properties:

```csharp
logger.LogInformation("Order {OrderId} created for customer {CustomerId}", orderId, customerId);
logger.LogWarning("Payment {PaymentId} failed with status {Status}", paymentId, status);
```

Avoid interpolated strings in logs to preserve structured fields.
