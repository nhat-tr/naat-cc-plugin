---
name: brainstorming
description: Turn a vague idea into an approved, evidence-grounded design before implementation. Use for feature design, requirement exploration, specification, architectural choices, requests such as "I have an idea" or "before we build", and explicitly requested live visual interviews with selectable, annotatable visual documents including UI screen prototypes (typed mockup elements) and UML diagrams (component, state machine, activity, sequence). Any visual, mockup, UML, or UI-prototype need during brainstorming is served by this skill's own visual companion — never by artifact-design or frontend-design. Produces a canonical Work specification plus generated `.pair/spec.md` mirror for pair-v3 work, or a generic design doc otherwise.
---

# Brainstorm Ideas Into an Approved Design

Protect intent without turning ordinary developer work into a long approval ceremony.

<HARD-GATE>
Do not write code, scaffold, install dependencies, or invoke implementation until the design is approved. Read-only repository and dependency reconnaissance is allowed and required when it can answer a design question.

When the user explicitly requests a live visual interview, the reusable Visual Shell and disposable Visual Documents under `$CLAUDE_SCRATCH_DIR` are allowed before approval. They are discussion instruments, not implementation, and must not introduce project dependencies.

Every visual during brainstorming routes through this skill's Visual Companion. New work uses a purpose-specific v2 `workspace.json`; `screen.json` and its `mockup` grammar are v1 compatibility only. Never invoke artifact-design, frontend-design, or dataviz for a brainstorming visual, and never hand-build HTML/React for one.
</HARD-GATE>

## Workflow

1. Inspect relevant repository context, instructions, dependencies, callers, tests, and recent decisions.
2. Ask only the discovery questions needed to draft a trustworthy Core Anchor.
3. Confirm the Core Anchor once.
4. Resolve remaining decisions in dependency order.
5. Compare only viable approaches, beginning with the framework-native baseline.
6. Present one integrated design and obtain approval.
7. Write and self-review the specification.
8. Reconfirm only semantic changes, then hand pair work to `pair-promote`.

## Core Anchor

Keep three fields stable throughout the discussion and copy them verbatim to the specification.

### Purpose

Write 2–3 sentences in the user's domain language without solution language: current state, desired state, and why it matters.

### Rejection Criteria

Record 0–3 conditions that make the result wrong even if tests pass. Explicitly accepting "none beyond the acceptance criteria" is valid for small, stable work.

Do not invent user preferences. You may propose a repository- or framework-derived criterion as `[evidence-derived]` with its source and let the user veto it.

### Contrasts

Record 0–3 plausible sibling interpretations in the form "not X, because Y." Use these to prevent a familiar but incorrect solution from replacing the requested one.

### Vocabulary

If `UBIQUITOUS_LANGUAGE.md` exists, use its canonical terms. Surface a new distinction rather than silently replacing a canonical term.

### Confirmation and Re-anchoring

Emit all three fields together. Ask the user to confirm or correct the anchor. On a material correction, show the delta and reconfirm. Do not require another confirmation when wording changes but meaning does not.

For discussions longer than roughly five Q&A turns, emit a short pulse: Purpose, emerging direction, anchor tension, and the next unresolved upstream decision.

## Agent Conversation Checkpoint

At activation, before opening the Visual Companion or letting reconnaissance materially grow the conversation, register the Agent Conversation for the Freshness Gate. This is the mandatory first action: run `pair-loop --register-brainstorming --runtime auto`. It needs no stdin, registers the native Codex `CODEX_THREAD_ID` or Claude `CLAUDE_CODE_SESSION_ID` Agent Conversation, and seeds a bounded bootstrap checkpoint so that a conversation which later goes cold is still intercepted and sealed — even before any semantic checkpoint exists. The installed hooks also auto-register this Agent Conversation the first time the Visual Companion runs, so protection does not depend on remembering the command. Registration is idempotent and never clobbers an existing checkpoint.

Enrich that checkpoint after every material research or decision boundary and before asking the next question: invoke `pair-loop --brainstorm-checkpoint --runtime auto` with one JSON checkpoint object on stdin. Include the confirmed Core Anchor, bounded finding statements with their evidence references and digests, confirmed choices, rejected alternatives, current direction, unresolved decisions, next action, and artifact digests. Never persist a prompt, transcript, private reasoning, compact summary, environment map, credential, capability token, or secret-like value. Pass only that semantic JSON object on stdin; never pass the submitted user prompt or a transcript to the command.

The Freshness Gate blocks a Cold Agent Conversation before model processing. Continue through its exact Agent Conversation Handover in a plain fresh provider-affine conversation: `pair-loop --fresh-from <handover-id> --runtime auto`, then `pair-loop --adopt-handover <handover-id> --runtime codex|claude`. Do not resume or fork the old conversation. The only old-conversation recovery is `pair-loop --allow-cold-resume <handover-id> --once --confirm-cost-risk`; its next Stop boundary refreshes and seals the checkpoint before retiring the source, after which launch and adopt that exact refreshed handover. Direct adoption also retires the source and continues in the adopter.

## Ask Efficient Questions

- Never ask for information that repository evidence can answer.
- Ask dependent questions one at a time because an earlier answer changes the later branch.
- Batch up to three independent questions when the user can answer them in one reply.
- Provide a recommended default and its evidence when a choice is low risk and reversible.
- If a decision remains load-bearing and ambiguous, ask; do not silently pick one during self-review.

## Bound Repository Reconnaissance

- Search symbols first, then read exact ranges. Do not inject whole source files, generated metadata, package XML, or broad multi-file dumps into the main conversation.
- Before the Core Anchor, use at most one main-model reconnaissance batch. Each reconnaissance cell must request at most 2,000 output tokens, and combined reconnaissance output must stay at or below 12 KB. Narrow the query instead of raising either cap. Defer evidence that matters only to an unchosen branch.
- Group independent read-only checks before reasoning so each small result does not wake the expensive coordinator separately.
- Do not reread a skill reference or repository range already observed in the same logical turn.
- For web research, batch up to three independent searches in one call with `response_length: "short"`, then open only exact load-bearing primary sources. Never request `response_length: "long"` in the coordinator context.
- For small work, inspect directly; a model handoff costs more than it saves.
- For unfamiliar frameworks, more than roughly six relevant files, or evidence likely to exceed the main-context budget, read `evidence-scout.md` and run one bounded scout. Do not perform the same broad reconnaissance before and after scouting.
- Generic `Agent/Explore` delegation is forbidden for bounded reconnaissance. Use the configured lower-tier evidence scout so model, effort, input, and output budgets remain enforced.

The scout extracts evidence only. The coordinator owns the Core Anchor, verifies every load-bearing citation, resolves framework capability, compares approaches, and writes the design. Never delegate architecture or treat a scout observation as verified merely because it is structured.

Use either direct reconnaissance or one Evidence Scout, never both over the same scope. A scout packet replaces broad coordinator reads; verify only the exact load-bearing ranges it cites.

## Explore Approaches Without Inventing Architecture

When dependencies or frameworks are involved, start with the **framework-native baseline**: the smallest design that composes existing repository and dependency capabilities directly.

Offer 2–3 approaches only when at least two are genuinely viable and differ in boundary, ownership, or execution model. One well-supported approach plus explicitly rejected alternatives is sufficient when evidence removes the other options.

For each viable option:

- Score it from 1–10 and explain the tradeoff.
- State how it serves Purpose and respects every Rejection Criterion and Contrast.
- Separate observed repository/framework capability from assumptions.
- Mark an unverified load-bearing capability as an open question, not a custom module.

## Design for Readability and Leverage

Prefer direct composition and **deep modules**: small interfaces that hide meaningful application-owned behavior. Apply the deletion test before proposing a new module—if deleting it and calling the dependency directly removes complexity without spreading it across callers, do not add it.

Treat a seam as real only when it has at least two adapters or crosses a true external ownership boundary. Do not introduce pass-through wrappers, speculative factories, registries, ports, or interfaces for hypothetical reuse. File size alone is not a reason to extract.

Organize the design around observable behavior and data flow, not layers. Cover only affected concerns: architecture, UI/API contracts, state, error handling, security, compatibility, observability, and testing.

Consult applicable language or framework skills read-only during design. This does not violate the implementation hard gate.

## Approval Policy

- Low/medium-risk work: present the integrated design in one message and request one approval.
- High/critical-risk or disputed work: request approval by load-bearing section.
- Reconfirm before writing only when the design changed the Core Anchor.
- After writing, show any semantic delta from the approved design. If there is no delta, do not add a redundant approval gate unless the work is high/critical risk.

## Specification Contract

Use this structure, scaled to the work. Write for a human reviewer first: start every section with the decision or outcome, keep each bullet to one claim, and use short labeled sub-bullets for proof, constraints, and consequences. Never encode a section as one metadata-dense paragraph. A spec remains the canonical semantic record, so preserve stable IDs and exact verification commands.

```markdown
# Spec: <title>

- **Work ID:** `<work-id>`

## Purpose
<2–3 short paragraphs: current state, desired state, and why it matters>
## Rejection Criteria
<one independently scannable bullet per condition>
## Contrasts
## Constraints
## Decisions
### D-1: <short decision name>
- **Decision:** <chosen approach>
- **Why:** <decisive evidence or tradeoff>
- **Consequences:** <important resulting constraint>
## Engineering Quality Contract
- **Always-on obligations:** <intent fit, maintainable scope, traceable verification, independent review, repository security baseline>
- **Fact-activated obligations:** <observed change facts, required response/evidence, owner, exclusion authority>
## Acceptance Criteria
- [ ] AC-1: <observable outcome>
## Verification
### AC-1
- **Proof:** `<test, command, endpoint, or UI action proving the outcome>`
## Out of Scope
```

Every acceptance criterion must have a stable ID and a matching verification entry. Keep the acceptance criterion itself outcome-only; put the proof under its matching `### AC-<n>` verification heading. Do not leave TODO/TBD placeholders.
For pair-v3 Work, replace the Work ID and both Engineering Quality Contract entries with approved concrete content before publishing. Generic designs may omit the Work-only metadata when it is not applicable.

### Destination

- Pair-v3 work explicitly requested by the user or already active: assign a stable `work-YYYYMMDD-<slug>` Work ID and put that exact Work ID in the approved specification.
- Write the approved candidate under `$CLAUDE_SCRATCH_DIR/<repo>/brainstorming/`, then run `work-lineage.cjs create --repository-root "$PWD" --work-id <work-id> --spec-file <approved-candidate>` from the repository root. The runtime installer puts this portable helper on `PATH`; in an uninstalled toolkit checkout, invoke the same script from `skills/brainstorming/scripts/work-lineage.cjs`.
- The command publishes `docs/work/<work-id>/spec.md` and `work.json` as the Git-trackable canonical Work root, then writes `.pair/spec.md` as the generated active mirror with `Canonical:` and `Canonical SHA-256:` headers.
- Commit only the canonical Work artifacts when a later workflow requests a commit. Do not commit `.pair/`, `.artifacts/`, the scratch candidate, or other raw workflow state.
- Generic work: write `docs/specs/YYYY-MM-DD-<topic>-design.md` or the user's requested location. Leave it uncommitted unless the user asks for a commit.

Never overwrite an existing Work root. A later semantic choice belongs in an immutable Decision Record or a new explicitly approved Work. Do not infer pair mode merely because a stale `.pair/` directory exists. Do not design or approve implementation streams here; `pair-promote` owns code-grounded decomposition.

If terminology needs updating, propose the glossary change. Invoke `ubiquitous-language` only with the user's approval or when their request already includes glossary maintenance.

## Self-Review

1. Trace every requirement to Purpose.
2. Verify nothing violates a Rejection Criterion or implements a Contrast.
3. Verify every AC has observable proof.
4. Remove unsupported architecture, placeholders, contradictions, and scope not requested.
5. Reopen substantive ambiguity with the user; fix editorial ambiguity inline.
6. Confirm the design starts from existing capabilities and justifies every custom module.

## Transition

For pair-v3 work, invoke `pair-promote` only after the canonical Work root and generated active mirror exist. Do not implement directly from the specification.

## Visual Companion

Default to terminal dialogue. When the user explicitly requests a **live visual interview**, use the visual companion for selectable UI prototypes, architecture/data-flow canvases, UML diagrams (component, state machine, activity, or sequence), option matrices, or other concepts whose spatial presentation improves the decision.

Treat any of these as that explicit request: the word `visually` or `visual` in the brainstorming invocation (for example `/brainstorming visually <target>`), "show me a visual", or "I want to see it". Route directly to this companion — do not load artifact or design skills for it, and do not search the filesystem: `visual-companion.md` lives beside this SKILL.md in the same skill directory.

Choose exactly one Workspace Kind from the user's decision: Product Concept Studio for comparable UI concepts, Architecture Canvas for topology and ownership, Research Evidence Board for sourced claims and unknowns, Business Reasoning Canvas for actors/outcomes/experiments, Feature Review Workbench for approved intent against implementation evidence, or UML Diagram for a standard UML view (component, state machine, activity, or sequence). Architecture Canvas and UML Diagram share a Draft fast-path (a compact Draft compiled and served directly with `present --draft`): read only `references/architecture-visual.md` or `references/uml-visual.md` respectively on the normal path, and do not load `visual-companion.md`, schemas, or generated assets unless recovery is required. For the other Workspace Kinds, read only the relevant range of `visual-companion.md`. The reusable Visual Shell owns HTML, layout, annotation, chat history, and stable Component rendering.

Run routine Visual Session commands inside the active sandbox. Do not set `require_escalated` proactively for scratch reads or writes, `scaffold`, `present`, `migrate`, `publish`, `wait`, `drain`, or `reply`; first invoke the command normally and let the configured writable roots and network policy apply. If a command is genuinely denied and interactive approvals are enabled, request one scoped approval for the `node <skill-dir>/scripts/visual-session.cjs` executable prefix. Never request approval separately for `scaffold`, `migrate`, `publish`, `wait`, `drain`, and `reply` in the same Visual Session.

The normal visual path has at most five model-visible command boundaries: one reconnaissance batch, one `scaffold` or an Architecture/UML `present --draft`, one `publish` when the scaffold path requires it, one background feedback wait per review round, and one `reply` or revision. Do not call `visual-session.cjs --help` on the normal path, do not reread a generated scaffold before editing known fields, and do not run status/drain probes between these steps. Do not poll the retained server execution handle; keep its session identifier and leave it running until shutdown.

Publish only for a material Revision that changes the Visual Document. Never Publish an unchanged Revision, and do not use Publish as a validation probe; use the local normalizer or focused test instead.

Feedback delivery is automatic. Browser feedback is one persisted batch. After sharing `connection_url` once, run `visual-session.cjs wait --timeout-ms 900000` **as a background task** and end your turn — when the user submits a batch the background wait exits and you are re-invoked automatically with it, so there is no frozen foreground wait and no manual "ping". Then revise, `publish` (reuses the live session in place), `reply`, and launch another background wait. Use `drain` only for an explicit synchronous "check now". Zero polling: never repeat drain/status on a timer, and never spawn or resume a second agent to watch the session.

Without an explicit visual request, offer the companion inline only when the first concrete visual decision appears. Do not spend a separate turn on speculative opt-in.
