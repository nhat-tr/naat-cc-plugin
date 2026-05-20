# What Went Wrong — And Whether the Refactor Is Worth Keeping

## The Root Cause: You Tested the Parts, Not the Whole

The unit tests on `CalculateLineDiscount`, `ValidateInventoryAvailability`, and `BuildShipmentPayload` passed because each method is correct **in isolation**. The bug lives in `PlaceOrderAsync` — specifically in the ordering and conditional logic that orchestrates those calls. That's the layer you have no tests for.

The discount-on-cancelled-order bug is almost certainly one of these:

1. **Status check happens after discount calculation.** `CalculateLineDiscount` runs first, then something downstream (cancel detection, inventory check) triggers early return or exception, but the discount has already been applied to the order entity in memory — or worse, persisted.

2. **No guard on order status before entering the pipeline.** `PlaceOrderAsync` never checks `order.Status != Cancelled` before handing the order to the helper methods. Each helper is pure and stateless — none of them know the order's lifecycle state, because that's not their job.

3. **A race condition or reentrant call.** The order was cancelled concurrently while `PlaceOrderAsync` was mid-execution. Without a transactional boundary or a status re-check after acquiring a lock/record, the sequence runs to completion on a stale in-memory state.

The common thread: **your static helpers are pure functions, but the orchestration has stateful preconditions that nothing enforces**. Extracting pure helpers does not move the orchestration logic — it just makes it more invisible.

## Why the Tests Gave You False Confidence

High unit-test coverage on `OrderPlacementHelper` measures the wrong thing. Each method takes inputs, returns outputs, has no side effects — they were always easy to test. The hard-to-test, failure-prone code is the sequence in `PlaceOrderAsync`:

- Which preconditions are checked?
- In what order?
- What happens if one fails mid-sequence?
- Is there rollback? Idempotency?

None of that is covered by helper-method tests. You need **integration or orchestration-level tests** on `PlaceOrderAsync` itself, exercising scenarios like "order already cancelled when PlaceOrder is called" and "order cancelled between inventory check and shipment build."

## Is the Refactor Worth Keeping?

Yes, but with a clear-eyed view of what it actually bought you:

**What it bought:**
- `CalculateLineDiscount`, `ValidateInventoryAvailability`, and `BuildShipmentPayload` are easier to read, test, and reuse.
- Cognitive load on `PlaceOrderAsync` is lower — the reader sees the pipeline without implementation detail noise.
- Pure static methods have no hidden dependencies, which is genuinely good design.

**What it did not buy:**
- Any protection for the orchestration layer.
- Tests for the business-critical sequencing logic.
- A guarantee that preconditions are enforced before the pipeline starts.

**The refactor is a good structural move that was shipped incomplete.** Extracting the helpers was step one. Step two — which you skipped — is writing orchestration-level tests for `PlaceOrderAsync` and adding explicit guards at the entry point.

## What to Fix Now

**1. Add a status guard at the top of `PlaceOrderAsync`:**

```csharp
if (order.Status == OrderStatus.Cancelled)
    throw new InvalidOperationException($"Cannot place order {order.Id}: already cancelled.");
```

This is not a business rule that belongs in a helper — it's an orchestration precondition.

**2. Add integration/orchestration tests for `PlaceOrderAsync`**, covering at minimum:
- Order is cancelled before the call → should throw or return a failure result, not apply discount
- Order is cancelled between steps (if concurrency is possible) → verify the system handles it correctly
- The happy path through the full sequence

**3. If concurrency is possible**, look at whether you need a pessimistic lock or an optimistic check (read-then-compare-and-set) around the status before beginning the pipeline. Applying a discount inside a `PlaceOrderAsync` that runs concurrently with a cancellation handler is a classic TOCTOU bug that no amount of unit testing will catch.

## Bottom Line

The refactor is architecturally sound. The bug is not in the helpers — it's in the untested, unguarded orchestration around them. The failure mode here is the classic "high coverage on the easy code, zero coverage on the tricky sequencing." Fix the guard, add the orchestration tests, and the refactor becomes a net positive.
