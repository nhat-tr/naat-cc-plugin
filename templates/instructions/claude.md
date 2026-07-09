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
- **Prefer the specialized agent type** when one fits (`Explore` for read-only search, `Plan` for design, `general-purpose` for multi-step work) over a generic inline pass.
- **Brief each subagent as standalone** — goal, constraints, exact paths, and what "done" means. It does not inherit this conversation; only its final message returns to you, so ask for conclusions, not raw file dumps.
- **Fan out independent simple tasks in parallel** (one `Agent` call each in a single message) instead of running them in series on the main model.
- **Keep it inline** only when the task needs the full conversation context, is genuinely hard or ambiguous, touches irreversible or outward-facing actions, or when writing the brief would cost more than doing the work.

## Global Language Rules

- For C#/.NET tasks, load `__PLUGIN_DIR__/skills/csharp-dotnet/SKILL.md`.
- For TypeScript/React tasks, load `__PLUGIN_DIR__/skills/typescript/SKILL.md`.
- For React or Next.js details, consult `__PLUGIN_DIR__/skills/typescript/references/react-next.md`.
- NUnit test method names must follow `[Action]_When[Scenario]_Then[Expectation]`.
