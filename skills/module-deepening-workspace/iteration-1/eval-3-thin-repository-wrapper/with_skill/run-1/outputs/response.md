# WarehouseRepository — Deletion Test

Apply the deletion test first: if you deleted `WarehouseRepository` and inlined its body into all eight callers, what happens?

Each method is a one-liner that re-expresses what `DbContext` already expresses. `GetById` becomes `_context.Warehouses.FindAsync(id)`. `Search` becomes `_context.Warehouses.Where(...).ToListAsync()`. No complexity reappears — it just moves back to the call site, unchanged. **The module fails the deletion test.** It is a shallow pass-through with no depth.

---

## Candidate

1. `WarehouseRepository` — shallow pass-through with a hypothetical seam that has never had a second adapter

   **Files:** `WarehouseRepository.cs`, eight callers across the inventory service

   **Problem:** The interface is nearly as wide as the implementation — each public method maps 1:1 to an EF Core call with no transformation, no guard, no aggregation. There is zero leverage at the interface. Depth = ~1. The seam is hypothetical: one adapter (EF Core / SQL), no substitute, no test double, no plan. Three years confirm the second adapter is not coming. A hypothetical seam pays no rent — it only adds indirection.

   **Proposed change:** Delete `WarehouseRepository`. Inline the EF Core calls at each call site. `DbContext` is already a unit-of-work/repository provided by the framework; wrapping it one-for-one is redundant.

   **Benefits:**
   - *Locality*: each caller owns its query directly. When the query changes, one file changes — not two.
   - *Leverage*: no interface surface to maintain. The framework surface is the interface.
   - *Test surface*: EF Core's in-memory provider or `UseInMemoryDatabase` gives you a local-substitutable dep you can inject at the `DbContext` level — which is the right seam. The repository added nothing to testability that the `DbContext` didn't already provide.

---

## On the "swap EF Core later" argument

This is the one-adapter anti-pattern with a hypothetical justification. Three years, eight callers, no swap. If the swap ever materialised, the correct move would be to introduce the port at that moment — you'd have real requirements to design against. Keeping a leaky abstraction in place for a swap that has a ~0% observed probability is paying overhead now for optionality you have no evidence you'll exercise.

The real swap seam — if you ever needed one — lives at the `DbContext` level anyway (EF Core providers), not at a hand-rolled repository layer above it.

---

Which of these would you like to explore?
