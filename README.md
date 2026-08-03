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
- **Hooks** — merges `hooks/hooks.json` into `~/.claude/settings.json`, installing the pre-prompt freshness gate and coordinated Stop gate

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
| `pair-v4` | Token-bounded Evidence-at-Commit implementation and precision review loop |
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

Pair v4 now implements the breaking Evidence-at-Commit protocol. It consumes an
approved specification plus one compact Review Slice Manifest; it has no separate
model-planning phase, large design artifact, generated packet, reusable model
session, or transcript replay.

See the [Pair vNext architecture](docs/work/work-20260803-pair-evidence-at-commit/architecture.md)
for component boundaries, lifecycle, state ownership, evidence stability, and
current limitations.

Each Review Slice runs in a dedicated `pair/<work-id>` linked worktree. A fresh
implementation session receives only the slice outcome, mapped Acceptance
Criteria, relevant repository paths, and verification command. Pair creates an
immutable checkpoint commit, runs deterministic verification, and routes by facts:
architecture-sensitive changes require a bounded Design Check and independent
read-only review; routine changes can use deterministic proof plus configured
sampling. Review JSON is capped at 6 KiB; its durable outcome is capped at 8 KiB.
Findings are capped at three and must cite the checkpoint commit, path, blob, and
exact line range.

Pair state lives outside every worktree in the repository Git common directory at
`<git-common-dir>/pair/works/<work-id>/`. State is capped at 16 KiB and retains
invocation totals plus only three recent summaries. Git refs under `refs/pair/<work-id>/`
retain compact spec, manifest, Design Check, Review Outcome, and Review Feedback
evidence after a linked worktree is removed. Dependency hydration uses package
manager caches and copy-on-write seeds where available; submodules are initialized
only when explicitly named.

Reviewer findings never trigger automatic edits. A human records `valid`,
`false-positive`, `not-worth-fixing`, or `missing-context`; one bounded correction
is allowed only for deterministic failure or accepted findings. Review Guidance
can enter future prompts only after a 20–50 case offline evaluation improves
precision or escapes without regression, explicit approval, and relevance
selection capped at three rules. The repository retains at most 16 active rules
in 32 KiB. The bank/result caps are 32/16 KiB; detailed trials never enter
persisted results, CLI output, or future review prompts.

The old Pair v3 compiled-plan lifecycle is removed. The `skills/pair-v3` directory
name remains solely as an internal installation path for the new engine.

Registered brainstorming and opt-in general Agent Conversations are protected by the
Freshness Gate after 60 minutes idle. General Agent Conversations can opt in once
per repository with `pair-loop --enable-general-handover`; their Stop hook then
maintains a bounded checkpoint automatically from the exact provider transcript.
A Cold Agent Conversation is blocked before model processing and seals a bounded
Agent Conversation Handover. Start a plain
provider-affine conversation with `pair-loop --fresh-from <handover-id> --runtime auto`,
then adopt it with `pair-loop --adopt-handover <handover-id> --runtime codex|claude`.
Never resume or fork the source conversation. The sole explicit cost-risk recovery
is `pair-loop --allow-cold-resume <handover-id> --once --confirm-cost-risk`; its
Stop boundary retires the source behind an exact refreshed handover, which must
then be launched and adopted. Direct adoption is the other retirement route and
continues in the adopter.

For a manually reviewed checkpoint, pipe one JSON object to
`pair-loop --conversation-checkpoint`, then run `pair-loop --handover-now`.
Transcript recovery keeps bounded user direction, assistant conclusions, and
repository artifact digests; it excludes system/developer content, thinking,
reasoning, and raw tool results. Manual checkpoint JSON is strict: unknown fields
or wrong types fail, findings use `finding`/`reference`/`digest`, and artifacts use
`path`/`sha256`. Both checkpoint commands reject interactive TTY stdin; provide the
JSON with file redirection or a here-document in the same shell invocation.
Disable repository automation with
`pair-loop --disable-general-handover`, or set `AGENT_CONVERSATION_HANDOVER=auto|off`
as an environment-wide override.

##### Agent Conversation Handover quick start

Run the built-in guide whenever you need the full command sequence or the
manual checkpoint schema:

```bash
pair-loop --handover-help
```

For the automatic path, enable it once in each Git repository and then work
normally:

```bash
pair-loop --enable-general-handover
pair-loop --freshness-status
```

The installed Stop hook maintains the Agent Conversation Checkpoint.
At exactly 60 minutes idle, the Freshness Gate blocks the next prompt before model
processing and prints the exact handover ID. Run its printed command from a plain
terminal:

```bash
pair-loop --fresh-from <handover-id> --runtime auto
```

That launches a fresh provider-affine conversation with an adoption instruction;
do not resume or fork the source conversation. If you opened a fresh Codex or
Claude conversation yourself, adopt the handover inside it instead:

```bash
pair-loop --adopt-handover <handover-id> --runtime codex|claude
```

For an optional quality upgrade, ask the current agent to prepare the checkpoint
JSON shown by `--handover-help`, review it (including through a JSONL-aware Neovim
workflow), and record it inside that same agent conversation:

```bash
pair-loop --conversation-checkpoint < checkpoint.json
```

Both checkpoint commands reject interactive TTY stdin. Use that file redirection
or a here-document in the same shell invocation; do not start the command and then
paste or stream JSON into its terminal.

The automatic Stop recovery preserves the manual Core Anchor and stable choices,
while later transcript progress refreshes current direction, unresolved decisions,
and next action. Seal immediately only when you intentionally want to transfer:

```bash
pair-loop --handover-now
```

##### Pair v4 quick start

1. Publish approved Work and `.pair/review-slices.json`.
2. Run `pair-loop open --work <work-id>`; Pair creates the linked worktree.
3. Run bare `pair-loop`; each invocation advances one bounded transition.
4. Inspect with `pair-loop status` and `pair-report --work <work-id>`.
5. Accept required human review with `pair-loop accept --slice <id>`, or classify
   a finding with `pair-loop feedback --finding <id> --disposition <value> --reason <text>`.
6. Review and merge or cherry-pick `pair/<work-id>` with ordinary Git from the
   primary worktree. Pair never merges automatically.
7. Run `pair-loop remove-worktree` after completion; the branch, commits, and
   common-directory evidence remain until you remove them explicitly.

### Hooks

Installed by the canonical runtime installer via `hooks/hooks.json`, including
when Claude has no existing `settings.json` — deterministic enforcement
of rules that instructions alone under-deliver:

| Hook | Event | Does |
|------|-------|------|
| `handover-gate.sh` | UserPromptSubmit | Blocks only a stale registered Agent Conversation before model processing and seals its bounded Agent Conversation Handover; it never persists submitted prompts or compaction summaries. |
| `stop-gate.sh` | Stop | Records registered activity and safely recovers enabled General Agent Conversation checkpoints from the exact provider transcript. |
| `commit-guard.sh` | PreToolUse (git commit) | Blocks commits containing attribution trailers (Co-Authored-By / Generated with Claude) before they run |
| `scratch-guard.sh` | PreToolUse (Write) | Blocks writes to raw `/tmp` and throwaway `tmp-*.spec/test.*` files in repo trees; points to `$CLAUDE_SCRATCH_DIR` |
| `gate-orient.sh` | SessionStart (incl. post-compaction) | Reports only bounded Freshness Gate state for registered brainstorming or opt-in general conversations. |
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
├── hooks/                      Pre-prompt freshness + coordinated Stop gates and hooks.json manifest
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
