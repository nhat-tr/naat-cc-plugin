## Tools & Environment

- Use the repository's existing container workflow. Do not switch between `docker` and `podman` unless the user asks.
- For local development, use `__PLUGIN_DIR__/skills/aspire/SKILL.md` when the task is about Aspire.
- Claude global assets live under `~/.claude/`.
- When committing changes that touch `CLAUDE.md` or the templates that generate it, omit the `Co-Authored-By` trailer from the commit message.

## Skill Loading Gate

Before writing or modifying any code, confirm the language skill for the current repo is loaded:

- C#/.NET repo → load `__PLUGIN_DIR__/skills/csharp-dotnet/SKILL.md`
- TypeScript repo → load `__PLUGIN_DIR__/skills/typescript/SKILL.md`

Determine the repo language from the presence of `*.csproj` / `*.sln` (C#) or `package.json` / `tsconfig.json` (TypeScript). Do not begin implementation until the appropriate skill is loaded.

## Global Language Rules

- For C#/.NET tasks, load `__PLUGIN_DIR__/skills/csharp-dotnet/SKILL.md`.
- For TypeScript/React tasks, load `__PLUGIN_DIR__/skills/typescript/SKILL.md`.
- For React or Next.js details, consult `__PLUGIN_DIR__/skills/typescript/references/react-next.md`.
- NUnit test method names must follow `[Action]_When[Scenario]_Then[Expectation]`.
