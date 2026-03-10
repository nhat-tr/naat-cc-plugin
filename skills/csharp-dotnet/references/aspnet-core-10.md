# ASP.NET Core 10 Reference

Use this reference for API endpoint design, composition, and logging.

## Keep Composition Root Clean

Use extension methods for domain registration and call them from `Program.cs`.

## Use Structured Logging

Use message templates with named properties:

```csharp
logger.LogInformation("Order {OrderId} created for customer {CustomerId}", orderId, customerId);
logger.LogWarning("Payment {PaymentId} failed with status {Status}", paymentId, status);
```

Avoid interpolated strings in logs to preserve structured fields.

## Validation

Minimal API endpoints: use ASP.NET Core 10 built-in validation with `[Required]`, `[Range]`, etc. on parameter types. For complex rules, use FluentValidation when already in the project.

```csharp
// Built-in validation on a request record
public record CreateOrderRequest(
    [Required] string CustomerId,
    [Range(1, 1000)] int Quantity);

// FluentValidation when already adopted
public class CreateOrderValidator : AbstractValidator<CreateOrderRequest>
{
    public CreateOrderValidator()
    {
        RuleFor(x => x.CustomerId).NotEmpty();
        RuleFor(x => x.Quantity).InclusiveBetween(1, 1000);
    }
}
```

## Auth Patterns

Apply authorization at the group level to avoid missing individual endpoints:

```csharp
var group = app.MapGroup("/api/orders")
    .RequireAuthorization("OrderPolicy");

// Override for specific endpoints when needed
group.MapGet("/public", GetPublicOrders).AllowAnonymous();
```

Use policy-based authorization over role checks. Define policies in `Program.cs`:

```csharp
builder.Services.AddAuthorizationBuilder()
    .AddPolicy("OrderPolicy", policy =>
        policy.RequireAuthenticatedUser()
              .RequireClaim("scope", "orders"));
```
