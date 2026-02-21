# nhat-dev-toolkit

Dual-target developer toolkit for **Claude Code** and **Codex** across C#/.NET, TypeScript, Rust, and Python.

## Runtime Support

| Runtime | Supported Assets |
|--------|-------------------|
| Claude Code | Commands, agents, contexts, skills |
| Codex | Skills (language + workflow skills) |

Runtime/asset mapping source of truth:
- `metadata/runtime-asset-map.yaml`

## Install

### Claude Code

```bash
git clone <repo-url> ~/.claude/plugins/nhat-dev-toolkit
cd ~/.claude/plugins/nhat-dev-toolkit
./install.sh
```

Uninstall:

```bash
./install.sh --uninstall
```

### Codex

```bash
git clone <repo-url> ~/.codex/vendor_imports/nhat-dev-toolkit
cd ~/.codex/vendor_imports/nhat-dev-toolkit
./install-codex.sh
```

Uninstall:

```bash
./install-codex.sh --uninstall
```

Notes:
- `install.sh` is Claude-specific and installs to `~/.claude/`.
- `install-codex.sh` installs skill symlinks to `~/.codex/skills/`.
- Both installers use symlinks so repo edits are reflected immediately.

## What's Included

### Claude Code Agents

| Agent | Model | Command | Purpose |
|-------|-------|---------|---------|
| code-reviewer | sonnet | `/review` | Multi-language code review with severity-based findings |
| discovery | haiku | `/discover` | Use case discovery across repos with evidence + confidence scoring |
| planner | opus | `/planner` | Phased implementation plans, waits for confirmation |
| architect | opus | `/architect` | System design, tradeoff analysis, ADRs |
| pair-programmer | sonnet | `/pair` | Interactive pairing, writes code with you |
| troubleshooter | sonnet | `/troubleshoot` | Systematic debugging, root cause analysis |

### Claude Code Commands

| Command | What It Does |
|---------|-------------|
| `/review` | Review uncommitted changes — security, correctness, quality |
| `/discover` | Trace a use case end-to-end across repos — evidence-backed, confidence-scored |
| `/planner` | Create phased implementation plan — never writes code until confirmed |
| `/architect` | System design session — components, tradeoffs, ADRs/decision notes |
| `/pair` | Pair programming — writes code, tests after each meaningful change |
| `/troubleshoot` | Debug an issue — reproduce, isolate, hypothesize, fix |
| `/verify` | Cross-language build/lint/test gate — PASS/FAIL report |

### Codex Workflow Skills

| Skill | Purpose |
|-------|---------|
| `review-workflow` | Uncommitted-diff code review workflow |
| `pair-workflow` | Interactive pair-programming workflow |
| `planner-workflow` | Planning-only phased implementation workflow |
| `architect-workflow` | Architecture and tradeoff workflow |
| `troubleshoot-workflow` | Systematic debugging workflow |
| `discovery-workflow` | Evidence-first use-case discovery workflow |

### Shared Language Skills

| Skill | Coverage |
|-------|----------|
| `csharp-dotnet` | .NET 10, C# 14, EF Core 10, ASP.NET Core 10, NUnit, Testcontainers |
| `typescript` | Type safety, React/Next.js, Node patterns, async/perf, testing |
| `rust` | thiserror/anyhow, ownership patterns, Tokio, clippy, cargo workspaces |
| `python` | Type hints, Pydantic, FastAPI, httpx, pytest |
| `security-review` | 10-category cross-language security checklist |

### Claude Contexts (Optional)

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

## Validation

```bash
npm run validate
```

Validates all agents (frontmatter), commands (cross-references), skills (SKILL.md exists), and hooks (schema).

## Structure

```text
nhat-dev-toolkit/
├── .claude-plugin/
│   └── plugin.json
├── agents/
├── commands/
├── contexts/
├── scripts/ci/
├── skills/
├── install.sh
├── install-codex.sh
├── package.json
└── README.md
```
