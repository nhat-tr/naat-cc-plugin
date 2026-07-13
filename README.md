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
| pair-reviewer | opus | (delegate mid-session) | In-session pair-v2 reviewer: diff vs plan, writes .pair/review.*, BLOCKERs feed the stop-gate |
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
| `pair-v2` | Headless doer/reviewer pair-programming workflow; `.pair/` state, stop-gate enforced |
| `pair-v3` | Automatic Codex/Claude task routing with verification, review, escalation, and quality/cost evidence |
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

Pair v3 is the runtime-neutral execution path for an implementable pair plan.
Run `pair-loop --runtime auto`; it selects the next unchecked task, routes it to
Codex or Claude, verifies and independently reviews the result, records the
attempt in `~/.local/share/pair-v3/attempts.jsonl`, and completes, retries, or
escalates the task automatically. `pair-report` summarizes quality, rework,
findings, tokens, and measured cost by route and task profile.

Pair v2 remains available as an archived workflow and compatibility surface.
Pair-v3 owns canonical plan validation and implementation review for both Codex
and Claude.

##### Pair v2 legacy details

`pair-v2` is a `workflow_skill`, not a plain guidance skill — it ships executable
scripts under `skills/pair-v2/scripts/`:

- `pair-review` — headless, one-shot reviewer. Runs `claude -p` with a fresh
  context against the working-tree diff + plan, writes `.pair/review.md` /
  `.pair/review.json`, and appends BLOCKER findings back into `.pair/plan.md`
  as unchecked tasks. Use `/pair-promote` first to produce the plan it reviews.
- `validate-plan.sh` — compatibility wrapper around the shared pair-v3 parser.
  It enforces intent/capability/simplicity contracts, stable task and AC IDs,
  grounded files, profiles, dependency order, TDD order, and exact verification.
- `workflow-metrics` — measures agent-workflow friction (interrupts, tool
  rejections, stop-gate blocks, pair-review runs, etc.) from Claude Code
  session JSONLs, so a workflow change can be judged on evidence.
- `pair-loop [interval] [--auto]` — one-command overnight loop: validates the
  plan, then launches a FRESH claude session (cheap fixed context per wakeup)
  with `/loop <interval>` working `.pair/plan.md` (or `.claude-loop.md`);
  model/effort picked interactively or via flags. Interval ticks ride out
  token-limit outages, and a SUPERVISOR relaunches a fresh session if the
  session dies while tasks remain (crash/quota-exit resilience + context
  recycling; caps at `PAIR_LOOP_MAX_RESTARTS`, default 10). `--auto` uses
  permission-mode auto so an unattended run can never stall on an approval
  prompt. Run it in a cmux/tmux pane and leave the pane open.

##### How to run it (end to end)

1. **Spec** — let `brainstorming` write `.pair/spec.md` with approved Purpose,
   Rejection Criteria, Contrasts, stable acceptance-criterion IDs, and matching
   verification. Promotion—not brainstorming—owns implementation streams.
2. **Promote** — in the Claude Code session for that repo (terminal, not nvim),
   type `/pair-promote` (optionally `/pair-promote path/to/spec.md`, or right
   after plan mode to promote that plan). It reads the spec and repository,
   verifies pinned dependency capabilities, starts from the framework-native
   baseline, and writes `.pair/plan.md` with Intent, Capability Evidence, and
   Simplicity contracts. Failing focused and integration tests precede the
   implementation they verify. Pair-v3's `validate-plan` is canonical; the old
   `validate-plan.sh` path delegates to it. (`<leader>pc` re-runs it any time.)
3. **Challenge when risk warrants** — `<leader>pC` runs the reviewer in `--plan`
   mode. Use it for high/critical risk, cross-stack work, migrations, and newly
   verified dependencies. It checks intent, evidence, AC coverage, TDD,
   dependency order, grounding, and speculative abstractions. A BLOCKER keeps
   the plan invalid until it is revised or explicitly rebutted.
4. **Implement** — run `pair-loop --runtime auto` (`--once` for one task).
   Pair-v3 revalidates the plan before delegation, verifies independently, and
   reviews each task. The Stop-hook gate blocks premature completion.
5. **Review** — `<leader>pv` in nvim (or run `pair-review` in a terminal).
   The reviewer runs in a fresh context, BLOCKERs land in `.pair/plan.md`
   (the gate holds the doer until they're fixed), and findings auto-import
   into the nvim notes list as `[rv]` entries. `<leader>pV` = eco mode
   (diff-only, cheaper model — S-complexity changes only).
   Mid-session alternative: delegate to the `pair-reviewer` agent.
6. **Triage** — reply to a finding note with `@cc ...` and hit `A` (or
   `<leader>nA` for all) to dispatch questions back to the doer session.
7. **Done** — all boxes checked, verify passes, verdict `approve`.
   `<leader>pD` archives `.pair/` → `.pair-archive/<timestamp>` for the next feature.

##### Nvim keymaps (dotfiles `nhat/pair.lua` — v2 driver)

| Key | Action |
|-----|--------|
| `<leader>pi` | Init — create `.pair/spec.md` skeleton |
| `<leader>ps` / `pp` / `pr` | Open spec / plan / review.md |
| `<leader>pl` | Open `.claude-loop.md` (loop state file) |
| `<leader>pv` / `pV` | Run headless code reviewer (full / eco) + auto-import findings |
| `<leader>pC` | Challenge the plan itself (`pair-review --plan`) before implementing |
| `<leader>px` | Cancel the running review (kills the claude child too) |
| `<leader>pc` | Validate plan structure (`validate-plan.sh`, instant) |
| `<leader>pd` | Diff working tree vs base (Diffview) |
| `<leader>pD` | Done — archive `.pair/` |
| `<leader>ni` | Re-import `.pair/review.json` findings as notes |

### Hooks

Installed by `install.sh` via `hooks/hooks.json` — deterministic enforcement
of rules that instructions alone under-deliver:

| Hook | Event | Does |
|------|-------|------|
| `stop-gate.sh` | Stop | Blocks "done" while a plan has unchecked tasks or `.pair/verify.sh` fails. A `.pair/plan.md` gates only while a live Pair Loop owns `.pair/active-loop.json`; a dormant or crashed plan never blocks ordinary sessions. `.claude-loop.md` retains file-based activation. After the no-progress cap is exhausted, that Pair Loop run stays allowed to stop until task progress or a new run resets the gate. Opt-out `PAIR_STOP_GATE=off` (legacy `CLAUDE_STOP_GATE=off`); no-progress cap `PAIR_STOP_GATE_MAX` (legacy `CLAUDE_STOP_GATE_MAX`, default 5) |
| `delegation-nudge.sh` | PostToolUse (edits) | Once per session at the 8th main-session edit, reminds the model to batch mechanical remainders into a subagent (mech/haiku, general-purpose/sonnet). Opt-out `CLAUDE_DELEGATION_NUDGE=off`; threshold `CLAUDE_DELEGATION_NUDGE_AT` |
| `commit-guard.sh` | PreToolUse (git commit) | Blocks commits containing attribution trailers (Co-Authored-By / Generated with Claude) before they run |
| `scratch-guard.sh` | PreToolUse (Write) | Blocks writes to raw `/tmp` and throwaway `tmp-*.spec/test.*` files in repo trees; points to `$CLAUDE_SCRATCH_DIR` |
| `gate-orient.sh` | SessionStart (incl. post-compaction) | In gated repos, injects the plan status (done/open counts, next task, unresolved BLOCKERs) into every fresh context — silent elsewhere |
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
