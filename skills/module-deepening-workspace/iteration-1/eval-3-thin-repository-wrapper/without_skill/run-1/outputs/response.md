# Thin Repository Wrapper: Keep or Kill?

The honest answer: **delete it**. The "swap EF Core later" rationale has not aged well, and the wrapper is now pure friction with no payoff.

## Why the justification is hollow

The premise — "we can swap EF Core later" — collapses under scrutiny:

1. **IQueryable leaks through.** If any caller uses `Search` and chains `.Where()`, `.OrderBy()`, or `.Select()` on the result, or if the method returns `IQueryable<Warehouse>` rather than a materialized list, you have already coupled consumers to EF Core's query model. Swapping the ORM still requires touching callers.

2. **EF Core is not a commodity.** Replacing EF Core means replacing LINQ expression trees, change tracking semantics, migration tooling, transaction behavior, and lazy/eager loading conventions. No thin wrapper abstracts any of that. The escape hatch is illusory.

3. **Three years of zero swaps is the data.** The cost of the abstraction has been paid every sprint. The benefit has never materialized. Sunk cost aside, the expected future value is still near zero.

## What the wrapper actually costs

- **Indirection tax on every read.** Eight callers navigate to `WarehouseRepository`, then to the real EF call. Debugging requires two hops.
- **False sense of isolation.** New engineers assume the boundary is meaningful and design around it, adding more wrapper methods rather than using `DbContext` features directly (e.g. `Include`, `AsSplitQuery`, compiled queries).
- **Test surface noise.** You likely have mock setups for the repository interface that test nothing — they mock the mock, not EF behavior.
- **Stalls query optimization.** One-liner wrappers encourage "add a method" over "tune the query." Callers that need projections, pagination, or joins reach for the repo and get a generic result they then filter in memory.

## What direct DbContext access gives you

- Callers express their actual data need: projection, pagination, split queries, raw SQL fallback — without asking for a new repo method each time.
- `DbContext` is already scoped (assuming standard DI setup), so transaction semantics are unchanged.
- You can still extract shared query logic as extension methods on `IQueryable<Warehouse>` — `ApplyFilter(this IQueryable<Warehouse> q, WarehouseFilter f)` — without the repository indirection.

## The one scenario where a repo layer earns its keep

If you have **write-side logic** — invariants, domain events, aggregate-level consistency — that genuinely needs to be enforced in one place before persistence, a repository is warranted. One-liner `FindAsync` wrappers are not that. If `WarehouseRepository` has any methods like that, keep those; delete the rest.

## Migration path

Low risk given eight callers:

1. `grep` for all `IWarehouseRepository`/`WarehouseRepository` usages to get the exact call sites.
2. Inline each call to the equivalent `_context.Warehouses.*` expression. This is mechanical.
3. Delete the repository class and interface.
4. Run the test suite. If tests break only because they were mocking the repo, that's a signal those tests were testing nothing — rewrite them against an in-memory SQLite or testcontainers setup.

The only reason to hesitate is if the team lead has strong feelings and the political cost is not worth it. Technically, there is no argument for keeping it.
