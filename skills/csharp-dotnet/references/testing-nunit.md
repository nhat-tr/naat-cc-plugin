# NUnit and Integration Testing Reference

Use this reference for test naming, category filtering, and integration test setup.

## Name Tests by Behavior

Use this format:

```text
[Action]_When[Scenario]_Then[Expectation]
```

## Follow Arrange-Act-Assert Structure

```csharp
[Test]
public async Task CreateOrder_WhenItemsEmpty_ThenThrowsValidationException()
{
    // Arrange
    var request = new CreateOrderRequest(CustomerId: 1, Items: []);

    // Act
    var act = () => sut.CreateAsync(request, CancellationToken.None);

    // Assert
    await act.Should().ThrowAsync<ValidationException>();
}
```

## Use Categories to Control Execution

Define attributes once:

```csharp
[AttributeUsage(AttributeTargets.Method | AttributeTargets.Class)]
public class UnitTestAttribute : CategoryAttribute { }

[AttributeUsage(AttributeTargets.Method | AttributeTargets.Class)]
public class IntegrationTestAttribute : CategoryAttribute { }

[AttributeUsage(AttributeTargets.Method | AttributeTargets.Class)]
public class StagingOnlyAttribute : CategoryAttribute { }
```

Filter in CI/local:

```bash
dotnet test --filter "TestCategory=UnitTest"
dotnet test --filter "TestCategory=UnitTest|TestCategory=IntegrationTest"
dotnet test --filter "TestCategory!=StagingOnly&TestCategory!=IntegrationTest"
```

## Prefer Testcontainers for Integration Tests

Use ephemeral containers instead of shared databases:

```csharp
_postgres = new PostgreSqlBuilder()
    .WithImage("postgres:17")
    .Build();

await _postgres.StartAsync();
```

After startup, run migrations and clean data per test as needed.

## Use WebApplicationFactory for Full API Integration

Replace production `DbContext` registration inside the test host and point to containerized infrastructure.
