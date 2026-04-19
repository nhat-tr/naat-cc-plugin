---
name: brainstorming
description: "Use before any creative work — new features, components, or behavior changes. Explores intent and requirements before implementation."
---

# Brainstorming Ideas Into Designs

Turn ideas into designs through collaborative dialogue. Understand context, ask questions one at a time, present the design, get user approval.

<HARD-GATE>
Do NOT invoke any implementation skill, write code, scaffold, or take implementation action until the design is presented and approved. Applies to every project — no "too simple" exception. The design can be a few sentences for trivial work, but it must be presented and approved.
</HARD-GATE>

## Core Anchor Protocol

A persistent artifact that prevents and detects intent drift. Establish BEFORE clarifying questions. Reference DURING exploration. Re-verify BEFORE writing the spec. Never silently change.

### The Three Fields

**1. Purpose** — 2–3 sentences in user's domain language, NO solution language. Current state, desired state, why it matters.

> Bad: "Add caching to the API."
> Good: "Product data is served from the primary DB on every request. It changes at most once a day. Serve it faster without changing the API contract."

**2. Rejection Criteria** (1–3 bullets) — what would make this wrong EVEN IF all tests pass? Hidden acceptance tests.

> Examples: "If consumers must change how they call the API → wrong." "If invalidation needs manual ops → wrong."

If the user can't articulate any, intent isn't stable — ask more questions. Do NOT invent criteria for them.

**3. Contrasts** (1–3 bullets, "this is NOT X, because Y") — plausible sibling interpretations this is NOT. Hardest field to fake-confirm.

> Example: "NOT a read-through cache in the DB driver, because we don't want caching coupled to DB access."

### Confirmation Gate (blocking)

Emit all three fields in one message. User confirms or corrects each explicitly. On correction: emit revised anchor, re-confirm. **Do NOT silently patch** — delta must be visible.

### Persistence and Cross-Checks

Once confirmed, anchor is persistent. Reference at three checkpoints:

1. **Direction-setting proposals** — state *"Serves Purpose because X. Does not violate R1/R2/R3."* Only on directional moments, not every question.
2. **Pulse every ~5 Q&A turns** — 3 bullets: Purpose one-liner, emerging direction (max 3), any anchor tension. 15-second read.
3. **Pre-spec re-verification (blocking)** — re-emit current anchor, show delta if any field changed, require explicit re-approval before spec is written.

### Re-Anchoring Rule

If a user correction reveals a field is materially wrong (semantic shift, not wording): STOP. Emit full anchor restatement, re-confirm all three, resume. No mid-flight patching.

### In the Spec

Anchor copied verbatim to top of spec (`## Purpose`, `## Rejection Criteria`, `## Contrasts`) before any other content. Spec body must read as "implementing this anchor."

## Checklist

Complete in order:

1. **Explore project context** — files, docs, recent commits
2. **Offer visual companion** (if visual questions ahead) — own message, no other content. See Visual Companion below.
3. **Establish Core Anchor** — hard gate, before Q&A
4. **Ask clarifying questions** — one at a time; pulse every ~5 turns; cross-check on direction-setting
5. **Propose 2–3 approaches** — trade-offs + recommendation. Each must state how it serves Purpose without violating any RC.
6. **Present design** — sections scaled to complexity; approval per section
7. **Re-verify Core Anchor** — hard gate, before writing spec
8. **Write design doc** — detect mode (see Documentation below)
9. **Spec self-review** — anchor alignment first, then placeholders, contradictions, ambiguity, scope
10. **User reviews written spec**
11. **Stream sketch** (pair mode only) — propose streams (name + one-liner, no file paths, max 6); user approves; write Phase 1 draft to `.pair/plan.md`. Skip in generic mode.
12. **Transition to implementation** — pair mode: set `waiting_for = "plan-detail"`, signal; generic mode: invoke `planner`. Do NOT invoke implementation skills (`frontend-design`, `csharp-dotnet`, etc.) directly — that skips planning.

## Flow

```
explore → [offer visual] → establish anchor → ask Qs (pulse + cross-check)
  → propose approaches → present design → re-verify anchor
  → write spec (detect pair/generic) → self-review → user review
  → stream sketch + plan.md (pair) → signal pair-plan | planner (generic)
```

Any mid-flow anchor correction → re-establish round, not silent patch.

## Understanding the idea

- Scope-check first: if the request describes multiple independent subsystems (chat + billing + analytics), flag immediately and decompose. Don't refine details of a project that needs splitting.
- One question per message. Multiple choice preferred when it fits.
- Focus: purpose, constraints, success criteria.

## Exploring approaches

Propose 2–3 options with trade-offs. Lead with your recommendation and reasoning.

## Presenting the design

Cover architecture, components, data flow, error handling, testing. Scale each section to complexity (one sentence for straightforward, up to ~250 words if nuanced). Ask per section whether it looks right.

**Design for isolation**: smaller well-bounded units are easier to review, test, and reason about. If a file is doing too much, it usually is — include targeted cleanup as part of the design. Don't add unrelated refactoring.

## Documentation

- **Detect mode**: `.pair/` initialized (has `status.json`)? → pair mode. Else generic.
- **Pair mode**: write to `.pair/spec.md` using pair-spec template (F1.AC1 IDs + Verification entries — see `skills/pair-spec/SKILL.md`). Do NOT git-commit (pair protocol handles lifecycle).
- **Generic mode**: write to `docs/specs/YYYY-MM-DD-<topic>-design.md` (user location overrides). Git-commit.
- Anchor verbatim at top in both modes (`## Purpose`, `## Rejection Criteria`, `## Contrasts`) before mode-specific content.

## Spec Self-Review

1. **Anchor alignment** (first): every requirement traces to Purpose; nothing violates an RC; nothing implements a Contrast. If alignment breaks, fix the spec — do not weaken the anchor.
2. Placeholders (TBD/TODO) — fix
3. Internal consistency — fix
4. Scope — focused enough for one plan?
5. Ambiguity — any requirement interpretable two ways? pick one.

Fix inline. No re-review.

## User Review Gate

> "Spec written to `<path>`. Review it and tell me what to change before we plan."

On changes: fix, re-run review loop. Proceed only once approved.

## Stream Sketch (pair mode only)

After spec is approved, propose the stream breakdown before handing off to pair-plan. This seeds `.pair/plan.md` so pair-plan skips re-deriving what brainstorming already established.

1. Propose streams: name + one-liner each, no file paths, max 6. State any obvious sequencing (e.g. "Stream 2 depends on Stream 1").
2. User approves (or adjusts names/grouping).
3. Write `.pair/plan.md` using the Phase 1 format (see pair-plan SKILL.md). Include Intent Check derived from the anchor, Proposed Approach prose, stream list, Key Risks.
4. Update `.pair/stream-log.md`.

## Transition to Implementation

- **Pair mode**: set `waiting_for = "plan-detail"` (not `"plan"` — sketch is already written). Signal.
  ```bash
  tmp="$(mktemp)" && jq '.waiting_for = "plan-detail"' .pair/status.json > "$tmp" && mv "$tmp" .pair/status.json
  jq -r '.dispatch_id' .pair/status.json > .pair/.ready
  ```
- **Generic mode**: invoke `planner`.
- Both: do NOT invoke implementation skills as immediate next step.

## Visual Companion

Browser-based tool for rendering **UI mockups only**. It is NOT a general-purpose "show options nicely" surface. The default answer to "should I use the browser for this?" is **no**.

### Gating test (apply PER QUESTION, before writing any HTML)

Ask: *"Am I about to render a picture of an actual UI — buttons, panels, a layout the user would see in the product? Or am I about to render text (paragraphs, bullets, pros/cons, comparison tables)?"*

- Picture of actual UI → **browser**
- Text, even pretty text → **terminal**

A UI-related topic does NOT make the question visual. "Should Add Expense be a modal, a drawer, or inline?" is a **conceptual choice expressed in text** → terminal, even though the subject is UI.

### Use the browser ONLY for

- Wireframes / layout mockups of actual pages or components
- Side-by-side visual comparisons of rendered UI designs
- Interactive component sketches the user would see in the product

### Use the terminal for everything else

Including (but not limited to):
- Approach / architecture comparisons — even for UI features
- Pros/cons lists, tradeoff tables, A/B/C choices
- Requirements, scope, conceptual questions
- Diagrams that are text (ASCII, mermaid)

### Negative example (what NOT to do)

Question: *"How should Add Expense work from the sidebar?"*
Options: A (Navigate + auto-focus), B (Global slide-over drawer), C (Inline mini-form) — each with a description and pros/cons.

This is a **conceptual choice in text**. Render in the terminal. Using the browser here wastes tokens (HTML round-trip, server overhead) and delivers no visual value — the user reads bullets either way. Same rule applies to any "here are 2–3 approaches, each with tradeoffs" question: terminal.

### Offering (one-time, own message)

> "Some of this might be easier to show in a browser — UI mockups and wireframes only. Token-intensive. Want to try? (Local URL.)"

If accepted, read `skills/brainstorming/visual-companion.md` before using.
