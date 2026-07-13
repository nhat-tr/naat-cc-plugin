# Spec: Visual Companion vNext

- **Work ID:** `work-20260712-visual-companion-vnext`
- **Status:** Design approved
- **Decision Record:** `decisions/DR-001-visual-companion-vnext.md`
- **Approved Revision:** Visual Document `b0f64e58`

## Purpose

Make the Visual Companion the intent-first workspace family for Pair 3. Keep the current feature or business question central from brainstorming through specification, implementation, and review. Use distinct visual structures for product concepts, architecture, research, business reasoning, and software review; deliver every Feedback Batch to the same agent conversation without a terminal nudge; and preserve later outcomes for learning.

## Rejection Criteria

- One generic layout turns diagrams, evidence, business models, or UI prototypes into bordered prose.
- A UI decision gets one concept when multiple viable directions exist, or speculative future work displaces the current feature.
- Feedback can be stranded, or a later redesign cannot trace the originating intent, choice, implementation, and missed evidence.

## Contrasts

None. Non-goals belong in Out of Scope instead of duplicating Rejection Criteria.

## Constraints

- Preserve the proven local kernel: loopback HTTP, capability-cookie authentication, durable JSONL, idempotent Feedback Batches, stable Component IDs, Revision attribution, and standalone export.
- Treat browser feedback as untrusted user input. It never bypasses agent permissions, repository instructions, or evidence gates.
- Keep semantic content schema-validated. Do not allow arbitrary HTML, executable code, remote scripts, or prompt instructions inside a Visual Document.
- Preserve read-only rendering of Visual Document v1 exports and provide an explicit v1-to-v2 import path.
- Keep `.pair/` as ignored active workflow state. The canonical semantic lineage is Git-trackable under `docs/work/<work-id>/`.
- Keep raw model events, prompts, private session data, capability tokens, routing telemetry, and cost data outside Git.
- Keep the current feature and its acceptance evidence as the unit of approval. Future-pressure scenarios are optional Architecture evidence only when supported by an explicit roadmap item, existing sibling, observed incident, or representative history.
- Exact dependency versions must be pinned from package metadata during plan promotion. No dependency may be installed before the promoted plan is approved.
- Codex App Server idle delivery is supported by a documented protocol. Claude Channel is a research-preview dependency; the implementation must queue safely when its ordering or availability contract is not met.
- The root currently has no frontend runtime or build dependencies. The new build must emit fixed local assets and a self-contained read-only export.

## Evidence

### Repository

- `skills/brainstorming/scripts/session-store.cjs:178-289` provides durable, idempotent Feedback Batch storage and acknowledgement.
- `skills/brainstorming/scripts/session-store.cjs:224-269` uses a one-shot filesystem Wait and currently drops `fs.watch` callbacks whose filename is absent.
- `skills/brainstorming/scripts/server.cjs:207-331` provides browser SSE, screen/session persistence, and the server-side watcher behavior.
- `skills/brainstorming/scripts/visual-document.cjs:1-315` limits the current Visual Document to seven Section kinds and 8 KB.
- `skills/brainstorming/assets/visual-shell/app.js:318-515` renders the same card/document primitives for all current Profiles.
- `skills/brainstorming/assets/visual-shell/styles.css:109-183` implements the fixed document layout and exposed the timeline grid regression.
- `skills/pair-promote/SKILL.md:55-101` defines stable task IDs, AC mappings, expected files, and verification commands.
- `skills/pair-v3/scripts/pair-task:274-321` performs task review but overwrites the latest review files and reviews the cumulative current tree.
- `skills/pair-v3/scripts/lib/pair-core.js:567-588` records attempt identity without spec, AC, expected-file, or Decision Record linkage.

### External Primary Sources

- [React Flow](https://reactflow.dev/) supplies custom typed nodes, edges, pan, zoom, selection, and node-based interaction under MIT licensing.
- [Eclipse Layout Kernel](https://eclipse.dev/elk/) supplies deterministic automatic layout, including layered graphs, ports, routing, and compound hierarchy.
- [Playwright visual comparisons](https://playwright.dev/docs/test-snapshots) provide browser screenshot and geometry verification.
- [ISO/IEC 25010:2023](https://www.iso.org/standard/78176.html) supplies the quality-characteristic vocabulary used for fact-activated obligations.
- [NIST SSDF](https://csrc.nist.gov/projects/ssdf) supports a risk-based, continuously improving secure-development contract rather than a universal checklist.
- [SEI ATAM](https://www.sei.cmu.edu/library/architecture-tradeoff-analysis-method-collection/) supports selective quality scenarios, sensitivity points, and tradeoff analysis.
- [GitHub review guidance](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/reviewing-proposed-changes-in-a-pull-request) distinguishes review progress from intent and invalidates Viewed state when a file changes.
- [Codex App Server](https://developers.openai.com/codex/app-server/) supports `thread/resume`, `turn/start`, and `turn/steer` for a managed Codex conversation.

## Decisions

### D-1: Work and Semantic Lineage

- `docs/work/<work-id>/work.json` is the machine-readable lineage index.
- `docs/work/<work-id>/spec.md` is the canonical approved specification.
- `.pair/spec.md` is a generated active mirror containing the canonical path and digest.
- `docs/work/<work-id>/decisions/DR-*.md` stores architecturally significant Decision Records.
- `docs/work/<work-id>/outcomes/*.md` stores later validation, failure, redesign, or learning events.
- Git changes and Pair attempts carry a small envelope: Work ID, spec digest, Decision Record IDs, AC IDs, plan digest, base, patch-set identity, disposition, and cause.

### D-2: Visual Document v2 Envelope

Visual Document v2 has a shared envelope for Work ID, Workspace Kind, title, evidence references, Revision, frames, Component identities, decisions, and feedback threads. Each Workspace Kind owns a separate validated content schema and renderer. Visual Session persistence, authentication, Feedback Batch delivery, Reply acknowledgement, and exports stay workspace-independent.

### D-3: Purpose-Built Workspace Kinds

- **Product Concept Studio:** starts with an A/B/C concept set using the same device, data fixture, scope, and fidelity. Concepts must differ in information architecture or interaction model, not only color or spacing. The recommendation is hidden until the reviewer inspects or provisionally selects a concept. Focus mode then covers states, responsive behavior, accessibility, and implementation handoff.
- **Architecture Canvas:** renders typed nodes, typed edges, ports, ownership boundaries, nesting, current/proposed state, scenario paths, zoom levels, risks, and linked Decision Records.
- **Research Evidence Board:** links claims to primary sources, contradictions, confidence, unknowns, clusters, and decision relevance. Summaries remain visibly distinct from evidence.
- **Business Reasoning Canvas:** renders actors, outcomes, journeys, assumptions, economics, risks, and experiments without developer-tool chrome.
- **Feature Review Workbench:** links the canonical spec to Review Slices, expected and actual changes, symbols, tests, runtime evidence, findings, patch-set progress, quality obligations, decisions, and later outcomes.

### D-4: Rendering Substrate

Use React with React Flow for interactive typed graph mechanics and ELK for deterministic graph layout. Use ordinary React renderers for Product, Research, Business, and Review structures; do not force non-graph work into a graph canvas. Use Playwright for real browser, geometry, responsive, accessibility, and screenshot verification. Excalidraw or Mermaid may be supported later as an export or freeform mode, not as the semantic core.

### D-5: Engineering Quality Contract

Every Work carries an Engineering Quality Contract. The always-on spine is intent fit, maintainable scope, traceable verification, independent review, and the repository security baseline. Security, privacy, accessibility, reliability, compatibility, performance, Architecture, safety, and compliance obligations activate from observed change facts.

Automation may open an obligation or request review; it may never mark an obligation `not_applicable`. A `not_applicable` record requires evidence, decider, reviewer, owner, residual risk, and approval state. The user approves ordinary exclusions. A named domain owner or CODEOWNER must approve security, privacy, accessibility, safety, or compliance exclusions; without one, a triggered high-impact obligation remains open.

### D-6: Stable Review Slices

Validated Pair task IDs define Review Slice identity. A Review Slice carries its stream ID, AC IDs, expected files, and verification command. Generic work must declare equivalent stable IDs; inferred path groups are navigation only.

Actual attribution uses immutable per-attempt patch sets. Files or hunks claimed by multiple tasks are `cross-slice`; unexpected files or hunks are `unmapped`. No graph-clustering or prose-similarity heuristic forces ownership. Given the same base tree, head tree, plan digest, and indexer version, normalized and sorted Review Slice manifests must be byte-identical and have the same digest.

### D-7: Agent-Conversation Delivery

- An MCP `wait_for_feedback` tool completes an already-active tool call and returns the oldest durable Feedback Batch without polling.
- The MCP tool timeout is configured for the review window; cancellation or timeout leaves the Feedback Batch pending.
- A Codex App Server adapter resumes the Work thread and starts an idle turn with the Feedback Batch.
- A Claude Channel adapter sends the Feedback Batch into a supported open Claude conversation. If the preview capability is unavailable or ordering is uncertain, it queues without claiming delivery.
- CLI `resume` is recovery only; it is never presented as the same live terminal process.
- The browser shows `listening`, `queued`, `delivered`, `acknowledged`, `reconnecting`, or `closed` from observed state.

### D-8: Bounded Delegation

Deterministic parsing and indexing run before model delegation. A low-effort scout receives at most 4 Review Slices, 40 changed files, or 1,200 changed lines, whichever limit is reached first. The brief remains at most 4 KB and the evidence packet at most 6 KB.

Run at most 3 scouts concurrently and at most 2 waves before coordinator or human reprioritization. An oversized Review Slice receives a deterministic shortlist of changed public symbols, boundary crossings, tests, and unknowns instead of a raw giant diff. Scouts do not edit, delegate, select architecture, or merge by prose similarity. The coordinator verifies load-bearing evidence and resolves conflicts from source.

### D-9: Reliability, Security, and Export

- Treat an absent `fs.watch` filename as a reconciliation signal, use a bounded fallback reconciliation while waiting, and perform a final timeout scan.
- Detect server death and return a distinct closed state instead of waiting to timeout.
- Add SSE heartbeat and full screen/session reconciliation on open and reconnect.
- Preserve loopback binding, scoped capability cookies, same-origin writes, CSP, size limits, private session permissions, and idempotent submission/reply behavior.
- Standalone export embeds the current workspace, evidence labels, decisions, and feedback history read-only without a server or token.

### D-10: Visual Quality Contract

Every Workspace Kind has representative fixtures at desktop and mobile widths. Browser tests verify no blank canvases, overflow, overlap, occlusion, unreachable controls, or collapsed content columns. Geometry assertions and screenshot comparisons cover the exact timeline regression that source-string tests missed. Product concepts use real labels, realistic data, icons from the chosen icon library, interaction states, and responsive constraints.

## Engineering Quality Contract

| ID | Quality | Status | Trigger and required response | Owner |
| --- | --- | --- | --- | --- |
| EQC-BASE | Intent and maintainability | active | Every change maps to Purpose, Rejection Criteria, ACs, existing capability evidence, and a justified scope. | Pair coordinator |
| EQC-SEC | Security and privacy | active | Browser input, capability authentication, local IPC, runtime adapters, and stored evidence require threat-boundary tests and secret-safe logging. | Runtime owner |
| EQC-REL | Reliability and operations | active | Durable state, Wait, SSE, MCP, and idle delivery require crash, timeout, retry, reconnect, idempotency, and recovery evidence. | Runtime owner |
| EQC-COMP | Compatibility and evolution | active | Visual Document v1, CLI commands, exports, Pair artifacts, and persisted sessions require import, migration, and backout evidence. | Pair coordinator |
| EQC-A11Y | Accessibility and interaction | active | Keyboard review, focus, annotation, canvas navigation, color, semantics, and responsive layout require automated and manual WCAG evidence. | Frontend reviewer |
| EQC-PERF | Performance and capacity | active | Large graphs and a 300-file review require measured load, interaction, layout, and export budgets. | Frontend reviewer |
| EQC-ARCH | Architecture and tradeoffs | active | New frontend/runtime dependencies, workspace boundaries, and two vendor adapters require Decision Records and verified capability evidence. | Senior reviewer |

## Acceptance Criteria

- [ ] AC-1: Visual Document v2 validates a shared envelope and five Workspace Kinds, and each representative fixture renders a visibly distinct purpose-specific layout at desktop and mobile widths.
- [ ] AC-2: Product Concept Studio presents three materially different concepts with identical fixture data, device, scope, and fidelity; hides recommendation until initial inspection; records one Choice; and preserves responsive, state, accessibility, and handoff details for the selected concept.
- [ ] AC-3: Architecture Canvas renders typed nodes, edges, ports, nested ownership boundaries, current/proposed state, and scenario paths with usable pan, zoom, focus, and annotation targets.
- [ ] AC-4: Research Evidence Board links each material claim to source evidence, displays contradictions, confidence, and unknowns, and never labels an unsourced summary as evidence.
- [ ] AC-5: Business Reasoning Canvas renders actors, outcomes, journeys, assumptions, economics, risks, and experiments without Review or developer chrome.
- [ ] AC-6: Feature Review Workbench navigates from spec AC to Review Slice, expected and actual files/hunks/symbols, verification evidence, findings, patch-set state, quality obligations, decisions, and outcomes.
- [ ] AC-7: Every meaningful Component supports Revision-bound typed feedback threads with reply and open/resolved/outdated state; Choices and Summary Notes remain distinct Feedback Batch data.
- [ ] AC-8: Existing Visual Document v1 fixtures and standalone exports remain readable, and a deterministic importer produces an equivalent v2 read-only workspace without losing Component or feedback identity.
- [ ] AC-9: An active MCP `wait_for_feedback` call returns the oldest durable Feedback Batch to the same active turn without model polling, and cancellation or timeout leaves it pending.
- [ ] AC-10: The Codex App Server adapter starts a new turn on the recorded idle thread, while the Claude Channel adapter delivers to a supported open conversation or truthfully queues when unsupported; neither duplicates a Feedback Batch.
- [ ] AC-11: Wait handles absent filenames, watcher errors, final timeout reconciliation, server closure, multiple queued batches, SSE disconnect/reconnect, and reply acknowledgement without losing or duplicating feedback.
- [ ] AC-12: The browser derives and displays listening, queued, delivered, acknowledged, reconnecting, and closed states from server and adapter evidence rather than optimistic text.
- [ ] AC-13: Starting approved Work creates a Git-trackable `docs/work/<work-id>/` root with `work.json`, canonical `spec.md`, and a digest-linked `.pair/spec.md` mirror; ignored artifacts are references only.
- [ ] AC-14: Decision Records are immutable after acceptance, can be superseded by another record, link to ACs/evidence/changes, and accept later outcome records from another session or manual review.
- [ ] AC-15: Engineering Quality Contract facts open applicable obligations; `not_applicable` requires the approved evidence and ownership fields; high-impact exclusions cannot close without the required domain approval.
- [ ] AC-16: Equal base tree, head tree, plan digest, and indexer version inputs produce byte-identical sorted Review Slice manifests and equal digests; cross-slice and unmapped changes remain explicit.
- [ ] AC-17: Scout orchestration enforces packet, concurrency, and wave caps; oversized Review Slices receive deterministic shortlists; no scout edits, delegates, or selects architecture.
- [ ] AC-18: File Viewed state is patch-set-specific, changes invalidate only affected file/AC evidence, and final approval requires a cumulative whole-feature verdict independent of file-view progress.
- [ ] AC-19: Unauthenticated, cross-origin, oversized, malformed, or stale-capability requests are rejected without exposing tokens, private paths, prompts, or secret values in logs or exports.
- [ ] AC-20: All Workspace Kinds support keyboard-only navigation, visible focus, semantic labels, reduced motion, non-color-only state, text reflow, and usable desktop/mobile layouts.
- [ ] AC-21: Browser geometry and screenshot tests prove all fixtures are nonblank and free of overlap, clipped text, collapsed content columns, and unreachable controls, including timeline Point text using the full content column.
- [ ] AC-22: A fixture representing 300 changed files and a large architecture graph meets recorded load, layout, interaction, and export budgets without blocking feedback persistence.
- [ ] AC-23: A standalone export opens without server, token, or network and preserves the selected Workspace Kind, evidence labels, Decision/Choice state, feedback history, and Revision read-only.
- [ ] AC-24: The complete repository validation passes with pinned dependency licenses recorded and generated runtime assets synchronized.

## Verification

- AC-1: `npm run test:brainstorming:e2e -- --grep "workspace fixtures"` and `npm run test:brainstorming:visual -- --grep "workspace fixtures"` at 1440x900 and 390x844.
- AC-2: `npm run test:brainstorming:e2e -- --grep "product concept set"` plus screenshot comparison of the A/B/C wall and selected focus state.
- AC-3: `npm run test:brainstorming:e2e -- --grep "architecture canvas"` with node/edge/boundary counts, camera interaction, and annotation assertions.
- AC-4: `npm run test:brainstorming:e2e -- --grep "research evidence board"` with sourced, conflicting, and unknown claim fixtures.
- AC-5: `npm run test:brainstorming:visual -- --grep "business reasoning canvas"` with a chrome-absence assertion.
- AC-6: `npm run test:brainstorming:e2e -- --grep "feature review workbench"` using a canonical spec, plan, patch set, verification, finding, and outcome fixture.
- AC-7: `npm run test:brainstorming:e2e -- --grep "feedback threads"` covering typed thread lifecycle across Revisions.
- AC-8: `npm run test:brainstorming -- --test-name-pattern "legacy visual document"` and open every checked-in v1 fixture as a v2 read-only workspace.
- AC-9: `npm run test:brainstorming:runtime -- --grep "active MCP wait"` with submit, cancel, timeout, reconnect, and recovery cases.
- AC-10: `npm run test:brainstorming:runtime -- --grep "Codex App Server|Claude Channel"` plus one local pilot for each installed supported runtime.
- AC-11: `npm run test:brainstorming -- --test-name-pattern "transport recovery"` and `npm run test:brainstorming:e2e -- --grep "SSE reconnect"`.
- AC-12: `npm run test:brainstorming:e2e -- --grep "delivery states"` with server and adapter state transitions.
- AC-13: `npm run test:brainstorming -- --test-name-pattern "work lineage root"` in a temporary Git repository, including ignore and digest checks.
- AC-14: `npm run test:brainstorming -- --test-name-pattern "decision record lifecycle"` with accepted, superseded, and later manual outcome fixtures.
- AC-15: `npm run test:brainstorming -- --test-name-pattern "engineering quality contract"` covering activation, ordinary exclusion, specialist veto, and unresolved high-impact exclusion.
- AC-16: `npm run test:pair -- --test-name-pattern "review slice manifest"` executed twice with equal inputs and once each with overlap and unmapped fixtures.
- AC-17: `npm run test:brainstorming -- --test-name-pattern "scout budget"` with 7-slice, 24-slice, oversized-slice, and 300-file fixtures.
- AC-18: `npm run test:brainstorming:e2e -- --grep "patch set review progress"` covering unchanged, changed-again, outdated-thread, and cumulative-verdict states.
- AC-19: `npm run test:brainstorming -- --test-name-pattern "visual security"` plus authenticated and unauthenticated real-server integration tests.
- AC-20: `npm run test:brainstorming:a11y` with keyboard journeys at desktop/mobile widths and a manual WCAG review artifact linked from the Work root.
- AC-21: `npm run test:brainstorming:visual` with pixel comparisons and explicit bounding-box assertions for every representative fixture.
- AC-22: `npm run test:brainstorming:performance` with recorded budgets and the 300-file/large-graph fixture.
- AC-23: `npm run test:brainstorming:e2e -- --grep "standalone workspace export"` with network disabled.
- AC-24: `npm run validate` and `node scripts/generate-runtime-assets.js --check`.

## Out of Scope

- A general-purpose Figma, Miro, Excalidraw, or collaborative whiteboard replacement.
- Multi-user accounts, remote hosting, cloud persistence, or real-time co-editing.
- Editing production source code directly from a Visual Document annotation.
- Arbitrary generated HTML, CSS, React, JavaScript, or remote media inside Visual Document content.
- Treating a repository graph, hotspot, coupling edge, or model summary as a correctness verdict.
- Requiring future-feature scenarios for ordinary local work or adding extension points for hypothetical variation.
- Presenting CLI resume, a spawned model, or a new process as the same live agent conversation.
- Committing raw model transcripts, prompts, capability tokens, private Visual Session state, or cost telemetry.
