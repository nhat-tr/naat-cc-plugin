# React and Next.js Reference

Use this reference when implementing UI components, hooks, and Next.js boundaries.

## Keep Component Contracts Explicit

Define props interfaces or type aliases separately from component bodies:

```ts
interface OrderCardProps {
  order: Order;
  onCancel: (orderId: string) => void;
}

export function OrderCard({ order, onCancel }: OrderCardProps) {
  return <div />;
}
```

## Keep Hook Dependencies Complete

```ts
useEffect(() => {
  fetchOrders(userId);
}, [userId]);
```

Do not suppress dependency warnings without a specific reason.

## Respect Next.js Server/Client Boundaries

- Use server components by default for data fetch and static content.
- Add `"use client"` only when using state, effects, handlers, or browser APIs.

## Client Data Fetching

Prefer TanStack Query for client-side data fetching. Configure it once at the app level:

```ts
// Standard query pattern with loading/error states
const { data, isLoading, error } = useQuery({
  queryKey: ['orders', userId],
  queryFn: () => api.getOrders(userId),
});

if (isLoading) return <Skeleton />;
if (error) return <ErrorMessage error={error} />;
```

Always handle loading and error states explicitly. Use `suspense: true` only with React Suspense boundaries.

## Form Handling

Use react-hook-form with zod for type-safe form validation:

```ts
const schema = z.object({
  name: z.string().min(1, 'Name is required'),
  email: z.string().email('Invalid email'),
});

type FormData = z.infer<typeof schema>;

const { register, handleSubmit, formState: { errors } } = useForm<FormData>({
  resolver: zodResolver(schema),
});
```

Co-locate schema definitions with the form that uses them. Share schemas between client validation and API route validation when possible.

## Component Organization

- **Co-locate** — keep components, hooks, types, and tests together by feature, not by type.
- **When to split** — extract a component when it has its own state, is reused, or the parent exceeds ~150 lines.
- **Barrel exports** — use `index.ts` re-exports for feature folders exposed to other features. Avoid barrel files inside a feature (causes circular imports).

```
features/
  orders/
    OrderList.tsx
    OrderCard.tsx
    useOrders.ts
    orders.types.ts
    index.ts          # re-exports public API
```

## State Management

Choose the simplest tool that fits:

- **React Context** — sufficient for theme, auth, locale, and other low-frequency global state. Avoid for state that changes often (causes full subtree re-renders).
- **Zustand** — for client state that changes frequently or needs to be accessed outside React (e.g., websocket handlers). Lightweight, no boilerplate.
- **Redux Toolkit (RTK)** — when the project already uses it. Don't introduce it into a new project without strong reason.
- **TanStack Query** — for all server state. Don't duplicate server data into Zustand/Redux.

## Error Boundaries

Wrap unstable UI regions in error boundaries and provide recovery actions where practical.

## Rendering Clarity

Prefer clear, flat conditional rendering and avoid deeply nested ternaries.

## UI Performance Patterns

`React.memo`, `useMemo`, and `useCallback` only pay off when they preserve **referential identity** — the same object/array/function reference across renders so downstream comparisons don't trigger unnecessary work.

**`useMemo` is justified** when the result is an object, array, or JSX node that would be recreated every render and is used as a prop or effect dependency:

```ts
// Stabilises the empty-array fallback — without memo, `[]` is a new ref every render,
// defeating any downstream React.memo or useEffect comparison.
const items = useMemo(() => data?.items ?? [], [data?.items]);

// JSX array passed directly to a component (e.g., Ant Design Tabs.items).
const tabs = useMemo(() => [...], [activeTab, t]);
```

**`useMemo` is overuse** for primitive values (string, number, boolean). React compares primitives by value, not reference, so a memo wrapper just adds overhead:

```ts
// Overuse — wrapping a boolean achieves nothing.
const showAlert = useMemo(() => status === 'error' && !!message, [status, message]);

// Correct — plain const.
const showAlert = status === 'error' && !!message;
```

Other patterns still requiring profiling first: `React.memo` for pure components, dynamic/lazy loading, list virtualization.

## Debouncing Queries

Use `useMemo` (not `useCallback`) to create a debounced function, and cancel it on unmount:

```ts
// Wrong: useCallback wraps the already-created debounce result — `fn` inside the
// debounce captures the stale value from mount and is never updated.
const debouncedSearch = useCallback(debounce(fn, 400), []);

// Correct: useMemo recreates the debounced function when fn changes.
const debouncedSearch = useMemo(() => debounce(fn, 400), [fn]);
useEffect(() => () => { debouncedSearch.cancel(); }, [debouncedSearch]);
```

## Stale Closure Prevention in Debounced Callbacks

Callbacks captured inside a debounced function or Apollo's `onCompleted` only see the value at the time the outer hook was created. Adding the callback to the debounce's deps would recreate the debounce on every render, defeating the purpose. Use a ref instead:

```ts
const onResultRef = useRef(onResult);
onResultRef.current = onResult; // always current, no deps change

const debouncedSearch = useMemo(() => debounce((serial: string) => {
    query({
        variables: { serial },
        onCompleted(data) {
            const result = data?.lookup;
            if (result) onResultRef.current?.(result); // always fresh
        },
    });
}, 400), [query]);
```

This pattern is also correct for the `initialSerial` auto-lookup case: use `onResultRef.current?.()` inside the `onCompleted` callback rather than listing the prop in the effect's dependency array.

## Stale State in useCallback Deps

When a `useCallback` captures a state variable only to read the latest value (not to rerun on change), adding it to deps creates a new function on every state update — breaking `React.memo` children and resetting debounces. Avoid it by keeping a ref that shadows the state:

```ts
// Wrong: new callback on every twin added → React.memo child re-renders needlessly.
const onTwinAdded = useCallback((twin: Twin) => {
    if (twins.some((t) => t.id === twin.id)) return; // stale closure on `twins`
    applyDefaults(twin);
    setTwins([...twins, twin]);
}, [twins, applyDefaults]);

// Correct: ref for the read, functional update for the write.
const twinsRef = useRef(twins);
twinsRef.current = twins;

const onTwinAdded = useCallback((twin: Twin) => {
    if (twinsRef.current.some((t) => t.id === twin.id)) return; // always fresh
    applyDefaults(twin);
    setTwins((prev) => [...prev, twin]);  // no stale closure
}, [applyDefaults]);
```

The rule of thumb: if a state variable only appears in a guard check inside `useCallback` and never drives different _logic_ between calls, it belongs in a ref, not in the deps array.

**Apply the ref consistently.** Once you introduce `fooRef` to break a dep in one callback, audit every other callback that closes over the same state. Inconsistent application — some callbacks use the ref, others still capture the state directly — creates asymmetric stale-closure behavior that is hard to reason about:

```ts
// After introducing twinsRef to stabilise onTwinAdded:
const twinsRef = useRef(twins);
twinsRef.current = twins;

const onTwinAdded = useCallback((twin: Twin) => {
    if (twinsRef.current.some((t) => t.id === twin.id)) return; // ← uses ref ✓
    setTwins((prev) => [...prev, twin]);
}, [applyDefaults]);

// Wrong: onFormSubmit still closes over `twins` directly — same stale-closure risk.
const onFormSubmit = useCallback(async (values: FormValues) => {
    await submit(values, twins, productData); // ← captures state, not ref
}, [submit, twins, productData]);

// Correct: read from the ref everywhere.
const onFormSubmit = useCallback(async (values: FormValues) => {
    await submit(values, twinsRef.current, productData); // ← always fresh
}, [submit, productData]);
```

## Spurious Deps After Extracting Helpers

When you extract a helper function out of a `useCallback` body, the dep that helper used no longer appears in the callback — but it may still be listed in the deps array. These "ghost deps" linger silently, causing unnecessary recreations on every change:

```ts
// Before: t was used to build a warning message inline.
const onServicesChanged = useCallback((options) => {
    const msg = t('duplicate_service'); // ← t needed here
    ...
}, [onChange, value, t]);

// After extracting buildWarnings(counts, t) as a module-level helper:
const onServicesChanged = useCallback((options) => {
    // t is no longer referenced in this body
    onChange([...newValue]);
}, [onChange, value, t]); // ← t is now a ghost dep

// Correct: remove it.
}, [onChange, value]);
```

Whenever you refactor by extracting logic into a helper, re-read the callback body and remove any deps that are no longer referenced directly.

## Don't Derive State in useEffect

When one piece of state is just a correction of another, computing it in an `useEffect` causes a guaranteed double-render: the component renders with the wrong value, the effect fires, sets the corrected value, then renders again. Derive the value during render instead:

```ts
// Wrong: two renders every time requestedTools empties while on that tab.
useEffect(() => {
    if (activeTab === 'requestedTools' && requestedTools.length === 0)
        setActiveTab('recordTools');
}, [activeTab, requestedTools.length]);

// Correct: single derived variable, single render.
const effectiveActiveTab =
    activeTab === 'requestedTools' && requestedTools.length === 0
        ? 'recordTools'
        : activeTab;
// Use effectiveActiveTab in JSX; activeTab state unchanged.
```

The general signal: if an `useEffect` only calls a `setState` and nothing else (no subscriptions, no DOM side-effects, no external APIs), it is almost certainly better expressed as a derived variable.

## Don't Duplicate Loading State That a Hook Already Provides

Apollo mutations and TanStack Query mutations already expose a `loading` / `isPending` flag. Adding a manual `useState(false)` beside it creates two sources of truth and risks getting out of sync (e.g., if the `finally` block is missing or the component unmounts mid-flight):

```ts
// Wrong: manual state alongside Apollo's built-in loading.
const [doMutation] = useSomeMutation();
const [loading, setLoading] = useState(false);

const run = useCallback(async () => {
    setLoading(true);
    try { await doMutation(...); }
    finally { setLoading(false); }  // races with unmount
}, [...]);

// Correct: use the loading flag the hook already gives you.
const [doMutation, { loading }] = useSomeMutation();

const run = useCallback(async () => {
    try { await doMutation(...); }
    catch { return false; }
}, [...]);
```

The same applies to TanStack Query's `isPending` and Apollo's `useLazyQuery` loading state.
