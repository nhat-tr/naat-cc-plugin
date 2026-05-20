# Should You Remove `IPaymentGatewayClient`?

Short answer: your junior is wrong, but not entirely. The abstraction has a cost, and six months of a single implementation with no migration on the horizon is a strong signal you overshot. Here's the breakdown.

## The Case for Removing It

**YAGNI applies here.** You created this interface for a specific, anticipated change that hasn't materialized and shows no signs of materializing. That's the textbook case for removing an abstraction.

**Interfaces are not free.** With 12 callers, you have 12 places where a developer must mentally resolve "which implementation is this?" — the answer is always Stripe, but the abstraction forces that question every time. Every new developer on the project reads the interface, looks for implementations, finds one, and wonders if there are more or if a factory somewhere could swap it out. That cognitive overhead compounds.

**"Just in case" is not a design driver.** If you added an abstraction every time you *might* change something, you'd have interfaces everywhere. The question isn't "could this ever change?" (everything can change), it's "is the cost of abstracting now less than the cost of adding it later?" For a payment gateway, the answer is almost certainly no — the integration surface is small, well-defined, and any future migration will require significant work regardless of whether you have an interface.

**Mocking in tests is a real but bounded argument.** If your tests mock `IPaymentGatewayClient`, removing the interface forces you to use a concrete fake or an in-memory implementation. That's actually *fine* — a `FakeStripePaymentGatewayClient` is honest about what it's replacing. Don't let this alone keep the interface alive.

## What Your Junior Gets Right (Partially)

The junior's instinct isn't completely wrong — payment gateway integrations *are* the kind of thing that changes. But that's an argument for making the abstraction easy to introduce *when needed*, not for carrying the overhead indefinitely before you need it.

The cost of adding `IPaymentGatewayClient` back when Adyen actually lands is roughly: one interface file, update 12 call sites, done. If you have a good IDE, that's 20 minutes. It is not a risk worth carrying an abstraction indefinitely to avoid.

## What to Actually Check Before Deciding

Before committing to removal, verify two things in the actual codebase:

1. **Are those 12 callers in test code or production code?** If 8 of the 12 are unit tests mocking the interface, the abstraction is doing real work for testability. That changes the calculus — you'd want to ensure a concrete fake or test double strategy exists before removing it.

2. **Is there any DI registration or factory that conditions on the interface?** If your container resolves the concrete type through the interface in a non-trivial way (e.g., decorators, middleware, retry policies wrapping the interface), the removal is not purely mechanical.

## Recommendation

**Remove the interface if:**
- Tests can be refactored to use a concrete fake or don't mock at the gateway level at all (integration/contract tests are better here anyway)
- There's no pending roadmap item for Adyen in the next quarter

**Keep it only if:**
- A significant portion of those 12 callers are tests that rely on mocking the interface, AND refactoring them now would be disproportionate effort
- You have concrete, dated plans (not vibes) to swap the gateway in the near term

Don't let "we might change later" win without a fight. Every abstraction you carry has a maintenance cost. Make your junior justify the ongoing cost, not just the hypothetical future benefit.
