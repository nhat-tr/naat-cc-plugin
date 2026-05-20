# Where You Went Wrong — and Whether the Refactor Is Worth Keeping

## The Actual Bug: Extraction Without Seam

The prod bug — discount applied to a cancelled order — tells you exactly where the problem lives. It is not in `CalculateLineDiscount`. It is not in `ValidateInventoryAvailability`. It is in the **orchestration**: the call sequence in `PlaceOrderAsync` does not guard against order state before applying discounts.

Your unit tests on `OrderPlacementHelper` passed because those functions are correct in isolation. Discounting the right amount given valid inputs: correct. Validating inventory for given SKUs: correct. Building a shipment payload from order lines: correct. None of those tests could catch a sequencing bug — "discount was applied before checking whether the order is still live" — because you extracted pure functions, not the orchestration logic. The pure function passes its own tests while the call site is still wrong. That's precisely the anti-pattern this refactor fell into.

**The bug lived in `PlaceOrderAsync` the entire time. You just built a highly-tested helper that had nothing to say about it.**

## Applying the Deletion Test

Delete `OrderPlacementHelper` and inline all three static methods back into `PlaceOrderAsync`. What happens?

- `CalculateLineDiscount`: its logic reappears inline in one place. Complexity is local, not spread. If it's only called from `PlaceOrderAsync`, the extraction earned nothing.
- `ValidateInventoryAvailability`: same question — how many callers? If one, inlining costs nothing and the module was not earning its keep.
- `BuildShipmentPayload`: same.

If each of these is called from exactly one place — `PlaceOrderAsync` — then the deletion test returns: **no locality benefit, no leverage gained**. The helper is a pass-through dressed up as abstraction.

If any of them is called from multiple callers (e.g., `CalculateLineDiscount` is also used in a quote-generation path), the extraction is justified for that method. The leverage is real: change pricing logic in one place, not N.

## The Deeper Problem: The Test Surface Is in the Wrong Place

The interface that matters for correctness is `PlaceOrderAsync`. Its observable outcome is: "given an order in state X, produce the correct financial and fulfilment result." That's the interface callers cross. That's where bugs live.

Your current test coverage:

- High coverage on `CalculateLineDiscount`, `ValidateInventoryAvailability`, `BuildShipmentPayload` — all at the wrong interface for this bug class.
- Zero (or weak) coverage on the sequencing in `PlaceOrderAsync` — the interface where the real failure mode lives.

Tests on the helper methods are not useless, but they give false confidence because the test surface is below the real interface. You can have 100% coverage on three correct pure functions and a completely untested bug in the code that calls them.

## Is the Refactor Worth Keeping?

Depends on what the deletion test returns for each method:

**Keep if:** a method has multiple callers or genuinely complex logic that would spread across callers if inlined. The extraction earns its keep through locality — one place to change, N callers benefit.

**Delete if:** a method has a single caller and its logic is not reused. It is a shallow module: interface nearly as complex as the body, zero locality benefit. Inline it back. You traded one `PlaceOrderAsync` for one `PlaceOrderAsync` + one `OrderPlacementHelper` + three test suites. Net: more code, same behavior, harder to trace orchestration.

The naming pattern `OrderPlacementHelper` is a warning sign. "Helper" is a bucket, not a module with a coherent interface and deep leverage. It suggests the extraction was driven by line count or testability, not by actual reuse or locality.

## What You Should Actually Fix

1. **Write integration-level tests on `PlaceOrderAsync`** that cover order-state preconditions. Specifically: what happens when `PlaceOrderAsync` is called for a cancelled order? That scenario should have a test that fails when the guard is missing.

2. **Add the guard in `PlaceOrderAsync`** — check order state before invoking discount, inventory, or shipment logic. The pure functions do not know about order state; the orchestrator must enforce it.

3. **Revisit the helper methods using the deletion test.** For each: count callers. If single caller, inline. If multiple callers, keep. Do not keep them on the grounds of "high unit test coverage" — that coverage does not test what failed.

4. **After inlining what should be inlined**, delete the corresponding unit tests on those methods. Do not layer the new orchestration tests on top of the old helper tests. The old tests are testing past the real interface; they survive only if the method survives as a genuinely reused module.

---

Candidates I see from this description:

1. `OrderPlacementHelper` (static helper class) — potentially shallow module with hypothetical locality
   - Files: `OrderPlacementHelper` (static), called from `PlaceOrderAsync`
   - Problem: if each method has a single caller, this is a pass-through; the interface surface equals the implementation surface; extraction moved testability but not leverage
   - Proposed change: apply deletion test to each method — inline single-caller methods back into `PlaceOrderAsync`, keep only multi-caller ones
   - Benefits: restores orchestration locality; makes the real interface (`PlaceOrderAsync`) the test surface; eliminates the false-confidence coverage gap

2. `PlaceOrderAsync` orchestration — no test surface on order-state preconditions
   - Files: wherever `PlaceOrderAsync` lives
   - Problem: the sequencing (check order state → apply discount → validate inventory → build shipment) has no test coverage at the interface where the bug lives; tests only exist below that interface
   - Proposed change: add integration-level tests on `PlaceOrderAsync` that assert observable outcomes for cancelled, pending, and live order states
   - Benefits: test surface matches the real interface; catches sequencing bugs that pure-function tests structurally cannot

Which of these would you like to explore?
