# Should you delete `IPaymentGatewayClient`?

Yes. Rip it out. Your junior is wrong, and the reasoning they're using is an anti-pattern.

Here's the analysis grounded in what you actually have.

---

## Deletion test

Ask: if you deleted `IPaymentGatewayClient` and made all 12 callers depend directly on `StripePaymentGatewayClient`, what happens?

Complexity doesn't reappear across those callers. The interface is a pass-through — every method on `IPaymentGatewayClient` maps 1:1 to a method on `StripePaymentGatewayClient`. There is no behavior hiding behind that interface that the concrete class doesn't already expose. The interface evaporates cleanly.

That's the deletion test result: **delete it**.

---

## The seam is hypothetical, not real

In the vocabulary of this analysis:

- A **seam** is real only when at least two adapters live behind it.
- You have one adapter: `StripePaymentGatewayClient`.
- You have no in-memory test adapter, no Adyen adapter, no stub. Just the one.

One adapter = indirection. That's all it is. The port is paying no rent. It adds a level of naming and routing with zero leverage — callers cross the interface, find exactly one destination, and nothing changes.

The seam isn't even real for tests. If your tests are injecting a mock through `IPaymentGatewayClient`, you have a test-only "adapter" in the sense that mocking frameworks generate one — but that's not a designed adapter, it's a symptom of the interface existing. The interface isn't earning it; the mock exists *because* the interface exists.

---

## Stripe is a true external dep — the port belongs, but only with a real substitute

To be precise: Stripe *is* a true external dependency. The skill's dependency table says:

> **True external** (Stripe, Twilio, Auth0) → Inject as port. Tests use a mock adapter. Treat the port as a contract, not a wrapper.

So a port in front of Stripe is the right *shape* — but only if you also have a mock/in-memory adapter for tests. If all your tests are hitting Stripe (or mocking at the HTTP level), you're not getting any of the seam's benefit. The port is structural overhead without the second adapter.

**If you have a real `IPaymentGatewayClient`-based test double used in integration tests or unit tests:** the seam is earning something. Don't delete it.

**If the mock is just a Moq/NSubstitute auto-generated mock that matches every method signature mechanically:** that doesn't count as a second adapter. Delete the interface.

You know which is true in your codebase. I don't. But you do.

---

## Your junior's argument is the classic anti-pattern

"Keep the abstraction in case we change later" is the textbook version of **adding a port for one implementation**. It treats hypothetical future adapters as justification for present overhead. Six months have passed. The Adyen swap never happened. The interface has not paid one day of rent.

The correct framing: **if you add Adyen tomorrow, add the interface then.** Extracting an interface takes 20 minutes with an IDE. The cost of deferring extraction is near-zero. The cost of carrying a hypothetical seam for six more months (and six more months after that) is real: every new developer reads `IPaymentGatewayClient`, looks for the second implementation, finds one, and has to reason about why the interface exists. That's cognitive overhead on every code touch.

Abstractions should be extracted in response to real pressure, not anticipated pressure that hasn't materialized in half a year.

---

## Candidate

1. `IPaymentGatewayClient` — hypothetical seam with one adapter, no substitute, no leverage  
   **Files:** `IPaymentGatewayClient.cs`, `StripePaymentGatewayClient.cs`, ~12 caller files  
   **Problem:** Shallow seam — one adapter, no in-process or test substitute. The interface is nearly isomorphic to the concrete class. Zero depth differential between interface and implementation.  
   **Proposed change:** Delete the interface. Update all 12 callers to depend directly on `StripePaymentGatewayClient`. If tests are injecting through the interface with a real mock adapter (not an auto-mock), preserve the seam — but only then.  
   **Benefits:** Removes one indirection layer, eliminates hypothetical-seam overhead, reduces the surface new developers have to reason about, and makes the actual dependency on Stripe explicit and honest.

---

## One conditional

Before you delete: check whether any of those 12 callers are tested through a hand-written `FakePaymentGatewayClient` or `InMemoryPaymentGatewayClient`. If that class exists, the seam is real and earns its keep. If all you have is Moq/NSubstitute invocations matching the interface signature, the seam is hypothetical. Delete it.

Which of these would you like to explore?
