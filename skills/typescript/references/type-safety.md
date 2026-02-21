# Type Safety Reference

Use this reference when modeling types, validating boundaries, and reducing runtime ambiguity.

## Avoid `any` in New Code

Prefer `unknown` plus narrowing:

```ts
function process(data: unknown): string {
  if (typeof data === "object" && data !== null && "name" in data) {
    return (data as { name: string }).name;
  }
  throw new Error("Invalid data");
}
```

Prefer schema validation for untrusted input:

```ts
const schema = z.object({ name: z.string() });
function process(data: unknown): string {
  return schema.parse(data).name;
}
```

## Prefer Discriminated Unions

```ts
type ApiResponse =
  | { status: "loading" }
  | { status: "success"; data: User }
  | { status: "error"; error: string };
```

Use explicit states instead of broad optional fields.

## Use Literal Types and Const Assertions

```ts
const ROUTES = {
  home: "/",
  orders: "/orders",
  orderDetail: "/orders/:id",
} as const;

type Route = (typeof ROUTES)[keyof typeof ROUTES];
```

## API Response Modeling

Prefer predictable success and error envelopes:

```ts
interface ApiResponse<T> {
  data: T;
  meta?: { total: number; page: number; limit: number };
}

interface ApiError {
  error: {
    code: string;
    message: string;
    details?: { field: string; message: string }[];
  };
}
```

Return proper HTTP status codes for errors rather than HTTP 200 with nullable payloads.
