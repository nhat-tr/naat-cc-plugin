---
name: brainstorming
description: Turn a vague idea into an approved, evidence-grounded design before implementation. Use for feature design, requirement exploration, specification, architectural choices, requests such as "I have an idea" or "before we build", and explicitly requested live visual interviews with selectable, annotatable visual documents including UI screen prototypes (typed mockup elements). Any visual, mockup, or UI-prototype need during brainstorming is served by this skill's own visual companion — never by artifact-design or frontend-design. Produces a canonical Work specification plus generated `.pair/spec.md` mirror for pair-v3 work, or a generic design doc otherwise.
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

- **Work ID:** `<work-id>`

## Purpose
## Rejection Criteria
## Contrasts
## Constraints
## Decisions
## Engineering Quality Contract
- **Always-on obligations:** <intent fit, maintainable scope, traceable verification, independent review, repository security baseline>
- **Fact-activated obligations:** <observed change facts, required response/evidence, owner, exclusion authority>
## Acceptance Criteria
- [ ] AC-1: <observable outcome>
## Verification
- AC-1: <test, command, endpoint, or UI action proving the outcome>
## Out of Scope
```

Every acceptance criterion must have a stable ID and a matching verification entry. Do not leave TODO/TBD placeholders.
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

Default to terminal dialogue. When the user explicitly requests a **live visual interview**, use the visual companion for selectable UI prototypes, architecture/data-flow canvases, option matrices, or other concepts whose spatial presentation improves the decision.

Treat any of these as that explicit request: the word `visually` or `visual` in the brainstorming invocation (for example `/brainstorming visually <target>`), "show me a visual", or "I want to see it". Route directly to this companion — do not load artifact or design skills for it, and do not search the filesystem: `visual-companion.md` lives beside this SKILL.md in the same skill directory.

Read `visual-companion.md` only when starting a visual interview. For new work, scaffold and edit the validated v2 `workspace.json`; the reusable Visual Shell owns HTML, layout, annotation, chat history, and stable Component rendering. Choose exactly one Workspace Kind from the user's decision: Product Concept Studio for comparable UI concepts, Architecture Canvas for topology and ownership, Research Evidence Board for sourced claims and unknowns, Business Reasoning Canvas for actors/outcomes/experiments, or Feature Review Workbench for approved intent against implementation evidence. Profiles and `screen.json` are v1 compatibility only. Visual polish must serve comparison and traceability, not compete with them.

Keep the server in the foreground. Browser feedback is one persisted batch; after sharing the visual URL, invoke one blocking `wait_for_feedback` MCP tool call with `{"timeoutMs":900000}` from this same conversation. It completes the active tool call with the oldest pending batch, and you respond in the same active agent turn. When that MCP tool is unavailable, use one `visual-session.cjs wait --timeout-ms 900000` as recovery. Use zero agent polling: never repeat drain/status on a timer, and never spawn or resume another agent and call it the same session.

Without an explicit visual request, offer the companion inline only when the first concrete visual decision appears. Do not spend a separate turn on speculative opt-in.
