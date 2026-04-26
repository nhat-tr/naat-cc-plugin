---
name: module-deepening
description: Tactical refactoring within an existing system using the deletion test, depth-as-leverage, two-adapter rule, and replace-don't-layer test discipline. Use when the user asks "should I extract this", "is this wrapper doing anything", "where should the seam go", "this feels over-abstracted", "is this module pulling its weight", or wants to consolidate tightly-coupled modules. Distinct from architect-workflow (system-level design / ADRs) — this is intra-module/tactical.
---

# Module Deepening

The question this skill answers: **is each module pulling its weight?** Most refactoring advice is generic. This skill replaces it with concrete heuristics adapted from `mattpocock/skills/improve-codebase-architecture`.

## Vocabulary

Use these terms precisely. Don't drift into "service", "component", "API", "boundary", "layer" — those words describe artifacts, not whether the artifact earns its keep.

| Term | Meaning |
| --- | --- |
| **Module** | A unit with an interface and an implementation. |
| **Interface** | The surface callers cross — type signatures, public functions, side-effect promises. |
| **Depth** | Leverage at the interface. A *deep* module packs lots of behavior behind a small surface. |
| **Shallow** | Interface is nearly as complex as the implementation. Net negative. |
| **Seam** | A boundary you can substitute across. Real only when at least two adapters live behind it. |
| **Adapter** | A concrete implementation behind a seam. |
| **Locality** | Changes concentrate in one place rather than spreading across many callers. |

**Why these terms:** *depth*, *seam*, *locality*, *leverage* describe *why* code earns its keep. "Service" and "component" describe artifacts and let weak modules hide behind a name.

## Core Heuristics

### 1. The Deletion Test
For any suspect module, ask: **if I deleted this and inlined its body, what happens?**
- Complexity vanishes → it was a pass-through. Delete it.
- Complexity reappears across N callers → it was earning its keep.

Apply this before any other analysis. It cuts through most "should I extract this" debates.

### 2. Depth = Leverage, Not Line Count
A deep module is one where a *small interface* delivers *a lot of behavior*. Implementation can be 5 lines or 500. Depth is the ratio of behavior-per-call, not absolute sizes.

Reject the framing "implementation should be much larger than interface" (Ousterhout). It rewards padding the implementation rather than concentrating leverage.

### 3. The Interface Is the Test Surface
Callers and tests cross the same boundary. If a test needs to reach *past* the public interface to assert on internal state, the module is the wrong shape — either the interface is missing something callers also need, or the internal seam should be made external.

Corollary: **don't extract a pure function just for testability.** If real bugs live in *how the function is called*, the extraction moves the bug, doesn't fix it. The pure function passes its own tests while the call site is still wrong.

### 4. Two Adapters Make a Seam
One adapter = indirection. Two adapters = a real seam.
- Prod-only adapter with no substitute → call the dep directly. The port is hypothetical and pays no rent.
- Prod adapter + in-memory adapter for tests → real seam, real benefit.

### 5. Replace Tests, Don't Layer Them
After deepening — collapsing N shallow modules into one deep module — the old unit tests on the shallow modules become waste. Delete them. New tests assert observable outcomes through the deep module's interface.

If a test breaks when the implementation changes without observable behavior changing, it's testing past the interface. Fix the test or the interface, not both.

## Dependency-Driven Seam Strategy

Different dependency types want different seam shapes:

| Dependency type | Examples | Seam strategy |
| --- | --- | --- |
| In-process / pure | computation, parsers, formatters | No seam. Test through the new interface directly. |
| Local-substitutable | Postgres → PGLite, FS → in-memory FS | Substitute the dep, not your code. Seam stays internal. |
| Remote owned | your own microservices | Port + prod HTTP/gRPC adapter + in-memory adapter for tests. |
| True external | Stripe, Twilio, Auth0 | Inject as port. Tests use a mock adapter. Treat the port as a contract, not a wrapper. |

Wrong seam costs you. An adapter in front of pure computation is pure overhead. Skipping the port for a true-external dep leaks production behavior into every test.

## Workflow

1. **Scan for friction:**
   - Modules whose interface is nearly as long as their body.
   - Pure functions extracted purely for testability where bugs would live in *how* they're called.
   - Ports with one adapter and no foreseeable second.
   - Tests that need to reach into private state.

2. **Apply the deletion test** to every suspect before flagging.

3. **Surface candidates** — numbered list. For each:
   - **Files** involved
   - **Problem** stated in vocabulary terms (e.g. "shallow seam — one adapter, no substitute planned")
   - **Proposed change** in plain English
   - **Benefits** as locality / leverage / test-surface improvements

   **Do NOT propose new interface signatures yet.** End with: *"Which of these would you like to explore?"*

4. **Discuss before designing.** Once the user picks a candidate, walk the design tree together: what crosses the new interface, what stays internal, what tests survive, what tests get deleted.

5. **Hand off to other skills when warranted:**
   - New domain term named during discussion → invoke `ubiquitous-language` to update `UBIQUITOUS_LANGUAGE.md`.
   - Decision contradicts a prior architectural choice with load-bearing reasoning → invoke `architect-workflow` to record an ADR.
   - Generic readability cleanup falls out of the discussion → invoke `simplify`.

## When This Skill Doesn't Apply

- **System-level design** (new services, technology choices, bounded contexts) → `architect-workflow`.
- **Generic readability** (rename, dead code, formatting) → `simplify`.
- **Bug investigation** → `troubleshoot`.

If the question is *"should this exist at all"*, that's this skill. If the question is *"how should this be organized at system level"*, that's `architect-workflow`.

## Anti-patterns to Call Out

- **Padding implementation to look "deeper".** More lines ≠ more leverage.
- **Adding a port for one implementation.** Hypothetical seam, real overhead.
- **Layering new tests on old after deepening.** Old tests are obsolete; delete them.
- **"Service" / "boundary" / "component" in proposals.** Vocabulary drift. Restate as module / seam / interface.
- **Extracting pure functions purely for testability.** Moves the bug to the call site.

## Output Shape

When surfacing candidates:

```
1. <Module name> — <one-line problem>
   Files: <paths>
   Problem: <vocabulary-grounded — shallow / hypothetical seam / poor locality>
   Proposed change: <plain English, no interface signatures>
   Benefits: <leverage / locality / test surface>

2. ...

Which of these would you like to explore?
```

End with the question. Don't propose interfaces or implementations until the user picks.
