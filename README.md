# nhat-dev-toolkit

Claude Code plugin for senior developer workflow across C#/.NET 10, TypeScript, Rust, and Python.

## Install

```bash
git clone <repo-url> ~/.claude/plugins/nhat-dev-toolkit
cd ~/.claude/plugins/nhat-dev-toolkit
./install.sh
```

Uninstall:
```bash
./install.sh --uninstall
```

The install script symlinks agents and commands to `~/.claude/`, so edits to this repo are reflected immediately without re-installing.

## What's Included

### Agents

| Agent | Model | Command | Purpose |
|-------|-------|---------|---------|
| code-reviewer | sonnet | `/review` | Multi-language code review with .NET 10 / C# 14 depth |
| discovery | opus | `/discover` | Use case discovery across repos with evidence + confidence scoring |
| planner | opus | `/planner` | Phased implementation plans, waits for confirmation |
| architect | opus | `/architect` | System design, tradeoff analysis, ADRs |
| pair-programmer | sonnet | `/pair` | Interactive pairing, writes code with you |
| troubleshooter | opus | `/troubleshoot` | Systematic debugging, root cause analysis |

### Commands

| Command | What It Does |
|---------|-------------|
| `/review` | Review uncommitted changes — security, correctness, quality |
| `/discover` | Trace a use case end-to-end across repos — evidence-backed, confidence-scored |
| `/planner` | Create phased implementation plan — never writes code until confirmed |
| `/architect` | System design session — components, tradeoffs, ADRs |
| `/pair` | Pair programming — writes code, tests after every change |
| `/troubleshoot` | Debug an issue — reproduce, isolate, hypothesize, fix |
| `/verify` | Cross-language build/lint/test gate — PASS/FAIL report |

### Skills

| Skill | Coverage |
|-------|----------|
| `csharp-dotnet` | .NET 10, C# 14, EF Core 10, ASP.NET Core 10, NUnit, Testcontainers |
| `typescript` | Strict mode, React/Next.js, Zod, TanStack Query, Jest/Vitest |
| `rust` | thiserror/anyhow, ownership patterns, Tokio, clippy, cargo workspaces |
| `python` | Type hints, Pydantic, FastAPI, httpx, pytest |
| `security-review` | 10-category cross-language security checklist |

### Contexts

Start Claude Code with a specific mode:

```bash
# Add to your shell profile (~/.zshrc or ~/.bashrc)
alias claude-dev='claude --system-prompt "$(cat ~/.claude/contexts/dev.md)"'
alias claude-review='claude --system-prompt "$(cat ~/.claude/contexts/review.md)"'
alias claude-research='claude --system-prompt "$(cat ~/.claude/contexts/research.md)"'
```

| Context | Behavior |
|---------|----------|
| `dev` | Write code first, explain after. Working > perfect. |
| `review` | Read thoroughly, severity-first, push back on bad code. |
| `research` | Read widely, don't write code, cite evidence. |

## C# / .NET Conventions

This plugin enforces specific .NET conventions in reviews and skills:

- **Primary constructors** required for all services
- **External API clients** must use `ISomeApiClient` interface + typed `HttpClient` + DI extension method
- **DI registration** grouped in `IServiceCollection` extension methods per domain
- **Constants** over magic values — `static class SomeConstants`, no hardcoded strings/numbers
- **Test naming**: `[Action]_When[Scenario]_Then[Expectation]`
- **Test categories**: `[UnitTest]`, `[IntegrationTest]`, `[StagingOnly]` for environment filtering
- **NUnit** with `Assert.That` constraint model
- **Testcontainers** for integration tests — no shared databases
- **No dead code** — unused usings, variables, parameters, commented-out code
- **Structured logging** — message templates, never string interpolation in `ILogger`
- **Modern .NET APIs**: `System.Threading.Lock`, `[GeneratedRegex]`, `FrozenDictionary`, `TimeProvider`, `HybridCache`
- **Collection expressions** — `[]` over `new List<T>()`, `Array.Empty<T>()`, `.ToList()`, `.ToArray()` (IDE0300–IDE0305)
- **C# 14**: `field` keyword, null-conditional assignment

## Validation

```bash
npm run validate
```

Validates all agents (frontmatter), commands (cross-references), skills (SKILL.md exists), and hooks (schema).

## Structure

```
nhat-dev-toolkit/
├── .claude-plugin/
│   └── plugin.json
├── agents/
│   ├── architect.md
│   ├── code-reviewer.md
│   ├── discovery.md
│   ├── pair-programmer.md
│   ├── planner.md
│   └── troubleshooter.md
├── commands/
│   ├── architect.md
│   ├── discover.md
│   ├── pair.md
│   ├── planner.md
│   ├── review.md
│   ├── troubleshoot.md
│   └── verify.md
├── contexts/
│   ├── dev.md
│   ├── research.md
│   └── review.md
├── scripts/ci/
│   ├── validate-agents.js
│   ├── validate-commands.js
│   ├── validate-hooks.js
│   └── validate-skills.js
├── skills/
│   ├── csharp-dotnet/SKILL.md
│   ├── python/SKILL.md
│   ├── rust/SKILL.md
│   ├── security-review/SKILL.md
│   └── typescript/SKILL.md
├── install.sh
├── package.json
└── README.md
```