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

Use these only when measurements justify them:

- `useMemo` for expensive derived values
- `useCallback` for stable callbacks passed to memoized children
- `React.memo` for pure components with stable props
- dynamic/lazy loading for heavy modules
- list virtualization for large datasets
