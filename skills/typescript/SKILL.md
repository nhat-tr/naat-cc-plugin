---
name: typescript
description: TypeScript patterns and conventions. Covers project structure, type safety, React/Next.js patterns, Node.js backend, testing, and modern ES features.
---

# TypeScript Patterns

Patterns and conventions for TypeScript codebases.

## When to Activate

- Writing or modifying TypeScript code
- Setting up a new TS project
- Building React/Next.js frontends
- Building Node.js backends
- Writing tests (Jest, Vitest, Playwright)

## Type Safety

### Strict Mode — Always
```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true
  }
}
```

### No `any`
```typescript
// BAD
function process(data: any) { return data.name; }

// GOOD — use unknown + type guard
function process(data: unknown): string {
  if (typeof data === "object" && data !== null && "name" in data) {
    return (data as { name: string }).name;
  }
  throw new Error("Invalid data");
}

// BETTER — use a schema
const schema = z.object({ name: z.string() });
function process(data: unknown): string {
  return schema.parse(data).name;
}
```

### Discriminated Unions Over Optional Fields
```typescript
// BAD — unclear which fields exist when
type ApiResponse = {
  data?: User;
  error?: string;
  loading?: boolean;
};

// GOOD — each state is explicit
type ApiResponse =
  | { status: "loading" }
  | { status: "success"; data: User }
  | { status: "error"; error: string };
```

### Const Assertions for Literals
```typescript
const ROUTES = {
  home: "/",
  orders: "/orders",
  orderDetail: "/orders/:id",
} as const;

type Route = (typeof ROUTES)[keyof typeof ROUTES];
```

## React Patterns

### Component Structure
```typescript
// Props interface — explicit, no inline
interface OrderCardProps {
  order: Order;
  onCancel: (orderId: string) => void;
}

export function OrderCard({ order, onCancel }: OrderCardProps) {
  return (/* ... */);
}
```

### Hooks — Complete Dependencies
```typescript
// BAD — stale closure
useEffect(() => {
  fetchOrders(userId);
}, []); // userId missing

// GOOD
useEffect(() => {
  fetchOrders(userId);
}, [userId]);
```

### Server vs Client Components (Next.js)
```typescript
// Server Component (default) — no "use client", no useState/useEffect
// Good for: data fetching, static content, SEO

// Client Component — needs "use client" directive
// Required for: event handlers, useState, useEffect, browser APIs
"use client";
export function SearchBar() {
  const [query, setQuery] = useState("");
  // ...
}
```

### Data Fetching — TanStack Query for Client
```typescript
function useOrders(userId: string) {
  return useQuery({
    queryKey: ["orders", userId],
    queryFn: () => api.getOrders(userId),
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
}
```

## Node.js Backend

### Input Validation — Zod at Boundaries
```typescript
const createOrderSchema = z.object({
  customerId: z.string().uuid(),
  items: z.array(z.object({
    productId: z.string().uuid(),
    quantity: z.number().int().positive(),
  })).min(1),
});

app.post("/api/orders", async (req, res) => {
  const result = createOrderSchema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ error: result.error.flatten() });
  }
  const order = await orderService.create(result.data);
  return res.status(201).json(order);
});
```

### Error Handling — Custom Error Classes
```typescript
class AppError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string,
  ) {
    super(message);
  }
}

class NotFoundError extends AppError {
  constructor(resource: string, id: string) {
    super(`${resource} ${id} not found`, 404, "NOT_FOUND");
  }
}
```

### No Floating Promises
```typescript
// BAD — unhandled rejection
app.get("/api/orders", (req, res) => {
  orderService.getAll(); // floating promise
});

// GOOD
app.get("/api/orders", async (req, res) => {
  const orders = await orderService.getAll();
  res.json(orders);
});
```

## Testing

### Naming Convention
Same as C#: descriptive test names that explain the scenario.

```typescript
describe("OrderService", () => {
  it("should throw when items array is empty", async () => {
    await expect(service.create({ items: [] }))
      .rejects.toThrow("at least one item");
  });

  it("should return null when order not found", async () => {
    const result = await service.getById("nonexistent");
    expect(result).toBeNull();
  });
});
```

### Mock External Dependencies
```typescript
const mockPaymentClient = {
  charge: vi.fn(),
  refund: vi.fn(),
} satisfies PaymentClient;

beforeEach(() => {
  vi.clearAllMocks();
});
```

## Package Manager Detection

Check in order: lockfile → `packageManager` field in `package.json` → fallback to npm.

| Lockfile | Manager |
|----------|---------|
| `pnpm-lock.yaml` | pnpm |
| `yarn.lock` | yarn |
| `bun.lockb` | bun |
| `package-lock.json` | npm |