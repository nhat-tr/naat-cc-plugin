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

## Communication & Delegation

- Keep responses focused, brief, and concise. Explain only what changes decisions or helps verify the result; do not impose a hard word limit.
- Delegate only for sizeable, genuinely independent work with a clear boundary. Keep small searches, edits, and commands inline when their delegation brief would cost as much as the work.
- Use the lowest model tier that reliably fits delegated work, cap the number of agents, and do not use subagents to verify or double-check your own work.

## Global Language Rules

- For C#/.NET tasks, load `__PLUGIN_DIR__/skills/csharp-dotnet/SKILL.md`.
- For TypeScript/React tasks, load `__PLUGIN_DIR__/skills/typescript/SKILL.md`.
- For React or Next.js details, consult `__PLUGIN_DIR__/skills/typescript/references/react-next.md`.
- NUnit test method names must follow behavior-sentence naming: `Capability_verb_fact`, with a trailing `when_<condition>` only for non-default paths.
