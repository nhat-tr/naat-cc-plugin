# NUnit and Integration Testing Reference

Examples and setup patterns. Rules are in SKILL.md — this file has code samples only.

## Test Naming and Structure

```csharp
[Test]
public async Task CreateOrder_WhenItemsEmpty_ThenThrowsValidationException()
{
    // Arrange
    var request = new CreateOrderRequest(CustomerId: 1, Items: []);

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

Define attributes once per test project:

```csharp
[AttributeUsage(AttributeTargets.Method | AttributeTargets.Class)]
public class UnitTestAttribute : CategoryAttribute { }

[AttributeUsage(AttributeTargets.Method | AttributeTargets.Class)]
public class IntegrationTestAttribute : CategoryAttribute { }

[AttributeUsage(AttributeTargets.Method | AttributeTargets.Class)]
public class StagingOnlyAttribute : CategoryAttribute { }
```

Filter in CI:

```bash
dotnet test --filter "TestCategory=UnitTest"
dotnet test --filter "TestCategory!=StagingOnly&TestCategory!=IntegrationTest"
```

## Testcontainers for Integration Tests

```csharp
_postgres = new PostgreSqlBuilder()
    .WithImage("postgres:17")
    .Build();

await _postgres.StartAsync();
```

After startup, run migrations and clean data per test as needed.

## WebApplicationFactory for API Tests

Replace production `DbContext` registration inside the test host and point to containerized infrastructure.
