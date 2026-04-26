## Tools & Environment

- Use the repository's existing container workflow. Do not switch between `docker` and `podman` unless the user asks.
- Codex-compatible skills are installed under `~/.codex/skills/` and `~/.agents/skills/`.

## Global Language Rules

- For C#/.NET tasks, load `__PLUGIN_DIR__/skills/csharp-dotnet/SKILL.md`.
- For TypeScript/React tasks, load `__PLUGIN_DIR__/skills/typescript/SKILL.md`.
- For React or Next.js details, consult `__PLUGIN_DIR__/skills/typescript/references/react-next.md`.
- NUnit test method names must follow `[Action]_When[Scenario]_Then[Expectation]`.
