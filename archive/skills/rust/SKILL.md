---
name: rust
description: Rust patterns, conventions, and best practices. Covers project structure, error handling, ownership patterns, async with Tokio, testing, and common anti-patterns.
---

# Rust Patterns

Patterns and conventions for Rust codebases.

## When to Activate

- Writing or modifying Rust code
- Setting up a new crate or workspace
- Designing error types and handling strategies
- Building async services with Tokio
- Writing tests (unit, integration, property-based)

## Project Structure

### Binary Crate
```
my-service/
├── src/
│   ├── main.rs              # Entry point, minimal — calls lib
│   ├── lib.rs               # Re-exports, public API surface
│   ├── config.rs            # Configuration loading
│   ├── routes/              # HTTP handlers
│   │   ├── mod.rs
│   │   └── orders.rs
│   ├── services/            # Business logic
│   │   ├── mod.rs
│   │   └── order_service.rs
│   ├── models/              # Domain types
│   │   ├── mod.rs
│   │   └── order.rs
│   └── error.rs             # Error types
├── tests/                   # Integration tests
│   └── api_tests.rs
├── Cargo.toml
└── clippy.toml              # Clippy configuration
```

### Cargo Workspace
```
workspace/
├── Cargo.toml               # [workspace] members
├── crates/
│   ├── domain/              # Pure types, no I/O
│   ├── app/                 # Business logic, depends on domain
│   ├── infra/               # DB, HTTP clients, depends on app + domain
│   └── api/                 # HTTP server, depends on all
└── tests/                   # Workspace-level integration tests
```

## Error Handling

### Library Crates — `thiserror`
```rust
use thiserror::Error;

#[derive(Debug, Error)]
pub enum OrderError {
    #[error("order {0} not found")]
    NotFound(i64),

    #[error("insufficient stock for product {product_id}: requested {requested}, available {available}")]
    InsufficientStock {
        product_id: i64,
        requested: u32,
        available: u32,
    },

    #[error("database error")]
    Database(#[from] sqlx::Error),
}
```

### Application Crates — `anyhow`
```rust
use anyhow::{Context, Result};

async fn process_order(db: &PgPool, order_id: i64) -> Result<()> {
    let order = get_order(db, order_id)
        .await
        .context("failed to fetch order")?;

    charge_payment(&order)
        .await
        .context("payment processing failed")?;

    Ok(())
}
```

### Never `unwrap()` in Production Code
```rust
// BAD
let user = db.get_user(id).await.unwrap();

// GOOD
let user = db.get_user(id).await.context("failed to fetch user")?;

// OK in tests
#[cfg(test)]
let user = db.get_user(id).await.unwrap();
```

## Ownership Patterns

### Prefer Borrowing Over Cloning
```rust
// BAD — unnecessary ownership transfer + clone
fn process(name: String) -> String {
    format!("Hello, {name}")
}
let result = process(user.name.clone());

// GOOD — borrow
fn process(name: &str) -> String {
    format!("Hello, {name}")
}
let result = process(&user.name);
```

### Builder Pattern for Complex Construction
```rust
pub struct RequestBuilder {
    url: String,
    headers: Vec<(String, String)>,
    timeout: Option<Duration>,
}

impl RequestBuilder {
    pub fn new(url: impl Into<String>) -> Self {
        Self { url: url.into(), headers: vec![], timeout: None }
    }

    pub fn header(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.headers.push((key.into(), value.into()));
        self
    }

    pub fn timeout(mut self, duration: Duration) -> Self {
        self.timeout = Some(duration);
        self
    }

    pub fn build(self) -> Request { /* ... */ }
}
```

### Newtype Pattern for Type Safety
```rust
// BAD — easy to mix up IDs
fn transfer(from: i64, to: i64, amount: f64) {}

// GOOD — compiler prevents mixing
pub struct UserId(pub i64);
pub struct AccountId(pub i64);
pub struct Money(pub Decimal);

fn transfer(from: AccountId, to: AccountId, amount: Money) {}
```

## Async Patterns (Tokio)

### Structured Concurrency
```rust
use tokio::try_join;

async fn get_dashboard(user_id: i64) -> Result<Dashboard> {
    let (orders, notifications, profile) = try_join!(
        get_orders(user_id),
        get_notifications(user_id),
        get_profile(user_id),
    )?;

    Ok(Dashboard { orders, notifications, profile })
}
```

### Cancellation via CancellationToken (tokio_util)
```rust
use tokio_util::sync::CancellationToken;

async fn run_worker(token: CancellationToken) {
    loop {
        tokio::select! {
            _ = token.cancelled() => {
                tracing::info!("worker shutting down");
                break;
            }
            _ = do_work() => {}
        }
    }
}
```

## Testing

### Unit Tests — In-Module
```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_order_when_items_empty_then_returns_error() {
        let result = Order::new(vec![]);
        assert!(result.is_err());
        assert!(matches!(result, Err(OrderError::EmptyItems)));
    }

    #[tokio::test]
    async fn get_order_when_not_found_then_returns_none() {
        let pool = setup_test_db().await;
        let result = get_order(&pool, 999).await.unwrap();
        assert!(result.is_none());
    }
}
```

### Integration Tests — `tests/` Directory
```rust
// tests/api_tests.rs
use my_service::app;

#[tokio::test]
async fn create_order_returns_201() {
    let app = app::create_test_app().await;
    let response = app.post("/api/orders")
        .json(&json!({"items": [{"product_id": 1, "quantity": 2}]}))
        .await;

    assert_eq!(response.status(), 201);
}
```

## Clippy — Enforce Quality
```toml
# clippy.toml
too-many-arguments-threshold = 5
type-complexity-threshold = 300
```

Key lints to enable:
```rust
// lib.rs or main.rs
#![deny(clippy::unwrap_used)]       // No unwrap in production
#![deny(clippy::expect_used)]       // No expect in production
#![warn(clippy::pedantic)]          // Stricter lints
#![allow(clippy::module_name_repetitions)] // Common exception
```

## Anti-Patterns to Avoid

| Anti-Pattern | Problem | Fix |
|-------------|---------|-----|
| `.clone()` everywhere | Hides ownership issues, allocates | Restructure to use references |
| `Arc<Mutex<HashMap<...>>>` | Concurrent map with coarse lock | Use `dashmap` or channels |
| `String` for enums | No compile-time validation | Use proper `enum` types |
| Mega `match` blocks | Hard to maintain | Extract to methods or trait impls |
| Ignoring `Result` | Silent failures | Use `?` or explicitly handle |
| `Box<dyn Error>` everywhere | Loses type info | Use `thiserror` enums |