# EF Core 10 Reference

Use this reference for data access patterns. Apply .NET 10 features only when project and provider versions support them.

## Keep DbContext Minimal

```csharp
public class AppDbContext(DbContextOptions<AppDbContext> options) : DbContext(options)
{
    public DbSet<Order> Orders => Set<Order>();
    public DbSet<Customer> Customers => Set<Customer>();

    // Only override OnModelCreating when fluent config is needed.
    // If all entities use data annotations, this override is unnecessary.
}
```

## Prefer Data Annotations Over Fluent Configuration

Use EF Core attributes for entity configuration — they're simpler, co-located with the entity, and cover most cases:

```csharp
[Table("orders")]
[Index(nameof(CustomerId), nameof(CreatedAt))]
public class Order
{
    [Key]
    public int Id { get; set; }

    [Required, MaxLength(200)]
    public string Description { get; set; } = "";

    [Column("customer_id")]
    public int CustomerId { get; set; }

    [ForeignKey(nameof(CustomerId))]
    public Customer Customer { get; set; } = null!;

    public DateTimeOffset CreatedAt { get; set; }
}
```

For value conversions, prefer a reusable converter attribute over fluent `HasConversion`:

```csharp
[AttributeUsage(AttributeTargets.Property)]
public class EnumToStringAttribute : Attribute;

// Register in DbContext via convention
protected override void ConfigureConventions(ModelConfigurationBuilder configurationBuilder)
{
    // Or use a custom convention to auto-detect [EnumToString] attributes
}

// Or use the built-in generic converter attribute (EF Core 8+):
[Column("status")]
[BackingField(nameof(_status))]
public OrderStatus Status { get; set; }
```

Only use `IEntityTypeConfiguration` / fluent API for things attributes **cannot** express:

- Composite keys, composite indexes with `IsUnique`/`IsDescending`
- Owned types / complex properties / table splitting
- Query filters (`HasQueryFilter`)
- Many-to-many with join entity payload
- TPH/TPT/TPC discriminator configuration
- Precision/scale on decimal columns (`HasPrecision`)
- Sequences, computed columns, default values from SQL

```csharp
// Only when needed — not the default approach
public class OrderConfiguration : IEntityTypeConfiguration<Order>
{
    public void Configure(EntityTypeBuilder<Order> builder)
    {
        builder.OwnsOne(o => o.ShippingAddress, sa => sa.ToJson());
        builder.HasQueryFilter(o => !o.IsDeleted);
        builder.Property(o => o.Total).HasPrecision(18, 2);
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
