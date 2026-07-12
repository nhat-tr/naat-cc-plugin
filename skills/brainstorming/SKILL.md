---
name: brainstorming
description: Turn a vague idea into an approved, evidence-grounded design before implementation. Use for feature design, requirement exploration, specification, architectural choices, requests such as "I have an idea" or "before we build", and explicitly requested live visual interviews with selectable, annotatable visual documents including UI screen prototypes (typed mockup elements). Any visual, mockup, or UI-prototype need during brainstorming is served by this skill's own visual companion — never by artifact-design or frontend-design. Produces `.pair/spec.md` for pair-v3 work or a generic design doc otherwise.
---

# Brainstorm Ideas Into an Approved Design

Protect intent without turning ordinary developer work into a long approval ceremony.

<HARD-GATE>
Do not write code, scaffold, install dependencies, or invoke implementation until the design is approved. Read-only repository and dependency reconnaissance is allowed and required when it can answer a design question.

When the user explicitly requests a live visual interview, the reusable visual shell and disposable `screen.json` documents under `$CLAUDE_SCRATCH_DIR` are allowed before approval. They are discussion instruments, not implementation, and must not introduce project dependencies.

Every visual during brainstorming — including UI screen proposals — goes through `visual-companion.md` and its validated `screen.json` grammar (`mockup` sections with typed UI elements are the prototype channel). Never invoke artifact-design, frontend-design, or dataviz for a brainstorming visual, and never hand-build HTML/React for one.
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

## Ask Efficient Questions

- Never ask for information that repository evidence can answer.
- Ask dependent questions one at a time because an earlier answer changes the later branch.
- Batch up to three independent questions when the user can answer them in one reply.
- Provide a recommended default and its evidence when a choice is low risk and reversible.
- If a decision remains load-bearing and ambiguous, ask; do not silently pick one during self-review.

## Bound Repository Reconnaissance

- Search symbols first, then read exact ranges. Do not inject whole source files, generated metadata, package XML, or broad multi-file dumps into the main conversation.
- Before the Core Anchor, use at most one main-model reconnaissance batch and keep returned text near 12 KB or less. Defer evidence that matters only to an unchosen branch.
- Group independent read-only checks before reasoning so each small result does not wake the expensive coordinator separately.
- Do not reread a skill reference or repository range already observed in the same logical turn.
- For small work, inspect directly; a model handoff costs more than it saves.
- For unfamiliar frameworks, more than roughly six relevant files, or evidence likely to exceed the main-context budget, read `evidence-scout.md` and run one bounded scout. Do not perform the same broad reconnaissance before and after scouting.

The scout extracts evidence only. The coordinator owns the Core Anchor, verifies every load-bearing citation, resolves framework capability, compares approaches, and writes the design. Never delegate architecture or treat a scout observation as verified merely because it is structured.

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

Use this structure, scaled to the work:

```markdown
# Spec: <title>

## Purpose
## Rejection Criteria
## Contrasts
## Constraints
## Decisions
## Acceptance Criteria
- [ ] AC-1: <observable outcome>
## Verification
- AC-1: <test, command, endpoint, or UI action proving the outcome>
## Out of Scope
```

Every acceptance criterion must have a stable ID and a matching verification entry. Do not leave TODO/TBD placeholders.

### Destination

- Pair-v3 work explicitly requested by the user or already active: write `.pair/spec.md` and do not commit workflow state.
- Generic work: write `docs/specs/YYYY-MM-DD-<topic>-design.md` or the user's requested location. Leave it uncommitted unless the user asks for a commit.

Do not infer pair mode merely because a stale `.pair/` directory exists. Do not design or approve implementation streams here; `pair-promote` owns code-grounded decomposition.

If terminology needs updating, propose the glossary change. Invoke `ubiquitous-language` only with the user's approval or when their request already includes glossary maintenance.

## Self-Review

1. Trace every requirement to Purpose.
2. Verify nothing violates a Rejection Criterion or implements a Contrast.
3. Verify every AC has observable proof.
4. Remove unsupported architecture, placeholders, contradictions, and scope not requested.
5. Reopen substantive ambiguity with the user; fix editorial ambiguity inline.
6. Confirm the design starts from existing capabilities and justifies every custom module.

## Transition

For pair-v3 work, invoke `pair-promote` after the specification is approved. Do not implement directly from the specification.

## Visual Companion

Default to terminal dialogue. When the user explicitly requests a **live visual interview**, use the visual companion for selectable UI prototypes, architecture/data-flow canvases, option matrices, or other concepts whose spatial presentation improves the decision.

Treat any of these as that explicit request: the word `visually` or `visual` in the brainstorming invocation (for example `/brainstorming visually <target>`), "show me a visual", or "I want to see it". Route directly to this companion — do not load artifact or design skills for it, and do not search the filesystem: `visual-companion.md` lives beside this SKILL.md in the same skill directory.

Read `visual-companion.md` only when starting a visual interview. Scaffold and edit only the small validated `screen.json`; the reusable shell owns HTML, layout, annotation, chat history, and stable `data-brainstorm-id` rendering. Choose the profile from purpose and audience: dense `technical` views for developers, target-user-oriented `product` views for app UI, and narrative `business` views for propositions and journeys. Visual polish must serve the decision, not compete with it.

Keep the server in the foreground. Browser feedback is one persisted batch; after sharing the visual URL, run one blocking `visual-session.cjs wait --timeout-ms 900000` from this same conversation. The browser persists feedback, the wait command returns the oldest pending batch once, and you respond in the same active agent turn. Use zero agent polling: never repeat drain/status on a timer, and never spawn or resume another agent and call it the same session.

Without an explicit visual request, offer the companion inline only when the first concrete visual decision appears. Do not spend a separate turn on speculative opt-in.
