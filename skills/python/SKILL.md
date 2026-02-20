---
name: python
description: Python patterns and conventions. Covers project structure, type hints, async patterns, FastAPI/Django, testing with pytest, and common anti-patterns.
---

# Python Patterns

Patterns and conventions for Python codebases.

## When to Activate

- Writing or modifying Python code
- Setting up a new Python project
- Building FastAPI or Django APIs
- Writing pytest tests
- Configuring type checking (mypy/pyright)

## Project Structure

### Standard Layout
```
my-project/
├── src/
│   └── my_project/
│       ├── __init__.py
│       ├── main.py              # Entry point
│       ├── config.py            # Settings (Pydantic BaseSettings)
│       ├── models/              # Domain models / DB models
│       │   ├── __init__.py
│       │   └── order.py
│       ├── services/            # Business logic
│       │   ├── __init__.py
│       │   └── order_service.py
│       ├── repositories/        # Data access
│       │   ├── __init__.py
│       │   └── order_repo.py
│       ├── api/                 # HTTP layer
│       │   ├── __init__.py
│       │   ├── routes/
│       │   └── dependencies.py
│       └── clients/             # External API clients
│           ├── __init__.py
│           └── payment_client.py
├── tests/
│   ├── conftest.py              # Shared fixtures
│   ├── test_order_service.py
│   └── test_order_api.py
├── pyproject.toml
└── .python-version
```

## Type Hints — Required

### All Public Functions Must Have Type Hints
```python
# BAD
def get_order(order_id):
    ...

# GOOD
def get_order(order_id: int) -> Order | None:
    ...

# Collections
def get_active_orders(user_id: int) -> list[Order]:
    ...

# Callables
def retry(fn: Callable[[], T], attempts: int = 3) -> T:
    ...
```

### Pydantic for Validation
```python
from pydantic import BaseModel, Field

class CreateOrderRequest(BaseModel):
    customer_id: int = Field(gt=0)
    items: list[OrderItem] = Field(min_length=1)

class OrderItem(BaseModel):
    product_id: int = Field(gt=0)
    quantity: int = Field(gt=0)
```

## Error Handling

### Custom Exception Hierarchy
```python
class AppError(Exception):
    def __init__(self, message: str, code: str):
        super().__init__(message)
        self.code = code

class NotFoundError(AppError):
    def __init__(self, resource: str, resource_id: int | str):
        super().__init__(f"{resource} {resource_id} not found", "NOT_FOUND")

class ValidationError(AppError):
    def __init__(self, message: str):
        super().__init__(message, "VALIDATION_ERROR")
```

### No Bare Except — Ever
```python
# BAD
try:
    process_order(order)
except:
    pass

# BAD — too broad
try:
    process_order(order)
except Exception:
    pass

# GOOD — specific, logged
try:
    process_order(order)
except PaymentError as e:
    logger.error("Payment failed for order %s: %s", order.id, e)
    raise
```

### Context Managers for Resources
```python
# BAD
f = open("data.csv")
data = f.read()
f.close()

# GOOD
with open("data.csv") as f:
    data = f.read()

# Async
async with aiohttp.ClientSession() as session:
    async with session.get(url) as response:
        data = await response.json()
```

## Async Patterns (FastAPI)

### Dependency Injection
```python
from fastapi import Depends

async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async with async_session() as session:
        yield session

async def get_order_service(
    db: AsyncSession = Depends(get_db),
) -> OrderService:
    return OrderService(db)

@router.get("/orders/{order_id}")
async def get_order(
    order_id: int,
    service: OrderService = Depends(get_order_service),
) -> OrderResponse:
    order = await service.get(order_id)
    if order is None:
        raise HTTPException(status_code=404, detail="Order not found")
    return OrderResponse.model_validate(order)
```

### Parallel Async
```python
import asyncio

async def get_dashboard(user_id: int) -> Dashboard:
    orders, notifications, profile = await asyncio.gather(
        order_service.get_recent(user_id),
        notification_service.get_unread(user_id),
        user_service.get_profile(user_id),
    )
    return Dashboard(orders=orders, notifications=notifications, profile=profile)
```

## External API Client Pattern

```python
from httpx import AsyncClient

class PaymentGatewayClient:
    def __init__(self, client: AsyncClient, api_key: str):
        self._client = client
        self._api_key = api_key

    async def charge(self, request: ChargeRequest) -> PaymentResult:
        response = await self._client.post(
            "/v1/charges",
            json=request.model_dump(),
            headers={"Authorization": f"Bearer {self._api_key}"},
        )
        response.raise_for_status()
        return PaymentResult.model_validate(response.json())
```

## Testing — pytest

### Test Naming
```python
# Same pattern: action_when_scenario_then_expectation
def test_create_order_when_items_empty_then_raises_validation_error():
    ...

def test_get_order_when_not_found_then_returns_none():
    ...
```

### Fixtures
```python
# conftest.py
import pytest

@pytest.fixture
def order_service(mock_db: AsyncSession) -> OrderService:
    return OrderService(mock_db)

@pytest.fixture
def sample_order() -> Order:
    return Order(id=1, customer_id=1, items=[OrderItem(product_id=1, quantity=2)])
```

### Async Tests
```python
import pytest

@pytest.mark.asyncio
async def test_create_order_when_valid_then_returns_order(
    order_service: OrderService,
):
    request = CreateOrderRequest(customer_id=1, items=[...])
    result = await order_service.create(request)

    assert result.id is not None
    assert result.status == OrderStatus.PENDING
```

### Parametrize
```python
@pytest.mark.parametrize("quantity", [0, -1, -100])
def test_create_order_when_quantity_invalid_then_raises(quantity: int):
    item = OrderItem(product_id=1, quantity=quantity)
    with pytest.raises(ValidationError):
        Order.create(customer_id=1, items=[item])
```

## Anti-Patterns

| Anti-Pattern | Problem | Fix |
|-------------|---------|-----|
| Mutable default args | Shared state across calls | Use `None`, initialize inside |
| Bare `except` | Swallows all errors | Catch specific exceptions |
| `from module import *` | Pollutes namespace | Import explicitly |
| No type hints | Unverifiable correctness | Add hints + run mypy |
| `datetime.now()` | Untestable, timezone naive | Inject clock, use `datetime.now(UTC)` |
| Nested dicts as data | No validation | Use Pydantic models |