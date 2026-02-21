# Modern C# and .NET Reference

Use this reference when repositories are already on compatible SDK and language versions.

## .NET APIs

Use `System.Threading.Lock` for explicit lock objects:

```csharp
private readonly Lock cacheLock = new();

public void UpdateCache(string key, object value)
{
    lock (cacheLock)
    {
        cache[key] = value;
    }
}
```

Use source-generated regex for hot paths:

```csharp
public partial class Validators
{
    [GeneratedRegex(@"^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$")]
    public static partial Regex EmailRegex();
}
```

Use `FrozenDictionary` for immutable high-read maps:

```csharp
private static readonly FrozenDictionary<string, string> MimeTypes =
    new Dictionary<string, string>
    {
        [".pdf"] = "application/pdf",
        [".json"] = "application/json",
        [".csv"] = "text/csv",
    }.ToFrozenDictionary();
```

Inject `TimeProvider` for testable time logic:

```csharp
public class TokenService(TimeProvider time)
{
    public bool IsExpired(Token token) => time.GetUtcNow() > token.ExpiresAt;
}
```

Use `HybridCache` for read-through caching:

```csharp
return await cache.GetOrCreateAsync(
    $"user:profile:{userId}",
    token => repo.GetProfileAsync(userId, token),
    cancellationToken: ct);
```

## C# Features

Use `field` keyword in property accessors when normalization or validation is needed:

```csharp
public string Email
{
    get;
    set => field = value?.Trim().ToLowerInvariant()
        ?? throw new ArgumentNullException(nameof(value));
}
```

Use collection expressions where analyzers and team conventions support them:

```csharp
List<string> names = ["Alice", "Bob"];
int[] ids = [1, 2, 3];
List<Item> combined = [..existing, extra];
```

Use null-conditional assignment only when nullable receiver semantics are intentional:

```csharp
customer?.LastOrderDate = DateTimeOffset.UtcNow;
```
