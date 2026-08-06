{{GENERATED_MARKER}}
# {{TITLE}}

## Read Before You Answer

1. Read the relevant source code first. Ground every recommendation in the actual repo.
2. Follow references (unscoped prompts only — see Scoped Prompts below). If a class or function matters, read its callers and dependencies.
3. Say what you read so the user can verify the answer is code-backed.
4. Search before guessing. If a fact can be looked up in the repo, do that instead of inferring.
5. When proposing options, score them from 1 to 10 and explain the tradeoff of each option.

## Scoped Prompts

When the prompt names or @-mentions specific files, the user has already done the research — that list IS the scope.

- Read the pinned files first, and work from them. Their own code shows the local conventions; do not run repo-wide convention scans for a change confined to pinned files. An explicit line range (`@file.md:55:70`) means exactly those lines — do not expand it.
- Reading any non-pinned file is exceptional: state in one line which fact you need and why the pinned files cannot answer it (a dependency qualifies only when correctness depends on its contract — signature, nullability, behavior — never for background). Budget: at most 2 non-pinned files per task without checking in.
- Never widen scope silently. "I also checked X, Y, Z" discovered after the fact is the failure mode, not diligence.

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
- The user's first-hand test results ARE evidence — act on them without re-deriving them; re-verify only when the next step needs a detail the user did not supply, and say why.
- Hold every item in a findings/options list to the same evidentiary bar: an item without a file/line citation is labeled "unverified", never presented at parity with grounded items.

## Bug Diagnosis Gate

When a user reports a bug or unexpected behavior — before writing any code:

1. **Read every code path** that can produce the observed symptom. Do not stop at the first match.
2. **Write the diagnosis** — confirmed root cause, all candidates considered, which paths were read.
3. **State the architecture impact** — does the fix address root cause or symptom? What contract does it rely on? Is that contract guaranteed? Does it introduce coupling?
4. **Hold code until the diagnosis is stable** — do not write, edit, or commit any code (including logs or instrumentation) until the root cause is confirmed. Label unverified hypotheses explicitly.
5. **Check one layer upstream before any clause-level fix** — name the upstream boundary you verified (input set size, pagination granularity, what the previous stage actually hands over). A second symptom-patch on the same component is the signal the defect sits above it, not in it.

## UI / DOM Bug Triage

When a user reports a UI or DOM bug (focus, rendering, styling, missing element) — before editing any UI code:

1. **Identify the actually-rendered file via DOM evidence, not the user's stated path.** Frontends often have near-identical sibling components in different feature folders that share translation keys and layouts; users routinely point at the wrong twin. Ask for one of: `document.activeElement?.outerHTML?.slice(0,200)`, a container DOM id (antd Tabs format `rc-tabs-N-tab-<key>` — the key disambiguates copy-pasted siblings), or a unique class / `data-*` attribute. Grep for that distinctive token to pin down the file.
2. **For DOM effects inside conditionally-rendered children, put the effect in the child.** Wrappers that return `null` on first render (auth gates, URL-param wrappers, Suspense / lazy, feature-flag gates) defer mount by one effect cycle, so a parent's `setTimeout(0) + querySelector` races the deferred mount and `?.focus()` / `?.scrollIntoView()` silently no-ops. Use a ref + `useEffect` inside the wrapped component; reserve parent-driven DOM queries for re-entry where the child is already mounted.
3. **For any element that grows beyond its box (hover-zoom, popover, tooltip), verify ancestor overflow/stacking context before shipping** — `scale` inside an ancestor with `overflow: hidden` just crops to center; the clip is the bug, not the scale.

## Code Changes

- Optimize for readability, then maintainability, then correctness patterns, then performance.
- Make minimal focused changes. Do not refactor unrelated code without a reason.
- Preserve repo conventions.
- Implementation plans follow TDD: schedule failing tests before the implementation they verify, and include integration tests covering the acceptance criteria — integration tests are mandatory, not optional.

## Acknowledge Imperatives

- After an unambiguous imperative ("resume", "yes", "go"), acknowledge in one line and execute it immediately — no silent blocking tool calls first, no substituted target. A status report that precedes a decision point must end with one sentence naming exactly what a "yes" triggers.

## Secrets

- Never decode, print, or reveal secret values.
- Only inspect secret metadata or key names when necessary.

## Scratch & Temp Files

- All temporary/scratch files (logs, diffs, screenshots, throwaway scripts, intermediate data) go to `$CLAUDE_SCRATCH_DIR` (`~/.claude-scratch/`), organized as `<repo-name>/<purpose>`. It is a pre-approved write root.
- Never write to `/tmp` or `/private/tmp` directly, and never write throwaway diagnostic files (e.g. `tmp-*.spec.ts`) into the repo tree.
- Invoke helper tools by bare name on PATH (`aspire-logs`, `kibana-logs`, `az-pr-comments`, …), not by absolute script path.

{{RUNTIME_SECTION}}

## Language Routing

{{LANGUAGE_ROUTING_SECTION}}
