# Project and Style Reference

Use this reference for repo layout, naming, async conventions, and coding hygiene.

## Table of Contents

- Match Repository Structure First
- Apply Naming Conventions Consistently
- Use Primary Constructors Carefully
- Replace Magic Values with Named Constants
- Enforce Code Hygiene
- Apply Async Patterns

## Match Repository Structure First

Prefer existing structure if the repository already has a pattern. For new solutions, this layout is a strong default:

```text
Solution.sln (or .slnx)
├── src/
│   ├── Domain/          # Entities, value objects, domain rules
│   ├── Application/     # Use cases, DTOs, validators
│   ├── Infrastructure/  # EF Core, integrations, file/messaging
│   └── WebApi/          # Endpoints, middleware, composition root
├── tests/
│   ├── Domain.Tests/
│   ├── Application.Tests/
│   ├── Infrastructure.Tests/
│   └── WebApi.Tests/
└── Directory.Build.props
```

For shared props, keep nullable and warning policy explicit:

```xml
<Project>
  <PropertyGroup>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
  </PropertyGroup>
</Project>
```

Set `TargetFramework` only when the repository intentionally centralizes it.

## Apply Naming Conventions Consistently

- Use `PascalCase` for classes, methods, and properties.
- Use `IPascalCase` for interfaces.
- Use `camelCase` for parameters and locals.
- Use `Async` suffix for asynchronous methods.
- Use `T`-prefixed generic names (`TEntity`, `TResult`).

## Use Primary Constructors Carefully

Prefer primary constructors in repositories that already use modern C# patterns:

```csharp
public class OrderService(
    IOrderRepository repo,
    IShippingApiClient shipping,
    ILogger<OrderService> logger)
{
    public async Task<Order> CreateAsync(CreateOrderRequest request, CancellationToken ct)
    {
        logger.LogInformation("Creating order for {CustomerId}", request.CustomerId);
        return await repo.CreateAsync(request, ct);
    }
}
```

If the repository uses explicit private fields and classic constructors, follow that style instead of mixing patterns.

## Replace Magic Values with Named Constants

```csharp
public static class OrderConstants
{
    public const int MaxItemsPerOrder = 100;
    public const int PaymentTimeoutSeconds = 30;
    public const string DefaultCurrency = "USD";
}
```

Keep constants near domain boundaries or protocol boundaries (headers, cache keys, status mappings).

## Enforce Code Hygiene

- Remove unused `using` directives.
- Remove unused private members and parameters.
- Do not keep commented-out code blocks.

## Apply Async Patterns

Always pass through `CancellationToken`:

```csharp
public async Task<Order> GetOrderAsync(int id, CancellationToken ct)
{
    var order = await repo.FindAsync(id, ct);
    var shipping = await shippingClient.GetStatusAsync(order.TrackingId, ct);
    return order with { ShippingStatus = shipping.Status };
}
```

Use `Task.WhenAll` for independent work:

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
