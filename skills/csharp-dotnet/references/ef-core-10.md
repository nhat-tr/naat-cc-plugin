# EF Core 10 Reference

Use this reference for data access patterns. Apply .NET 10 features only when project and provider versions support them.

## Keep DbContext Minimal

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

## Use AsNoTracking for Read-Only Queries

```csharp
public async Task<List<OrderSummaryDto>> GetOrderSummariesAsync(int customerId, CancellationToken ct)
{
    return await context.Orders
        .AsNoTracking()
        .Where(o => o.CustomerId == customerId)
        .Select(o => new OrderSummaryDto(o.Id, o.Total, o.Status))
        .ToListAsync(ct);
}
```

## Use AsSplitQuery for Multiple Collection Includes

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

## EF Core 10 Feature Notes

Validate support before using these:

- `LeftJoin` LINQ API.
- JSON mapping via `ComplexProperty(...).ToJson()`.
- Named query filters and selective `IgnoreQueryFilters`.

Example:

```csharp
modelBuilder.Entity<Order>()
    .HasQueryFilter("SoftDelete", o => !o.IsDeleted)
    .HasQueryFilter("Tenant", o => o.TenantId == tenantId);

var allOrders = await context.Orders
    .IgnoreQueryFilters(["SoftDelete"])
    .ToListAsync(ct);
```

If a repository is on an older EF Core version, use compatible alternatives rather than introducing upgrade-only code.
