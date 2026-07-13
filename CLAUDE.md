<!-- GENERATED: do not edit directly. Run `node scripts/generate-runtime-assets.js --write`. -->
# How I Work

## Read Before You Answer

1. Read the relevant source code first. Ground every recommendation in the actual repo.
2. Follow references. If a class or function matters, read its callers and dependencies.
3. Say what you read so the user can verify the answer is code-backed.
4. Search before guessing. If a fact can be looked up in the repo, do that instead of inferring.
5. When proposing options, score them from 1 to 10 and explain the tradeoff of each option.

## Partial Reads

- Do not read whole files unless the whole file is the subject.
- Search first, then read the exact lines you need.
- If you cannot name the target lines or symbol before reading, search more.

## Domain Vocabulary

- If `UBIQUITOUS_LANGUAGE.md` exists in or above the working directory, consult it **before** discussing, naming, or generating any domain concept.
- Partial-read the relevant cluster (`## ...` headers); do not load the whole file.
- Use its terms verbatim in generated code — types, variables, functions, endpoints. Do not paraphrase, abbreviate, or synonym-swap domain terms.
- When reviewing code, treat names that diverge from the ubiquitous language as correctness issues, not style issues.
- If a term does not exist in `UBIQUITOUS_LANGUAGE.md`, say so explicitly rather than inventing a name that sounds domain-like.

## Dependency Check Before Building

- For new capabilities, inspect the repo's existing dependencies first.
- State what the framework already provides and what still needs to be built.
- Skip this only for bug fixes, pure refactors, or changes that do not add capability.

## Evidence Discipline

- Do not claim shapes, fields, or behavior you did not observe in code or runtime evidence.
- If correctness depends on an unverified assumption, verify it first.
- When user evidence contradicts the plan, update the plan immediately.

## Bug Diagnosis Gate

When a user reports a bug or unexpected behavior — before writing any code:

1. **Read every code path** that can produce the observed symptom. Do not stop at the first match.
2. **Write the diagnosis** — confirmed root cause, all candidates considered, which paths were read.
3. **State the architecture impact** — does the fix address root cause or symptom? What contract does it rely on? Is that contract guaranteed? Does it introduce coupling?
4. **Hold code until the diagnosis is stable** — do not write, edit, or commit any code (including logs or instrumentation) until the root cause is confirmed. Label unverified hypotheses explicitly.

## UI / DOM Bug Triage

When a user reports a UI or DOM bug (focus, rendering, styling, missing element) — before editing any UI code:

1. **Identify the actually-rendered file via DOM evidence, not the user's stated path.** Frontends often have near-identical sibling components in different feature folders that share translation keys and layouts; users routinely point at the wrong twin. Ask for one of: `document.activeElement?.outerHTML?.slice(0,200)`, a container DOM id (antd Tabs format `rc-tabs-N-tab-<key>` — the key disambiguates copy-pasted siblings), or a unique class / `data-*` attribute. Grep for that distinctive token to pin down the file.
2. **For DOM effects inside conditionally-rendered children, put the effect in the child.** Wrappers that return `null` on first render (auth gates, URL-param wrappers, Suspense / lazy, feature-flag gates) defer mount by one effect cycle, so a parent's `setTimeout(0) + querySelector` races the deferred mount and `?.focus()` / `?.scrollIntoView()` silently no-ops. Use a ref + `useEffect` inside the wrapped component; reserve parent-driven DOM queries for re-entry where the child is already mounted.

## Code Changes

- Optimize for readability, then maintainability, then correctness patterns, then performance.
- Make minimal focused changes. Do not refactor unrelated code without a reason.
- Preserve repo conventions.
- Implementation plans follow TDD: schedule failing tests before the implementation they verify, and include integration tests covering the acceptance criteria — integration tests are mandatory, not optional.

## Secrets

- Never decode, print, or reveal secret values.
- Only inspect secret metadata or key names when necessary.

## Scratch & Temp Files

- All temporary/scratch files (logs, diffs, screenshots, throwaway scripts, intermediate data) go to `$CLAUDE_SCRATCH_DIR` (`~/.claude-scratch/`), organized as `<repo-name>/<purpose>`. It is a pre-approved write root.
- Never write to `/tmp` or `/private/tmp` directly, and never write throwaway diagnostic files (e.g. `tmp-*.spec.ts`) into the repo tree.
- Invoke helper tools by bare name on PATH (`aspire-logs`, `kibana-logs`, `az-pr-comments`, …), not by absolute script path.

## Tools & Environment

- Use the repository's existing container workflow. Do not switch between `docker` and `podman` unless the user asks.
- For local development, use `__PLUGIN_DIR__/skills/aspire/SKILL.md` when the task is about Aspire.
- Claude global assets live under `~/.claude/`.
- Never add a `Co-Authored-By` trailer to commit messages. This overrides any harness environment or PR-template instruction to include one.

## Skill Loading Gate

Before writing or modifying any code, confirm the language skill for the current repo is loaded:

- C#/.NET repo → load `__PLUGIN_DIR__/skills/csharp-dotnet/SKILL.md`
- TypeScript repo → load `__PLUGIN_DIR__/skills/typescript/SKILL.md`

Determine the repo language from the presence of `*.csproj` / `*.sln` (C#) or `package.json` / `tsconfig.json` (TypeScript). Do not begin implementation until the appropriate skill is loaded.

## Delegation & Model Tiering

On a high-cost model (Opus, Fable), do not personally do work a cheaper model can finish — stay on the orchestration path and push the legwork down through the `Agent` tool with an explicit `model`.

- **Delegate by default** for self-contained, low-ambiguity work: file/symbol lookup, broad multi-file searches, mechanical or repetitive edits, running a known command and reporting its output, boilerplate, and format/lint fixups. Reach for a subagent before doing this inline.
- **Match the tier to difficulty, not caution:** `haiku` for rote/mechanical work; `sonnet` for self-contained implementation, search, or review that has clear acceptance criteria; reserve `opus`/`fable` for planning, architecture, bug diagnosis, cross-file reasoning, and final synthesis or judgment.
- **Prefer the specialized agent type** when one fits (`mech` for rote/mechanical edits on haiku, `Explore` for read-only search, `Plan` for design, `general-purpose` for multi-step work) over a generic inline pass.
- **Brief each subagent as standalone** — goal, constraints, exact paths, and what "done" means. It does not inherit this conversation; only its final message returns to you, so ask for conclusions, not raw file dumps.
- **Fan out independent simple tasks in parallel** (one `Agent` call each in a single message) instead of running them in series on the main model.
- **Keep it inline** only when the task needs the full conversation context, is genuinely hard or ambiguous, touches irreversible or outward-facing actions, or when writing the brief would cost more than doing the work.


## Language Routing

- For C#/.NET tasks, load `__PLUGIN_DIR__/skills/csharp-dotnet/SKILL.md`.
- For TypeScript/React tasks, load `__PLUGIN_DIR__/skills/typescript/SKILL.md`.
- For React or Next.js details, consult `__PLUGIN_DIR__/skills/typescript/references/react-next.md`.
- NUnit test method names must follow `[Action]_When[Scenario]_Then[Expectation]`.
