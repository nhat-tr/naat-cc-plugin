# nhat-dev-toolkit

Multi-runtime developer toolkit for **Claude Code**, **Codex**, and **GitHub Copilot** across C#/.NET and TypeScript.

## Runtime Support

<!-- BEGIN GENERATED:runtime-support -->
| Runtime | Supported Asset Types |
|--------|-----------------------|
| Claude Code | `agent`, `cli`, `command`, `runtime_entrypoint`, `skill`, `workflow_skill` |
| Codex | `cli`, `runtime_adapter`, `runtime_entrypoint`, `skill`, `workflow_skill` |
| GitHub Copilot | `skill` |
<!-- END GENERATED:runtime-support -->

Runtime/asset mapping source of truth:
- `metadata/runtime-asset-map.json`

## Install

### Claude Code

```bash
git clone <repo-url> ~/.local/share/my-claude-code
cd ~/.local/share/my-claude-code
./install.sh
```

The installer handles everything:
- **Prerequisites** — checks that `node`, `npm`, and `kubectl` are on `PATH` (existence only, no version check); exits if any are missing
- **Infra deps** — installs `tsx` globally, `@types/node` in `infra/`
- **Claude Code integration** — renders the global `CLAUDE.md` (with repo-path substitution) and installs manifest-driven agents, commands, and skills into `~/.claude/`
- **CLI tools** — symlinks bundled wrappers like `aspire-logs`, `aspire-traces`, `az-pr-comments`, `kibana-logs`, `kibana-traffic`, `observability-index`, and `validate-mermaid` into `~/.local/bin/`
- **Permissions** — merges `permissions/allow.json` into `~/.claude/settings.json`
- **Hooks** — merges `hooks/hooks.json` into `~/.claude/settings.json`, installing the Stop-hook completion gate (`stop-gate.sh`)

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
| az-pr-review | sonnet | `/az-pr-review` | Set up an Azure DevOps PR locally in a git worktree, then hand off to az-pr-reviewer |
| az-pr-reviewer | opus | (spawned by az-pr-review) | Deep design review of a checked-out PR worktree in a fresh, unanchored context |
| az-review-response | sonnet | `/az-review-response` | Fetch PR comment threads, give an overview, then draft evidence-backed responses per thread |
| kibana-analyst | opus | `/kibana-logs` | Search Elasticsearch logs AND investigate production errors, quoting evidence verbatim |
| mech | haiku | (delegate by default) | Cheap mechanical worker: renames, repetitive edits, boilerplate, known commands — standalone briefs only |

### Claude Code Commands

| Command | What It Does |
|---------|-------------|
| `/az-pr-review` | Set up an Azure DevOps PR worktree and generate a focused review prompt |
| `/az-review-response` | Analyze PR comment threads and draft a response for each |
| `/codediscover` | Fast codebase entry-point discovery — outputs a navigable quickfix list |
| `/generate-index` | Generate `.observability/logs.json` + `traces.json` for the current project |
| `/kibana-logs` | Search Elasticsearch logs — natural language to ES Query DSL (delegates to `kibana-analyst`) |
| `/loop-plan` | Seed `.claude-loop.md` (goal, acceptance criteria, tasks) so the stop-gate guards a long `/loop` run |
| `/pair-promote` | Promote a spec (or plan-mode output) into an implementable `.pair/plan.md` |
| `/verify` | Cross-language build/lint/test gate — PASS/FAIL report |

### Claude Code Skills

| Skill | Purpose |
|-------|---------|
| `aspire` | Aspire local-dev diagnostics — logs, traces, state, DB queries for a running AppHost |
| `brainstorming` | Turn a vague idea into an approved spec, with an optional live annotatable visual interview |
| `csharp-dotnet` | C#/.NET implementation guidance (.NET 10, C# 14, EF Core 10, ASP.NET Core 10, NUnit) |
| `kube-vuln` | Triage container-image vulnerabilities (Trivy reports) in a Kubernetes namespace |
| `mermaid-validate` | Validate Mermaid diagram blocks right after they're written or edited |
| `module-deepening` | Tactical refactoring heuristics — deletion test, depth-as-leverage, two-adapter rule |
| `pair-v4` | Visible Codex/Claude coordinator, durable per-Work state, reusable Review Session, verification, review, and recovery controls |
| `session-replay-note` | Turn a coding-agent session into a teaching-oriented Obsidian demo (notes + Canvas) |
| `typescript` | TypeScript implementation guidance — React/Next.js, Node, type safety, testing |
| `ubiquitous-language` | Extract a domain-term glossary from the conversation into `UBIQUITOUS_LANGUAGE.md` |
| `web-design-guidelines` | Review UI code for Web Interface Guidelines compliance |

Visual interviews use one shared shell with five purpose-built Workspace Kinds.
See the [Visual Companion operating guide](skills/brainstorming/visual-companion.md)
for Workspace Kind selection. Architecture interviews use the bounded
[Architecture visual runbook](skills/brainstorming/references/architecture-visual.md)
and compile a minimal Draft directly into a render-preflighted v2 session.

#### Pair workflows

Pair v4 is the runtime-neutral execution path for an implementable Pair plan.
Ordinary tests-first implementation stays in the visible Codex or Claude
coordinator, while one independent read-only Review Session is reused for plan,
slice, and cumulative review. Authoritative events, atomic status, and attempt
evidence live under `.pair/runs/<work-id>/`; home-directory history is optional
legacy import only.

Start the three-pane host with `pair-loop --host`, inspect it with
`pair-loop --status`, then run bare `pair-loop --runtime auto`. Attempts survive
process exits at their exact phase. Additional repository files are advisory,
evidence-infrastructure failures preserve work, and visible work is discarded
only through the previewed `--discard-attempt ... --confirm-discard` operation.
`pair-report` summarizes repository-local quality, findings, tokens, resumptions,
and cost evidence.

Pair v2 and Pair v3 are retired as skills — the agent no longer surfaces them,
and the pair-v3 directory remains only as the pair-v4 runtime engine (scripts,
not a skill). `pair-loop --legacy-v3` is still the explicit CLI route to the old
split headless lifecycle; existing `pair-loop`, `--once`, `--inline`, and
`--complete` entry points still work against v4 state.

Registered Pair and brainstorming Agent Conversations are protected by the
Freshness Gate after 60 minutes idle. A Cold Agent Conversation is blocked before
model processing and seals a bounded Agent Conversation Handover. Start a plain
provider-affine conversation with `pair-loop --fresh-from <handover-id> --runtime auto`,
then adopt it with `pair-loop --adopt-handover <handover-id> --runtime codex|claude`.
Never resume or fork the source conversation. The sole explicit cost-risk recovery
is `pair-loop --allow-cold-resume <handover-id> --once --confirm-cost-risk`.

##### Pair v4 quick start

1. **Spec and promote** — use `brainstorming`, then `pair-promote`, to publish
   canonical Work and `.pair/plan.md` with tests-first Review Slices.
2. **Host and diagnose** — run `pair-loop --host`, `pair-loop --attach` when
   needed, then `pair-loop --doctor`.
3. **Implement** — run bare `pair-loop --runtime auto`; complete the printed
   Review Slice in the visible coordinator and let the owning Stop adapter keep
   ordinary phase continuation in that chat.
4. **Control** — use `--pause`, same-invocation `--resume`, `--cancel-now`,
   `--takeover`, or the exclusive human-edit commands without losing state.
5. **Complete** — Pair replays verification, reviews complete patches, advances
   Review Slices, then runs cumulative verification/review and records completion.

### Hooks

Installed by `install.sh` via `hooks/hooks.json` — deterministic enforcement
of rules that instructions alone under-deliver:

| Hook | Event | Does |
|------|-------|------|
| `handover-gate.sh` | UserPromptSubmit, Stop | Records registered Stop activity and blocks only a stale registered Agent Conversation before model processing; it never persists submitted prompts or compaction summaries. |
| `stop-gate.sh` | Stop | Disabled by operator configuration; it emits no continuation response. |
| `delegation-nudge.sh` | PostToolUse (edits) | Once per session at the 8th main-session edit, reminds the model to batch mechanical remainders into a subagent (mech/haiku, general-purpose/sonnet). Opt-out `CLAUDE_DELEGATION_NUDGE=off`; threshold `CLAUDE_DELEGATION_NUDGE_AT` |
| `commit-guard.sh` | PreToolUse (git commit) | Blocks commits containing attribution trailers (Co-Authored-By / Generated with Claude) before they run |
| `scratch-guard.sh` | PreToolUse (Write) | Blocks writes to raw `/tmp` and throwaway `tmp-*.spec/test.*` files in repo trees; points to `$CLAUDE_SCRATCH_DIR` |
| `gate-orient.sh` | SessionStart (incl. post-compaction) | Reads the Pair v4 reducer and injects the exact Work, attempt, phase, Resume target, and evidence sequence into fresh contexts — silent elsewhere |
| `await-notify.sh` | Notification | macOS notification when Claude needs attention (permission prompt, waiting for input). Opt-out `CLAUDE_AWAIT_NOTIFY=off` |

### Codex-Compatible Skills

| Skill | Purpose |
|-------|---------|
| `aspire` | Aspire local-development and diagnostics guidance |
| `csharp-dotnet` | C#/.NET implementation guidance |
| `typescript` | TypeScript implementation guidance |

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
aspire-logs --resource RG-Core --level Error -o "$CLAUDE_SCRATCH_DIR/my-project/aspire/diag.txt"

aspire-traces --resource DT-Core --errors --last 5m
aspire-traces --id abc123def456    # full span waterfall
aspire-traces --resource RG-Core --min-duration 500ms
```

```bash
observability-index --root .
```

**Docs**

```bash
validate-mermaid                # scan every Mermaid block under docs/**/*.md
validate-mermaid README.md      # or check specific files (requires mmdc)
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
├── archive/                    Retired agents/commands/skills/hooks (pair-v1 suite, discovery, etc.) — kept for reference, not installed
├── bin/                        CLI wrappers (symlinked to ~/.local/bin/)
│   ├── aspire-logs
│   ├── aspire-traces
│   ├── az-pr-comments
│   ├── kibana-logs
│   ├── kibana-traffic
│   ├── observability-index
│   └── validate-mermaid
├── commands/
├── generated/
├── hooks/                      Stop-hook completion gate (stop-gate.sh) + hooks.json manifest
├── infra/
│   ├── aspire/                 Aspire structured log + trace scripts
│   ├── azure-devops/           Azure DevOps helpers
│   ├── kibana/                 Elasticsearch log + traffic scripts
│   └── observability-index/    Index extractor (produces .observability/*.json)
├── metadata/
├── permissions/                allow.json — pre-approved tool permissions merged into ~/.claude/settings.json
├── scripts/ci/
├── skills/
├── templates/instructions/
├── install.sh
├── install-copilot.sh
├── install-codex.sh
├── package.json
└── README.md
```
