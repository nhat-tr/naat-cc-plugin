## Copilot Runtime Notes

- Use the path-specific instruction files in `.github/instructions/` — they attach automatically by file glob.
- Use the compatible skills published in `.github/skills/` when they match the task.
- Copilot has no shell, subagent, or hook surface in this repo: apply these rules to code suggestions, reviews, and chat answers.

## Global Language Rules

- For C#/.NET tasks, follow `.github/skills/csharp-dotnet/SKILL.md`.
- For TypeScript/React tasks, follow `.github/skills/typescript/SKILL.md`.
- NUnit test method names must follow `[Action]_When[Scenario]_Then[Expectation]`.
