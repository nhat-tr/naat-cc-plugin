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

### Claude Code (one command)

```bash
git clone <repo-url> ~/.local/share/my-claude-code && cd ~/.local/share/my-claude-code && ./install.sh
```

The installer handles everything:
- **Prerequisites** — checks for node >= 20, npm, kubectl (fails fast with install hints)
- **Infra deps** — installs `tsx` globally, `@types/node` in `infra/`
- **Claude Code integration** — symlinks agents, commands, skills, contexts into `~/.claude/`
- **CLI tools** — symlinks `jaeger`, `grafana`, `kibana-logs` into `~/.local/bin/`
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

Notes:
- `install.sh` is Claude-specific and installs to `~/.claude/` and `~/.local/bin/`.
- `install-codex.sh` installs skill symlinks to `~/.codex/skills/` and `~/.agents/skills/`.
- `install-codex.sh` also installs the full `AGENTS.md` template to:
  - Codex: `~/.codex/AGENTS.md`
  - Copilot CLI / shared agents path: `~/.agents/AGENTS.md`
- `install.sh` installs the full `CLAUDE.md` template to `~/.claude/CLAUDE.md`.
- Both installers back up existing global instruction files before replacing them.
- Skill installs use symlinks so repo edits are reflected immediately. Global instruction files are rendered copies with repo-path substitution.

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
| sonar-analyst | sonnet | `/sonar` | SonarQube analysis — run scanners, interpret findings, quality gate |
| grafana-analyst | sonnet | `/grafana` | Query Grafana for service health, pod resources, dashboards |
| jaeger-analyst | sonnet | `/jaeger` | Search OTel traces — slow spans, errors, trace waterfalls |
| kibana-analyst | sonnet | `/kibana-logs` | Search Elasticsearch logs — ES Query DSL, trace correlation |

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
| `/sonar` | SonarQube static analysis — run scanner, fetch results, explain findings |
| `/grafana` | Query Grafana for service health metrics, pod CPU/memory, dashboards |
| `/jaeger` | Search and diagnose OTel traces — errors, latency, trace waterfalls |
| `/kibana-logs` | Search Elasticsearch logs — natural language to ES Query DSL |
| `/generate-index` | Generate `.observability/logs.json` + `traces.json` for the current project |

### Codex Workflow Skills

| Skill | Purpose |
|-------|---------|
| `review-workflow` | Uncommitted-diff code review workflow |
| `planner-workflow` | Planning-only phased implementation workflow |
| `architect-workflow` | Architecture and tradeoff workflow |
| `discovery-workflow` | Evidence-first use-case discovery workflow |
| `sonar-workflow` | SonarQube analysis and quality gate workflow |

### Shared Language Skills

| Skill | Coverage |
|-------|----------|
| `csharp-dotnet` | .NET 10, C# 14, EF Core 10, ASP.NET Core 10, NUnit, Testcontainers |
| `typescript` | Type safety, React/Next.js, Node patterns, async/perf, testing |
| `rust` | thiserror/anyhow, ownership patterns, Tokio, clippy, cargo workspaces |
| `python` | Type hints, Pydantic, FastAPI, httpx, pytest |
| `security-review` | 10-category cross-language security checklist |
| `observability-index` | Generate `.observability/logs.json` + `traces.json`; optional Tier 2 caller/callee enrichment via embedcode |

### Observability CLI Tools

All CLI tools support `--help` for full usage instructions.

**Remote cluster tools** — access Grafana, Jaeger, and Elasticsearch via kubectl. Environments: `qss`, `oae`, `prod`.

```bash
# Jaeger — trace search (kubectl port-forward, no auth)
echo '{"action":"services"}' | jaeger qss
echo '{"action":"search","service":"X","tags":"error=true"}' | jaeger oae
echo '{"action":"trace","id":"abc123"}' | jaeger prod

# Grafana — service health and pod resources (kubectl port-forward, K8s secret auth)
echo '{"action":"health","namespace":"regrinding"}' | grafana qss
echo '{"action":"pods","namespace":"tlm"}' | grafana oae

# Elasticsearch logs — ES Query DSL (direct ES API, K8s secret auth)
echo '{"size":50,"query":{"term":{"level.keyword":"Error"}}}' | kibana-logs oae
```

**Local Aspire tools** — read OTLP JSON lines from the OTel collector file exporter. Requires Aspire with file exporter configured (see `LocalDevInfra` setup).

```bash
# Aspire structured logs — filtered, noise-excluded
aspire-logs --resource DT-Core --level Error,Warning --last 5m
aspire-logs --list-resources
aspire-logs --resource RG-Core --grep "connection" --follow
aspire-logs --resource RG-Core --level Error -o /tmp/diag.txt

# Aspire distributed traces — filtered, text waterfalls for agent consumption
aspire-traces --resource DT-Core --errors --last 5m
aspire-traces --id abc123def456    # full span waterfall
aspire-traces --resource RG-Core --min-duration 500ms
```

### SonarQube Infrastructure

Local SonarQube instance shared across all projects. Lives in `infra/sonarqube/`.

```bash
./infra/sonarqube/sonar-manage.sh up       # Start SonarQube (http://localhost:9000)
./infra/sonarqube/sonar-manage.sh down     # Stop
./infra/sonarqube/sonar-manage.sh status   # Health check
./infra/sonarqube/sonar-manage.sh wait     # Block until ready
```

Scanner scripts (called by `/sonar` command or directly):

```bash
./infra/sonarqube/scan-dotnet.sh [key]     # .NET scanner (auto-installs dotnet-sonarscanner)
./infra/sonarqube/scan-frontend.sh [key]   # JS/TS scanner (uses sonar-scanner or npx)
./infra/sonarqube/fetch-results.sh <key>   # Fetch quality gate + issues from API
```

Project config templates in `infra/sonarqube/templates/` — copy to your project root as `sonar-project.properties`.

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

Validates agents, commands, skills, contexts frontmatter, language-skill routing, global instruction routing (when files exist), and hooks schema.

## Structure

```text
nhat-dev-toolkit/
├── .claude-plugin/
│   └── plugin.json
├── agents/
├── bin/                        CLI tools (symlinked to ~/.local/bin/)
│   ├── aspire-logs
  │   ├── aspire-traces
│   ├── grafana
│   ├── jaeger
│   └── kibana-logs
├── commands/
├── contexts/
├── infra/
│   ├── aspire/                 Aspire structured log + trace scripts
│   ├── grafana/                Grafana query script (kubectl port-forward)
│   ├── jaeger/                 Jaeger trace search script
│   ├── kibana/                 Elasticsearch log search script
│   ├── observability-index/    Index extractor (produces .observability/*.json)
│   └── sonarqube/
│       ├── docker-compose.yml
│       ├── sonar-manage.sh
│       ├── scan-dotnet.sh
│       ├── scan-frontend.sh
│       ├── fetch-results.sh
│       └── templates/
├── metadata/
├── scripts/ci/
├── skills/
├── install.sh
├── install-codex.sh
├── package.json
└── README.md
```
