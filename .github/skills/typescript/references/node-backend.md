# Node Backend Reference

Use this reference for API boundary validation, error handling, and backend safety patterns.

## Validate Input at Boundaries

Use runtime schema validation for request payloads:

```ts
const createOrderSchema = z.object({
  customerId: z.string().uuid(),
  items: z.array(z.object({
    productId: z.string().uuid(),
    quantity: z.number().int().positive(),
  })).min(1),
});
```

Reject invalid input with 400/422 responses and structured details.

## Use Typed Error Classes

```ts
class AppError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string,
  ) {
    super(message);
  }
}
```

Map known error classes to consistent API responses in one boundary layer.

## Avoid Floating Promises

Prefer `await` or explicit fire-and-forget wrappers with centralized rejection handling.

## Prevent N+1 Data Access

Batch related reads and hydrate maps when stitching dependent entities.

## Logging and Observability

Use structured logs with request identifiers and explicit error context.
