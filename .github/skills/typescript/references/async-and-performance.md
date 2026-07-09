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

## Module-Level Singleton for Shared Fetches

When multiple component instances need the same expensive fetch, deduplicate by caching the in-flight promise at module level. All instances share one request and one result:

```ts
let _promise: Promise<ServiceOption[]> | null = null;

function getSharedData(): Promise<ServiceOption[]> {
    if (!_promise) {
        _promise = fetchData()
            .catch((err) => {
                _promise = null; // allow retry on next mount if the request failed
                return Promise.reject(err) as Promise<ServiceOption[]>;
            });
    }
    return _promise;
}

export function useSharedData(): ServiceOption[] {
    const [data, setData] = useState<ServiceOption[]>([]);
    useEffect(() => {
        let active = true;
        void getSharedData().then((d) => { if (active) setData(d); });
        return () => { active = false; }; // unmount guard — prevents setState after unmount
    }, []);
    return data;
}
```

Key invariants:
- Clear the module variable in `.catch()` so a transient failure doesn't permanently block retries.
- The `active` flag in the effect prevents a resolved promise from updating state on an already-unmounted component.
- Export a `reset` function (`_promise = null`) for test isolation.

## Measure Before Optimizing

Profile before adding memoization, virtualization, or custom caching logic.
