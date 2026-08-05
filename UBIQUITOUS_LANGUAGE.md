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

**Review Slice** — a stable implementation and review unit declared by a **Review Slice Manifest** and mapped to approved Acceptance Criteria, not inferred from files, graph clustering, or prose similarity.
- Aliases to avoid: "capability slice", "file cluster".
- Relations: belongs to one **Work ID**; produces one immutable checkpoint commit and one **Failure Proof** before acceptance.

**Review Slice Manifest** — the sub-16-KiB minimal ordered execution index for one Work: 1–40 stable Review Slice IDs, Acceptance Criteria IDs, intended outcomes, dependency IDs, and verification entrypoints.
- Aliases to avoid: "implementation plan", "execution packet" — the manifest carries navigation, not speculative design.
- Relations: belongs to one **Work ID**; never embeds repository excerpts, implementation decisions, tests, patches, prompts, or review history.

**Architecture Risk** — one bounded statement naming a changed or unknown runtime responsibility that could make an implementation locally correct but operationally unsafe, including ownership, contract, ordering, failure, deployment, replica, middleware, eventing, or UI state behavior.
- Aliases to avoid: "architecture facts list", "risk checklist" — the signal is intentionally open-ended rather than a finite technology enum.
- Relations: activates the **Architecture-Sensitive Path** and is supported by current-code evidence in its **Design Check**.

**Architecture-Sensitive Path** — the Review Slice path activated by one observed or declared **Architecture Risk**, regardless of change size.
- Aliases to avoid: "high complexity path" — activation comes from a changed or unknown runtime responsibility, not size estimates.
- Relations: requires a **Design Check**, a thin vertical checkpoint, fresh model review, and human acceptance before expansion.

**Routine Path** — the Review Slice path allowed only when feature ownership, lifetime, public and persistence behavior, concurrency, and a high-fidelity proof boundary remain unchanged.
- Aliases to avoid: "small change path" — line count does not establish routine risk.
- Relations: escalates to the **Architecture-Sensitive Path** when intent or checkpoint facts violate any routine condition.

**Design Check** — sub-2-KiB Markdown evidence for an Architecture-Sensitive Path: seam/callers, ownership/state/lifetime, runtime/failure/deployment, contract/compatibility, rejected alternative, and proof.
- Aliases to avoid: "Implementation Design Contract", "mini design document".
- Relations: belongs to one Review Slice checkpoint and is reviewed against actual code rather than treated as architecture authority.

**Failure Proof** — the narrowest observed evidence capable of detecting the Review Slice's real failure at its production boundary, such as base reproduction, unit, integration, contract, end-to-end, runtime, or recorded manual evidence.
- Aliases to avoid: "test count", "coverage", "RED signal" — none proves that broken behavior is observable.
- Relations: belongs to one Review Slice; uses a negative control, mutation, base failure, or equivalent observation when feasible.

**Review Outcome** — immutable, addressable, sub-8-KiB evidence from one review of one Review Slice checkpoint, including status, evidence-gated findings, usage, and stable Work/Review Slice/commit/blob bindings. A fresh model review carries at most three findings; a human-authored one records its reviewer provenance and carries at most twenty, because the three-finding bound exists to make a model spend its token budget on its strongest evidence.
- Aliases to avoid: "latest review", "review file" — both lose historical identity.
- Relations: belongs to one **Review Slice**; proposes evidence for human disposition and never triggers code changes by itself. Every finding, human or model, must state a **pass condition** naming observable state, because the bounded correction is instructed to satisfy exactly that.

**Review Feedback** — append-only human adjudication of one Review Outcome finding, expressed as valid, false-positive, not-worth-fixing, or missing-context with a reason.
- Aliases to avoid: "review override" — feedback never mutates historical Review Outcomes.
- Relations: targets one stable finding ID; only valid feedback may authorize one bounded correction.

**Correction Direction** — one bounded, human-authored instruction recorded against a correction-ready **Review Slice** and admitted as intent into that slice's single bounded correction.
- Aliases to avoid: "review comment", "note" — a Correction Direction is neither falsifiable evidence nor an adjudication, and it authorizes no additional correction. Distinct from a human-authored **Review Outcome** finding, which is anchored evidence and is adjudicated: steer with a direction, accuse with a finding.
- Relations: capped at 1000 characters, stored as addressable evidence, and spent with the one correction it steers; admitted at any Review Slice status, and a use outside the correction-ready window is recorded as a **Human Override** rather than refused.

**Human Override** — one recorded human decision that overrules a policy guard — accepting without a model review, unblocking a latched block, steering outside the correction-ready window — carrying a 1–1000 character reason stored as addressable evidence and a named event.
- Aliases to avoid: "force flag", "skip" — an override satisfies the self-explaining-checkpoint invariant by being recorded, not by being forbidden. Structural guards (states that cannot exist, such as accepting a slice with no checkpoint) stay refused and are not overridable.
- Relations: appended to the Work's event journal with the slice, prior status, and reason; authorizes exactly the transition it names.

**Known Failure Baseline** — the human-only declaration that one test identity failed before this Work existed, recorded with the evidence that it pre-exists, so it never counts as this Work's failure again.
- Aliases to avoid: "flaky list", "skip list" — a baselined test still runs; only its failure attribution changes. Pair never infers a baseline entry.
- Relations: entries copy the test identity verbatim from `pair-loop verify` output; an unrecognised runner yields no identity and is never exempted; a baseline over 32 tests is a broken suite, not a baseline.

**Review Guidance** — compact repository-local reviewer rules derived from Review Feedback, proven in a **Review Evaluation Bank**, scope-tagged, and activated only by explicit human approval.
- Aliases to avoid: "model memory", "global review prompt".
- Relations: cites source Review Feedback and evaluation results; a 32-KiB repository index retains at most 16 active rules, and at most three relevant rules enter one fresh review.

**Review Evaluation Bank** — a bounded repository-local set of 20–50 representative accepted findings, false positives, missed defects, and manual escapes used offline to compare reviewer guidance or policy changes.
- Aliases to avoid: "review memory", "finding archive" — runtime review never receives the bank.
- Relations: capped at 32 KiB and references fixtures; measures known-defect detection, blocking precision, escapes, token use, duration, attempts, and human rework before Review Guidance activation or Pair rollout. Its sub-16-KiB result retains aggregate metrics, digests, and failing IDs rather than trial payloads.

**Engineering Quality Contract** — the approved set of always-on and fact-activated quality obligations for one Work, including measurable responses, verification evidence, owners, exclusions, residual risks, and approval or veto state.
- Aliases to avoid: "quality checklist", "NFR list".
- Relations: belongs to one **Work ID**; activates from observed change facts; governs whole-feature review and may cite Decision Records.

**Active Pair Loop marker** — the compatibility `.pair/active-loop.json` process marker used only to prevent two live CLI processes from dispatching the same repository Work concurrently; a crashed PID makes the marker inert.
- Aliases to avoid: "Work state", "active plan" — the repository event journal and reducer, not this marker, own lifecycle truth.
- Relations: created and removed by the Pair CLI; distinct from an active implementation attempt and never used by Pair v4 continuation or retry decisions.

**Dispatch Lease** — the per-Work mutual exclusion held across one whole `pair-loop run` advance, so two concurrent runs cannot race one Work's state or dispatch the same action twice.
- Aliases to avoid: "lock file" — the lease names its owner. Acquired by `mkdir` atomicity with owner PID and nonce; an owner whose PID is gone is abandoned, not authoritative.
- Relations: underpins `pair-loop dispatch status|pause|continue|stop`; released in a `finally`; acquired after the **Machine Verification Lease** when both are needed, never before it.

**Machine Verification Lease** — the machine-wide mutual exclusion allowing only one Work's deterministic verification to run at a time, because concurrent suites share the machine's containers, ports, and databases and make each other fail in unrelated places.
- Aliases to avoid: "global lock" — the lease is scoped to verification, and a refusal names the running Work.
- Relations: same owner-PID-and-nonce pattern as the **Dispatch Lease**; acquired machine-first then per-Work to prevent deadlock; failures produced without it can be neither trusted nor added to a **Known Failure Baseline**.

## Session & Lifecycle

**General Agent Conversation** — a registered Codex or Claude agent conversation that is not owned by Pair Work or a brainstorming Visual Companion and maintains its Agent Conversation Checkpoint from bounded semantic conversation evidence.
- Aliases to avoid: "normal session", "plain session" — both overload session and fail to distinguish the provider conversation from other session lifecycles.
- Relations: may be enabled once per repository or environment; is automatically checkpointed at Stop; uses provider transcripts only as a bounded recovery source; remains subject to the same Freshness Gate and Agent Conversation Handover adoption contract.

**Cold Agent Conversation** — a registered Codex or Claude agent conversation whose deterministic idle age has reached the configured freshness policy; the classification does not assert that the provider actually evicted its cache.
- Aliases to avoid: "cold session", "expired session", "cache-evicted conversation" — the first is ambiguous, and the latter two claim provider state the toolkit cannot observe.
- Relations: stopped by the **Freshness Gate**; supplies an **Agent Conversation Handover** to a fresh agent conversation; becomes a **Retired Agent Conversation** after direct adoption or after its one authorized cold-resume turn seals a refreshed handover.

**Agent Conversation Checkpoint** — the bounded semantic state needed to preserve current intent, evidence, decisions, unresolved questions, and the next action while an agent conversation is still warm.
- Aliases to avoid: "conversation summary", "transcript snapshot" — both imply unbounded or raw conversation content rather than approved semantic state.
- Relations: maintained at material boundaries; sealed into an **Agent Conversation Handover** when its agent conversation becomes cold.
- For Pair Work it has two layers with different authorities: a **lifecycle layer** re-derived from the Pair reducer at every Stop, and a **conversation layer** (findings, confirmed choices, rejected alternatives, unresolved decisions) that no repository state can re-derive and that therefore survives every re-derivation.

**Pair Authority** — the seam that answers which store — the attempt-ledger reducer or the Evidence-at-Commit engine — holds lifecycle truth for a repository's Pair Work, so handover, freshness, and ownership checks read the store the repository actually uses.
- Aliases to avoid: "store selector", "state fallback" — the seam decides authority once; callers never consult both stores and reconcile.
- Relations: consulted by **Agent Conversation Handover** capture and adoption; derives the lifecycle layer of a Pair **Agent Conversation Checkpoint**.

**Observed Activity** — evidence that a registered agent conversation is still working, reported by a hook that saw it act rather than finish a turn.
- Aliases to avoid: "heartbeat", "keep-alive" — neither conveys that the evidence is a real unit of work, nor that it is bounded.
- Relations: advances Freshness Gate activity between Stop boundaries; bounded by the **Unstopped-Turn Ceiling**; never registers, resurrects, or reseals an agent conversation.

**Unstopped-Turn Ceiling** — the maximum span of Observed Activity the Freshness Gate accepts past the last Stop-confirmed turn boundary before it stops extending liveness.
- Aliases to avoid: "timeout", "idle limit" — the ceiling bounds *credited activity*, not idleness, and expiring it withholds an extension rather than terminating anything.
- Relations: anchored by the most recent Stop; re-anchored only by another Stop, never by Observed Activity itself; once exceeded, the conversation ages into a **Cold Agent Conversation** on the ordinary 60-minute boundary.

**Agent Conversation Handover** — an immutable, bounded transfer of one Agent Conversation Checkpoint that exactly one fresh agent conversation can adopt without resuming or forking the source history.
- Aliases to avoid: "session resume", "context replay", "latest handover" — these obscure the fresh-conversation boundary or lose exact identity when several conversations coexist.
- Relations: produced from an **Agent Conversation Checkpoint**; guarded by the **Freshness Gate**; adoption retires the source agent conversation.

**Freshness Gate** — the deterministic pre-model policy boundary that decides whether a registered agent conversation may process another prompt or must transfer through an Agent Conversation Handover.
- Aliases to avoid: "cache check", "token warning" — cache state is not observable, and a warning does not enforce the boundary.
- Relations: classifies a **Cold Agent Conversation** from idle age; blocks it before model processing; remains inert for unregistered agent conversations.

**Retired Agent Conversation** — a source agent conversation whose current Agent Conversation Handover was either adopted or replaced by the refreshed handover sealed at the Stop boundary of its one authorized cold-resume turn; the source may no longer continue automatically.
- Aliases to avoid: "dead session", "completed Work" — retirement concerns conversation continuation, not process liveness or Work outcome.
- Relations: created by successful handover adoption or successful one-shot checkpoint refresh; after adoption, continue in the adopter, while after refresh, launch and adopt the exact refreshed Agent Conversation Handover; remains distinct from paused, blocked, or complete Pair Work.

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
