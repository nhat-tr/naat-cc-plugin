# DR-001: Structured Visual Companion vNext

- **Schema:** 1
- **Status:** accepted
- **Work ID:** `work-20260712-visual-companion-vnext`
- **Origin Spec:** `docs/work/work-20260712-visual-companion-vnext/spec.md`
- **Acceptance Criteria:** AC-1 through AC-24
- **Supersedes:** none
- **Superseded By:** none

## Context

The current Visual Companion reliably persists browser feedback in the happy path, but its one-shot filesystem Wait can miss notifications and cannot start an idle agent turn. Its fixed document grammar renders product, architecture, research, business, and review content through the same narrow card-oriented shell. Pair 3 also lacks committed semantic lineage from approved intent through implementation and later redesign.

## Decision

Build a structured multi-workspace Visual Companion with:

- one shared Visual Session, evidence, feedback, delivery, and lineage kernel;
- purpose-built Product, Architecture, Research, Business, and Review renderers;
- React Flow plus ELK for typed architecture graph interaction and layout;
- Playwright browser geometry, accessibility, responsive, and screenshot verification;
- active-turn delivery through MCP Wait and idle delivery through Codex App Server and Claude Channel adapters;
- a committed `docs/work/<work-id>/` semantic root;
- stable Review Slices derived from approved Pair task and AC mappings;
- a fact-activated Engineering Quality Contract; and
- bounded low-cost scout waves with coordinator-owned synthesis.

## Rationale

This design keeps intent and the current feature central while giving each decision type the visual structure it needs. It reuses the proven storage/authentication kernel, adds dependencies only for established graph and browser-testing mechanics, and creates a real two-adapter boundary at the runtime-owned conversation protocol. Durable semantic records allow a later session or manual review to explain which choice failed and why without committing private model telemetry.

## Alternatives Rejected

- **Document Renderer Plus (7.5/10):** lower migration cost, but remains weak for topology, spatial drill-down, and equal-fidelity UI comparison.
- **General Infinite Canvas (6.5/10):** supplies drawing mechanics but not intent, evidence, quality, review, or lineage semantics.
- **Vanilla DOM and custom SVG (7.5/10):** preserves the current dependency style but requires hand-building camera, selection, edge routing, nested boundaries, hit targets, and accessibility.
- **Active Wait only (9/10 reliability, incomplete outcome):** fixes current missed delivery but cannot satisfy idle same-conversation continuation.

## Consequences

- The companion gains a frontend build and pinned runtime dependencies.
- Visual Document v2 requires separate Workspace Kind schemas plus a v1 compatibility importer.
- Codex and Claude idle delivery remain vendor-specific and must queue safely when capability prerequisites are absent.
- Git-trackable semantic work artifacts become part of normal Pair 3 output.
- Visual verification expands from source-string assertions to real browser fixtures, geometry, accessibility, and screenshots.

## Evidence

- Spec: `docs/work/work-20260712-visual-companion-vnext/spec.md`
- Approved Visual Document Revision: `b0f64e58`
- Current transport: `skills/brainstorming/scripts/session-store.cjs:224-269`
- Current renderer: `skills/brainstorming/assets/visual-shell/app.js:318-515`
- Current plan mapping: `skills/pair-v3/scripts/lib/pair-core.js:54-222`
- Official Codex protocol: <https://developers.openai.com/codex/app-server/>
- React Flow: <https://reactflow.dev/>
- ELK: <https://eclipse.dev/elk/>
- Playwright visual comparisons: <https://playwright.dev/docs/test-snapshots>

## Implementation

- Base: not started
- Changes: not started

## Outcomes

None yet.

## Learning

The original live-session design treated durable browser persistence and agent wake-up as one capability. They are distinct: persistence belongs to the Visual Session kernel, completing an active Wait belongs to MCP, and initiating an idle turn belongs to runtime-specific adapters.
