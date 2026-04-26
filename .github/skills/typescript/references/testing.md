# Testing Reference

Use this reference for TypeScript testing strategy across unit, integration, and E2E layers.

## Layered Test Strategy

- Unit tests for pure logic and core business rules.
- Component tests for UI behavior and interactions.
- Integration tests for API and persistence boundaries.
- E2E tests for critical user journeys.

## Unit and Integration (Vitest or Jest)

```ts
describe("OrderService", () => {
  it("throws when items are empty", async () => {
    await expect(service.create({ items: [] })).rejects.toThrow("at least one item");
  });
});
```

Mock external systems and reset mocks between tests.

## React Component Tests

Use Testing Library and assert user-visible behavior:

```ts
render(<OrderCard order={mockOrder} onCancel={onCancel} />);
fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
expect(onCancel).toHaveBeenCalledWith(mockOrder.id);
```

## Playwright E2E

Prefer stable selectors (`data-testid`) and explicit wait conditions.

Avoid anti-patterns:

- arbitrary `waitForTimeout`
- brittle style/class-only selectors

Use page objects for larger flows to reduce duplication.

## Validation Commands

Prefer repository scripts when available:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
```

Use the repository's package manager instead of hardcoding `npm`.
