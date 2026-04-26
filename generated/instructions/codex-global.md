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

## Dependency Check Before Building

- For new capabilities, inspect the repo's existing dependencies first.
- State what the framework already provides and what still needs to be built.
- Skip this only for bug fixes, pure refactors, or changes that do not add capability.

## Evidence Discipline

- Do not claim shapes, fields, or behavior you did not observe in code or runtime evidence.
- If correctness depends on an unverified assumption, verify it first.
- When user evidence contradicts the plan, update the plan immediately.

## Code Changes

- Optimize for readability, then maintainability, then correctness patterns, then performance.
- Make minimal focused changes. Do not refactor unrelated code without a reason.
- Preserve repo conventions.

## Secrets

- Never decode, print, or reveal secret values.
- Only inspect secret metadata or key names when necessary.

## Tools & Environment

- Use the repository's existing container workflow. Do not switch between `docker` and `podman` unless the user asks.
- Codex-compatible skills are installed under `~/.codex/skills/` and `~/.agents/skills/`.


## Language Routing

- For C#/.NET tasks, load `__PLUGIN_DIR__/skills/csharp-dotnet/SKILL.md`.
- For TypeScript/React tasks, load `__PLUGIN_DIR__/skills/typescript/SKILL.md`.
- For React or Next.js details, consult `__PLUGIN_DIR__/skills/typescript/references/react-next.md`.
- NUnit test method names must follow `[Action]_When[Scenario]_Then[Expectation]`.
