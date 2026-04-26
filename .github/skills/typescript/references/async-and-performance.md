# Async and Performance Reference

Use this reference for concurrency, retries, and runtime efficiency.

## Prefer Parallelism for Independent Work

```ts
const [users, orders, stats] = await Promise.all([
  fetchUsers(),
  fetchOrders(),
  fetchStats(),
]);
```

Use sequential flow only when steps depend on previous results.

## Retry Carefully

Use bounded retry logic with exponential backoff only for transient failures:

```ts
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  let lastError: Error;

  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      if (i < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, 2 ** i * 1000));
      }
    }
  }

  throw lastError!;
}
```

Do not retry validation errors or deterministic business rule failures.

## Cancellation and Timeouts

Prefer `AbortController` and timeout wrappers for network-bound operations.

## Immutability and Allocation

Prefer immutable updates for state correctness, but avoid unnecessary copies in hot loops.

## Measure Before Optimizing

Profile before adding memoization, virtualization, or custom caching logic.
