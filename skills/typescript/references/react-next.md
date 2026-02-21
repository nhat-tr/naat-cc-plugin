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

Prefer TanStack Query or repository-standard query abstractions for client cache/state behavior.

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
