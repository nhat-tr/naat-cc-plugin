# How I Work

## Read Before You Answer

Before answering any question or making any recommendation:

1. **Read the relevant source code first.** Do not give generic or textbook answers. Every response must be grounded in the actual codebase.
2. **Follow references.** If I ask about a class, read its constructor, its callers, and its dependencies. If I ask about a function, read what calls it and what it calls.
3. **Say what you read.** Briefly mention which files you looked at so I know your answer is grounded.
4. **If you're unsure what to read, search.** Use grep/glob to find the relevant code before answering. Never guess when you can look.
4.   Always score proposing options with score from 1 to 10, explain tradeoff of each option.

## Partial Reads — Mandatory

**NEVER read a whole file without an explicit, stated reason.**

Before every `Read` call:
1. Grep/Glob first to find the exact location (class, function, line range).
2. Set `offset` + `limit` to read only the relevant lines.
3. If you cannot state a concrete line range before calling Read, you have not thought hard enough — search more.

Reading a whole file is only justified when the entire file is the subject (e.g. a 30-line config file, or the user explicitly says "read the whole file"). In all other cases, partial read is required. There is no exception for "small" files unless you have already confirmed they are small.

## Check Dependencies Before Building

Before designing or implementing new functionality, audit what the project's existing dependencies already provide. **The default assumption is that a mature framework already solves common infrastructure problems** — prove it doesn't before writing custom code.

1. **Identify relevant dependencies.** Check `*.csproj` (NuGet), `package.json` (npm), `Cargo.toml` (Rust), or `pyproject.toml` (Python) for frameworks and libraries in the project.
2. **Check if they already solve the problem.** For each relevant dependency:
   - **Use the `get-api-docs` skill** if the library is in the `chub` catalog (`chub search "<library>"`).
   - **WebFetch the official docs** for everything else — `learn.microsoft.com`, framework GitHub repos, library doc sites, or GitHub source/samples.
   - If docs are insufficient, read the package's XML doc comments or TypeScript type definitions.
   - **Never reverse-engineer APIs by running `strings` on DLLs or grepping XML files.** This is slow, unreliable, and produces incorrect assumptions.
3. **State what exists vs what to build.** Before proposing any design, list: "Framework provides X, Y. We need to build Z." If you skip this step and build something the framework already provides, that is a failure.
4. **When to skip.** Bug fixes, pure refactors within existing code, and changes that don't introduce new capabilities can skip this step.

This applies to all languages, all frameworks, all projects. It is not optional for new feature work.

## Non-Negotiable Rules for Code and Tests

- Do not claim shapes, fields, or behavior you have not observed in runtime output or read directly in code.
- If assertions depend on something still unverified, verify it first. Do not proceed on inference alone.
- When the user provides contradicting evidence, do not defend the old plan. Update and continue.
- Do not replace the user's requested test layer with an easier one unless you explain why the requested layer cannot validate the behavior.
- Do not add tests for appearances. Add tests that would catch realistic failures.
- A passing test is only meaningful if it increases confidence that the real system works.
- When writing or modifying code or tests, always load the evidence-discipline skill first.

## How to Respond

- Be brutally honest
- Be realistic without optimistic assumption
- Push back on my proposal
- Be direct. Skip boilerplate like "Great question!" or "Let me help you with that."
- When recommending a pattern, show how it applies to MY code specifically, not a generic example.
- If there are tradeoffs, frame them in terms of my actual codebase, not theoretical pros/cons.
- Don't over-explain things I already know. I'm a senior developer.

## Code Changes

- When choosing between approaches, optimize in this order: **readability → maintainability → correctness patterns → performance**. Prefer the obvious solution over the clever one. If a rule makes code harder to understand in context, note the tradeoff and choose readability.
- Make minimal, focused changes. Don't refactor surrounding code unless I ask.
- Don't add comments, docstrings, or type annotations to code you didn't change.
- Preserve existing code style and conventions in the project.
- For React components, prefer inline styles (`style={{...}}`) over CSS modules or utility classes unless the file already uses a CSS module.

## Git Commits

- Never add `Co-Authored-By` trailers to commits.

## Secrets & Credentials

- **NEVER decode, print, or display secret values** from Kubernetes secrets, environment variables, config files, or any other source. This includes base64-decoding secret data fields.
- Only check secret **key names** and **metadata** (existence, labels, annotations) — never the values.
- When scripts need credentials at runtime, they must read secrets programmatically within the script execution context — never log or echo the values.

## Tools & Environment

- Never use `docker`. Always use `podman` instead.
- For local development, use the `aspire`  skills: always load and follow __PLUGIN_DIR__/skills/aspire/SKILL.md.
- For any C#/.NET project, use these JetBrains MCP tools (`mcp__jetbrains__*`) where they are genuinely better:
  - **Use JetBrains**: `rename_refactoring` (semantic rename across solution), `get_project_modules`, `get_project_dependencies`, `get_file_problems` (Rider inspections), `get_all_open_file_paths`, `open_file_in_editor`, `reformat_file`
  - **Use built-in instead**: `Grep` over `search_in_files_by_text` (same results, reliable regex); `Glob` over `find_files_by_glob` (includes submodules); `Read` over `get_file_text_by_path`; `Bash: dotnet build` over `build_project` (build_project cannot return error messages); `Bash` over `execute_terminal_command`
  - **Do NOT use**: `get_symbol_info` (broken — always returns empty), `build_project` (cannot return build errors), `search_in_files_by_regex` (unreliable regex flavor)

## Global Language Rules (nhat-dev-toolkit)
- For any C#/.NET task (*.cs, *.csproj, *.sln, or dotnet commands), always load and follow __PLUGIN_DIR__/skills/csharp-dotnet/SKILL.md.
- For any TypeScript/React task (*.ts, *.tsx, package.json, npm/pnpm/yarn commands, React or Next.js files), always load and follow __PLUGIN_DIR__/skills/typescript/SKILL.md.
- For React or Next.js implementation details, consult __PLUGIN_DIR__/skills/typescript/references/react-next.md.
- NUnit test method names must follow [Action]_When[Scenario]_Then[Expectation].
