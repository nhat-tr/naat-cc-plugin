# nhat-dev-toolkit

Multi-runtime developer toolkit for **Claude Code**, **Codex**, and **GitHub Copilot** across C#/.NET, TypeScript, Rust, and Python.

## Runtime Support

<!-- BEGIN GENERATED:runtime-support -->
| Runtime | Supported Assets |
|--------|-------------------|
| Claude Code | Commands, agents, skills, CLI wrappers |
| Codex | Compatible skills, generated global AGENTS |
| GitHub Copilot | Repo instructions, path instructions, compatible skills |
<!-- END GENERATED:runtime-support -->

Runtime/asset mapping source of truth:
- `metadata/runtime-asset-map.yaml`

## Install

### Claude Code

```bash
git clone <repo-url> ~/.local/share/my-claude-code
cd ~/.local/share/my-claude-code
./install.sh
```

The installer handles everything:
- **Prerequisites** — checks for node >= 20, npm, kubectl (fails fast with install hints)
- **Infra deps** — installs `tsx` globally, `@types/node` in `infra/`
- **Claude Code integration** — installs generated global instructions plus manifest-driven agents, commands, and skills into `~/.claude/`
- **CLI tools** — symlinks bundled wrappers like `aspire-logs`, `aspire-traces`, `az-pr-comments`, `kibana-logs`, `kibana-traffic`, and `observability-index` into `~/.local/bin/`
- **CLAUDE.md** — installs the full global instruction file with repo-path substitution
- **Post-install checks** — warns if `~/.local/bin` is not in PATH or kubectl has no cluster

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

### GitHub Copilot

Repo-native support is checked in:

- `.github/copilot-instructions.md`
- `.github/instructions/*.instructions.md`
- `.github/skills/*`

Optional global compatible-skill install:

```bash
./install-copilot.sh
```

Notes:
- `install.sh` is the Claude-oriented wrapper and also installs bundled CLI tools to `~/.local/bin/`.
- `install-codex.sh` delegates to the canonical runtime installer and installs compatible skill symlinks to `~/.codex/skills/` and `~/.agents/skills/`.
- `install-copilot.sh` installs the Copilot-compatible skill subset to `~/.copilot/skills/`.
- Global instruction files are rendered copies with repo-path substitution. Repo-native Copilot assets are generated and checked in.
- Skill installs remain symlink-based for global runtimes so local repo edits are reflected immediately.

## What's Included

### Claude Code Agents

| Agent | Model | Command | Purpose |
|-------|-------|---------|---------|
| az-pr-review | sonnet | `/az-pr-review` | Set up an Azure DevOps PR locally and prepare a focused review prompt |
| az-review-response | sonnet | `/az-review-response` | Triage PR comment threads and draft evidence-backed responses |
| discovery | haiku | `/discover` | Use-case discovery across repos with evidence + confidence scoring |
| kibana-analyst | sonnet | `/kibana-logs` | Search Elasticsearch logs with trace correlation guidance |
| pair-sketcher | opus | `/pair-plan` | Write the high-level sketch phase of `.pair/plan.md` |
| pair-planner | opus | `/pair-plan` | Expand an approved sketch into a detailed pair plan |

### Claude Code Commands

| Command | What It Does |
|---------|-------------|
| `/architect` | System design session — components, tradeoffs, ADRs/decision notes |
| `/az-pr-review` | Prepare an Azure DevOps PR worktree and review prompt |
| `/az-review-response` | Analyze PR comment threads and draft responses |
| `/codediscover` | Codebase search-heavy discovery workflow for unfamiliar areas |
| `/discover` | Trace a use case end-to-end across repos — evidence-backed, confidence-scored |
| `/generate-index` | Generate `.observability/logs.json` + `traces.json` for the current project |
| `/kibana-logs` | Search Elasticsearch logs — natural language to ES Query DSL |
| `/pair` | Pair-programming entrypoint for the `.pair/` workflow |
| `/pair-implement` | Implement the active pair stream from `.pair/plan.md` |
| `/pair-plan` | Draft or expand `.pair/plan.md` |
| `/pair-plan-challenge` | Challenge the current `.pair/plan.md` before implementation |
| `/pair-review` | Review the current pair stream against the plan |
| `/pair-review-eco` | Lightweight pair review at a review boundary |
| `/pair-simplify` | Simplify the active pair context before continuing |
| `/planner` | Create phased implementation plans — never writes code until confirmed |
| `/review` | Review uncommitted changes — security, correctness, quality |
| `/verify` | Cross-language build/lint/test gate — PASS/FAIL report |

### Codex-Compatible Skills

| Skill | Purpose |
|-------|---------|
| `aspire` | Aspire local-development and diagnostics guidance |
| `csharp-dotnet` | C#/.NET implementation guidance |
| `discovery-workflow` | Evidence-first use-case discovery workflow |
| `evidence-discipline` | Evidence, correction, and test discipline |
| `python` | Python implementation guidance |
| `review-workflow` | Uncommitted-diff code review workflow |
| `rust` | Rust implementation guidance |
| `security-review` | Cross-language security checklist |
| `typescript` | TypeScript implementation guidance |

### Shared Language Skills

| Skill | Coverage |
|-------|----------|
| `csharp-dotnet` | .NET 10, C# 14, EF Core 10, ASP.NET Core 10, NUnit, Testcontainers |
| `typescript` | Type safety, React/Next.js, Node patterns, async/perf, testing |
| `rust` | thiserror/anyhow, ownership patterns, Tokio, clippy, cargo workspaces |
| `python` | Type hints, Pydantic, FastAPI, httpx, pytest |
| `security-review` | 10-category cross-language security checklist |
| `observability-index` | Generate `.observability/logs.json` + `traces.json`; optional Tier 2 caller/callee enrichment via embedcode |

### Bundled CLI Tools

All CLI tools support `--help` for full usage instructions.

**Azure DevOps**

```bash
az-pr-comments --detect --format text
az-pr-comments 12345 --format text --include-sonar
```

**Elasticsearch**

```bash
echo '{"size":50,"query":{"term":{"level.keyword":"Error"}}}' | kibana-logs oae
kibana-traffic prod regrinding --from now-6h
```

**Local Aspire tools** — read OTLP JSON lines from the OTel collector file exporter.

```bash
aspire-logs --resource DT-Core --level Error,Warning --last 5m
aspire-logs --list-resources
aspire-logs --resource RG-Core --grep "connection" --follow
aspire-logs --resource RG-Core --level Error -o /tmp/diag.txt

aspire-traces --resource DT-Core --errors --last 5m
aspire-traces --id abc123def456    # full span waterfall
aspire-traces --resource RG-Core --min-duration 500ms
```

```bash
observability-index --root .
```

## Validation

```bash
npm run validate
```

Validates runtime assets, generated outputs, agents, commands, skills, optional contexts, global instruction routing, and hooks schema.

## Structure

```text
nhat-dev-toolkit/
├── .claude-plugin/
│   └── plugin.json
├── agents/                     Claude agent prompts that still ship in-repo
├── bin/                        CLI wrappers (symlinked to ~/.local/bin/)
│   ├── aspire-logs
│   ├── aspire-traces
│   ├── az-pr-comments
│   ├── kibana-logs
│   ├── kibana-traffic
│   └── observability-index
├── commands/
├── generated/
├── infra/
│   ├── aspire/                 Aspire structured log + trace scripts
│   ├── azure-devops/           Azure DevOps helpers
│   ├── kibana/                 Elasticsearch log + traffic scripts
│   └── observability-index/    Index extractor (produces .observability/*.json)
├── metadata/
├── scripts/ci/
├── skills/
├── templates/instructions/
├── install.sh
├── install-copilot.sh
├── install-codex.sh
├── package.json
└── README.md
```
