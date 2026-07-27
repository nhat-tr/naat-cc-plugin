## Tools & Environment

- Use the repository's existing container workflow. Do not switch between `docker` and `podman` unless the user asks.
- Prefer repo-relative paths when reading instructions from this checkout.

## Skill Read Reuse

- Once a `SKILL.md` has been read completely in the current agent conversation, reuse it across later user turns when the same skill is selected. Do not reread it merely because a new turn began.
- When freshness is uncertain, check the file's content digest instead of emitting the whole file again. Reread only when the user explicitly requests it, the digest changed, the prior read was incomplete or truncated, or compaction/handover no longer retains the complete instructions.

## Global Language Rules

- For C#/.NET tasks, load `skills/csharp-dotnet/SKILL.md`.
- For TypeScript/React tasks, load `skills/typescript/SKILL.md`.
- For React or Next.js details, consult `skills/typescript/references/react-next.md`.
- NUnit test method names must follow `[Action]_When[Scenario]_Then[Expectation]`.
