# Ubiquitous Language

_Domain glossary for the brainstorming skill's Visual Companion (`skills/brainstorming/`). Extracted from approved design conversations and cross-checked against the current implementation and `docs/work/work-20260712-visual-companion-vnext/spec.md`._

## Instrument & Shell

**Visual Companion** — the browser-based intent and review instrument of the brainstorming skill: one reusable host renders a validated Visual Document through a purpose-built Workspace Kind, with annotation, choice, and chat feedback flowing back into the same agent conversation.
- Aliases to avoid: "the visual", "visual brainstorming tool".
- Relations: composed of a **Visual Shell** rendering a **Visual Document**; its lifetime is one **Visual Session**.

**Visual Shell** — the fixed local renderer assets that host Visual Documents and shared interaction; it is built once, is never generated per session, and retains a read-only v1 compatibility path.
- Aliases to avoid: "the shell" used unqualified.
- Relations: renders a **Visual Document**; part of the **Visual Companion**; "regenerate the visual" never means regenerating this asset (see Ambiguity B).

## Document Model

**Visual Document** — the versioned, schema-validated JSON document that describes everything currently rendered on screen. Version 1 uses profile, audience, title, summary, and 1–12 Sections under an 8 KB cap; version 2 uses a shared envelope plus one Workspace Kind and its concrete content schema.
- Aliases to avoid: "screen", "screen.json" (that's the file it's stored in, not the concept — see Ambiguity C), "visual" (see Ambiguity B).
- Relations: rendered by the **Visual Shell**; replaced wholesale by **Publish**; identified by a **Revision**.

**Profile** — the v1 document-level rendering mode, preserved for compatibility: `technical`, `product`, or `business`. Workspace Kind replaces Profile for v2 purpose selection.
- Aliases to avoid: none noted.
- Relations: set once per **Visual Document**; drives layout and density decisions across all its **Section**s.

**Section** — a v1 top-level block with one fixed kind — `flow`, `cards`, `decision`, `anchor`, `callout`, `timeline`, or `mockup` — preserved by the compatibility renderer.
- Aliases to avoid: "section kind" is not another name for the section itself — the kind is its type property.
- Relations: a v1 **Visual Document** holds 1–12 Sections; each Section is a **Component**.

## Workspace Kinds

**Workspace Kind** — the v2 purpose discriminator that selects one concrete content schema and renderer: Product, Architecture, Research, Business, or Review.
- Aliases to avoid: "profile", "template", "plugin".
- Relations: exactly one belongs to a v2 **Visual Document**; all five share the **Visual Shell**, feedback, delivery, evidence, and lineage contracts.

**Product Concept Studio** — the Product Workspace Kind for comparing three materially different, equal-fixture interface concepts before recording a Choice and detailed handoff.
- Aliases to avoid: "mockup page".
- Relations: one of five **Workspace Kind** renderers; replaces the one-concept v1 Mockup workflow for product decisions.

**Architecture Canvas** — the Architecture Workspace Kind for typed topology, ownership boundaries, current/proposed state, scenario paths, evidence, and spatial review.
- Aliases to avoid: "architecture diagram" when referring to the whole workspace.
- Relations: one of five **Workspace Kind** renderers; uses typed nodes, edges, ports, and compound layout.

**Research Evidence Board** — the Research Workspace Kind for claims, source evidence, contradictions, confidence, unknowns, and decision relevance.
- Aliases to avoid: "research summary".
- Relations: one of five **Workspace Kind** renderers; unsourced summaries are never labeled evidence.

**Business Reasoning Canvas** — the Business Workspace Kind for actors, outcomes, journeys, assumptions, economics, risks, and experiments.
- Aliases to avoid: "business architecture".
- Relations: one of five **Workspace Kind** renderers; excludes Review and developer chrome.

**Feature Review Workbench** — the Review Workspace Kind for navigating from approved intent through Review Slices, actual changes, verification, findings, quality obligations, decisions, and outcomes.
- Aliases to avoid: "code review screen".
- Relations: one of five **Workspace Kind** renderers; keeps whole-feature approval separate from file Viewed progress.

**Core Anchor** — the stable triple of Purpose, Rejection Criteria, and Contrasts that anchors a brainstorm's intent across revisions.
- Aliases to avoid: none noted.
- Relations: rendered by the `anchor` **Section** kind; updated when intent changes during the feedback handoff.

**Item / Node** — a card-shaped content unit carrying an id, a title, an optional one-sentence detail, a tone, and optional points; called an Item inside `cards`/`anchor`/`timeline` sections and a Node inside a `flow` section.
- Aliases to avoid: none noted — the item/node split is itself the canonical, context-bound naming.
- Relations: a **Component**; may carry **Point**s; an **Option** is a Decision-specific specialization of the same shape.

**Point** — a claim-sized text fragment, at most 160 characters, one to six per item or option, rendered as its own annotatable component with a derived positional id (`<owner-id>-pN`).
- Aliases to avoid: "claim".
- Relations: belongs to an **Item / Node** or **Option**; is itself a **Component**; the unit behind **Points Before Prose**.

**Component** — any rendered unit that carries a stable `data-brainstorm-id` and is therefore individually annotatable: sections, items, nodes, regions, options, and derived points/elements.
- Aliases to avoid: "annotation target".
- Relations: the target of an **Annotation**; tracked by **Change Flags** across **Revision**s.

**Tone** — the semantic accent — `neutral`, `accent`, `positive`, `warning`, or `critical` — carried by items, callouts, badges, and cells to signal meaning through color rather than prose.
- Aliases to avoid: none noted.
- Relations: a property of **Item / Node**, `callout` **Section**s, `badge` **Element**s, and **Cells** entries.

## Prototype Model

**Mockup** — the section kind that renders a screen prototype inside a device frame, composed of Regions carrying typed Elements.
- Aliases to avoid: none noted.
- Relations: a **Section** kind; contains **Region**s; meaning drifted from prose-labeled boxes to element-built prototypes (see Ambiguity G).

**Region** — one surface area of a Mockup — toolbar, sidebar, content, footer, and the like — laid out by a span from 1 to 12 and carrying one or more Elements.
- Aliases to avoid: none noted.
- Relations: belongs to a **Mockup**; a **Component**; holds **Element**s.

**Element** — a typed, inert, real-looking UI control placed inside a Region — `heading`, `text`, `button`, `input`, `tabs`, `table`, `list`, `metric`, `badge`, `placeholder`, or `cells` — individually annotatable with a derived id (`<region-id>-eN`).
- Aliases to avoid: none noted.
- Relations: belongs to a **Region**; a **Component**; `cells` is the specialized grid-shaped Element kind.

**Cells** — the Element kind for spatial cell grids — tool racks, slots, bins, seat maps — holding 2 to 60 labeled cells, each with a filled/empty state and a tone flag.
- Aliases to avoid: none noted.
- Relations: an **Element** kind; each cell carries a **Tone**.

## Decision & Feedback Loop

**Decision** — the section kind that poses one selectable question with 2 to 5 Options, offered as a single- or multiselect group, with optional 1–10 scores and at most one Option marked recommended.
- Aliases to avoid: none noted.
- Relations: a **Section** kind; holds **Option**s; a user's answer is recorded as a **Choice**.

**Option** — one candidate answer inside a Decision, carrying a label, an optional one-sentence detail, points, an optional score, and a recommended flag.
- Aliases to avoid: none noted.
- Relations: belongs to a **Decision**; shares the **Item / Node** shape; selecting one produces a **Choice**.

**Choice** — the user's recorded selection of an Option, returned to the agent as data (`{componentId, value, label, groupId}`) rather than as prose.
- Aliases to avoid: none noted.
- Relations: produced by selecting an **Option**; travels inside a **Feedback Batch**; see Ambiguity F.

**Annotation** — a user comment attached to one specific Component target, carrying the comment text and the target's componentId and label.
- Aliases to avoid: "note" (UI label).
- Relations: targets a **Component**; travels inside a **Feedback Batch**; contrast with **Summary Note** (Ambiguity D).

**Summary Note** — the free-text message field of a Feedback Batch, used for document-level feedback that isn't targeted at any one Component.
- Aliases to avoid: "message" (wire field name).
- Relations: one per **Feedback Batch**; contrast with **Annotation** (Ambiguity D).

**Feedback Batch** — the single browser submission that bundles a Summary Note, Annotations, Choices, and screen identity/Revision into one persisted user turn.
- Aliases to avoid: "batch", "browser turn".
- Relations: contains a **Summary Note**, **Annotation**s, and **Choice**s; tagged with a **Revision**; consumed by **Wait**/**Drain** and acknowledged by **Reply**.

**Revision** — the 8-hex content fingerprint (FNV-1a over the normalized Visual Document) that identifies an exact document version, so feedback stays attributable to the screen the user actually saw.
- Aliases to avoid: "rev".
- Relations: carried by every **Feedback Batch**; compared across **Publish** calls to compute **Change Flags**.

**Change Flags** — the browser-computed, component-level diff between two published Revisions: new/updated markers on individual Components plus a strip listing removed ones.
- Aliases to avoid: "revision diff markers".
- Relations: computed between two **Revision**s; marks individual **Component**s.

## Work & Review Lineage

**Work ID** — the stable identity of one intent-to-outcome body of work across specifications, plans, Visual Sessions, implementation attempts, code changes, Decision Records, and later outcomes.
- Aliases to avoid: "session ID", "task ID" — both identify shorter-lived scopes.
- Relations: names one committed work root; referenced by **Decision Record**s, **Review Slice** manifests, and the **Engineering Quality Contract**.

**Decision Record** — the durable semantic record of one architecturally significant choice, including its context, rationale, alternatives, consequences, evidence, status, and later supersession or outcome.
- Aliases to avoid: unqualified "Decision" — **Decision** is already the selectable Visual Document Section.
- Relations: belongs to one **Work ID**; may supersede another Decision Record; links to Acceptance Criteria, implementation changes, findings, and outcomes.

**Review Slice** — a stable review unit whose identity comes from an approved plan task and its Acceptance Criteria mapping, not from inferred graph clustering or prose similarity.
- Aliases to avoid: "capability slice", "file cluster".
- Relations: belongs to one **Work ID**; binds expected ownership to an immutable patch set; overlapping and unmapped changes remain explicit rather than being forced into a Review Slice.

**Engineering Quality Contract** — the approved set of always-on and fact-activated quality obligations for one Work, including measurable responses, verification evidence, owners, exclusions, residual risks, and approval or veto state.
- Aliases to avoid: "quality checklist", "NFR list".
- Relations: belongs to one **Work ID**; activates from observed change facts; governs whole-feature review and may cite Decision Records.

**Active Pair Loop marker** — the compatibility `.pair/active-loop.json` process marker used only to prevent two live CLI processes from dispatching the same repository Work concurrently; a crashed PID makes the marker inert.
- Aliases to avoid: "Work state", "active plan" — the repository event journal and reducer, not this marker, own lifecycle truth.
- Relations: created and removed by the Pair CLI; distinct from an active implementation attempt and never used by Pair v4 continuation or retry decisions.

## Session & Lifecycle

**Visual Session** — the lifetime of one companion server instance: its session directory, capability token, Session Store, and CLI lifecycle (scaffold, start, publish, wait, drain, reply, status, export, stop).
- Aliases to avoid: unqualified "session" — see Ambiguity A.
- Relations: owns a **Session Store**; located via the **Active Session Pointer**; reached through a **Connection URL / Capability Token**.

**Active Session Pointer** — the per-repository file (`active-session.json`, under the scratch root) that locates the currently live Visual Session.
- Aliases to avoid: none noted.
- Relations: points at a **Visual Session**; removed or replaced on stop/restart.

**Publish** — the operation that replaces the current screen with a newly validated Visual Document, guarded by a round-trip-stability check against the schema normalizer.
- Aliases to avoid: none noted.
- Relations: writes a **Visual Document**; produces a new **Revision**; contrast with **Scaffold**, which only drafts.

**Scaffold** — a CLI-generated, schema-valid draft Visual Document filled with placeholder content that teaches the correct kind-specific shape for each requested Section.
- Aliases to avoid: none noted.
- Relations: a starting point later replaced via **Publish**.

**Wait / Drain** — Wait is the one blocking call that resumes the agent's turn when the next unacknowledged Feedback Batch arrives; Drain is the non-blocking counterpart that fetches the oldest unacknowledged batch once, without waiting. Both return a Pending (count).
- Aliases to avoid: none noted.
- Relations: read from the **Session Store**; the wake mechanism behind **Zero Agent Polling**; followed by a **Reply**.

**Pending (count)** — the number of unacknowledged Feedback Batches, returned by Wait and Drain so the agent knows whether a further batch is already queued.
- Aliases to avoid: unqualified "pending" — see Ambiguity E (contrast with the browser-side "Draft").
- Relations: computed from the **Session Store**'s acknowledgement cursor.

**Reply** — the agent's message acknowledging one Feedback Batch, advancing the Session Store's acknowledgement cursor and appearing in the browser's history.
- Aliases to avoid: none noted.
- Relations: acknowledges a **Feedback Batch**; advances the **Session Store** cursor.

**Zero Agent Polling** — the loop discipline the Visual Session enforces: one blocking Wait per browser review, never a repeated Drain or status call on a timer, and never a second model process watching the session.
- Aliases to avoid: none noted.
- Relations: enforced via **Wait**; violated by polling **Drain** or status on a timer.

**Session Store** — the durable, per-session event log — user turns and agent messages recorded in `session.jsonl` — together with the acknowledgement cursor tracking which turns have been replied to.
- Aliases to avoid: none noted.
- Relations: holds every **Feedback Batch** and **Reply**; scoped to one **Visual Session**.

**Connection URL / Capability Token** — the Connection URL is the tokenized URL granting browser access to one Visual Session; the Capability Token is the secret embedded in it. Shared with the user, never persisted, and reissued — invalidating the old one — on every restart.
- Aliases to avoid: none noted.
- Relations: scoped to one **Visual Session**; regenerated on restart (see Ambiguity A).

**Standalone Export** — the self-contained, read-only `visual.html` file that embeds the Visual Shell, the current Visual Document, and the full feedback history; it survives the Visual Session and opens directly from disk.
- Aliases to avoid: "live export" (the auto-refreshed copy kept in the session directory).
- Relations: embeds the **Visual Shell** and **Visual Document**; outlives the **Visual Session**.

## Authoring Grammar

**Inline Text Grammar** — the minimal plain-text markup the Visual Shell renders inside document fields and replies: `**bold**`, `` `code` ``, bare File References, and (in replies only) paragraphs and numbered/bulleted lists — with no HTML ever accepted.
- Aliases to avoid: none noted.
- Relations: rendered by the **Visual Shell**; includes **File Reference** promotion.

**File Reference** — a bare `Factory.cs:135`-style token that the Visual Shell auto-promotes into a styled, click-to-copy chip.
- Aliases to avoid: "file chip".
- Relations: one construct within the **Inline Text Grammar**.

**Points Before Prose** — the authoring rule that Items and Options carry Points by default, with detail limited to at most a one-sentence lede; its violation is the "wall of text" failure mode.
- Aliases to avoid: none noted.
- Relations: governs how **Item / Node** and **Option** author their **Point**s.

## Ambiguities (resolved)

**A. "Session" is overloaded** — across the Claude Code agent conversation, the Visual Session (server/store lifecycle), and individual store events. Canonical: say "Visual Session" whenever the server/store lifecycle is meant, and "agent conversation" for the LLM side. Matters because stop/restart, the Active Session Pointer, and the Capability Token all scope to the Visual Session only — confusing the two previously caused real bugs (stale pointers, orphaned servers).

**B. "Visual" alone is ambiguous** — between the companion, the document, and the shell. Canonical: Visual Companion (the instrument), Visual Document (the content), Visual Shell (the renderer). Matters because "regenerate the visual" must always mean republishing the Visual Document, never regenerating Visual Shell code.

**C. "Screen" vs. Visual Document** — `screen.json` is the storage file; the concept it stores is the Visual Document; the "screen identity" carried inside a Feedback Batch is `{id, file, revision}` (confirmed in `session-store.cjs`'s `normalizeScreen`). Matters because feedback attribution binds to the Revision, not to the file path.

**D. Annotation vs. Summary Note** — an Annotation is Component-targeted; a Summary Note is document-level and untargeted. Matters because Annotations return machine-readable componentIds the agent acts on one-to-one, while Summary Notes don't.

**E. "Pending" is overloaded** — between the browser's unsubmitted draft chips and the agent's unacknowledged batches. Canonical: "Draft" for the browser-side unsubmitted state; "Pending (count)" reserved for unacknowledged Feedback Batches only. Matters because Drafts live in `sessionStorage` and can be lost, while Pending batches are durable on disk in the Session Store.

**F. Decision vs. Option vs. Choice** — these name the question, one candidate answer, and the recorded selection, respectively. Matters because only Choices travel back to the agent as data.

**G. "Mockup" meaning drift** — it formerly meant labeled prose text-regions; it now means an element-built prototype. The old prose-region form is the documented failure mode ("text is not a visualisation"), not a valid alternate reading of "Mockup" going forward.

## Related external products (contrast, not domain terms)

Claude Design (`claude.ai/design`, design-system component libraries surfaced via DesignSync) and the artifact/frontend-design skills produce design artifacts. The Visual Companion captures decisions. Neighboring tools, different jobs — not domain terms of this glossary, listed only to mark the boundary.
