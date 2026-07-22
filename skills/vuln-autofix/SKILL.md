---
name: vuln-autofix
description: "Use this skill WHENEVER the user wants to FIX / remediate / patch container-image HIGH/CRITICAL vulnerabilities across their .NET service repos and open review PRs — not just report them. Trigger phrases: 'fix the vulnerabilities and open PRs', 'remediate HIGH/CRITICAL in <namespace>', 'patch the CVEs', 'bump the vulnerable packages and create PRs', 'fix Common and update the submodules', 'auto-fix vulns'. Consumes kube-vuln findings, bumps direct NuGet PackageReferences in a fresh fix worktree (never master/Work*/Review), verifies the build, and opens Azure DevOps PRs with `az`. Non-bump findings are researched and proposed, never ignored. For read-only 'what CVEs do we have' triage with no fixing, use the kube-vuln skill instead."
---

# Vulnerability Auto-Fix Skill

Turns kube-vuln HIGH/CRITICAL findings into remediation: mechanical package bumps become build-verified PRs (**Lane A**); everything a clean bump can't resolve is researched and returned as scored options (**Lane B**). Nothing is silently ignored.

The bundled CLI (`scripts/vuln-fix.ts`) is a thin front-end over the shared `repo-ops` library (`../../../lib/repo-ops/`, reusable by other tools), the shared `az` PR module (`../../../infra/azure-devops/pr.ts`), plus this skill's own `plan`/`policy`. `repo-ops` owns the deterministic workspace plumbing (discovery, git worktrees, the csproj bump/remove, restore-reconcile, submodule bumps); `infra/azure-devops/pr.ts` owns `az repos pr` create/update/complete (shared with the `az-pr` skill); this skill supplies the judgment, the research, and **one** approval gate.

## Automation model (default: one upfront "go", then unattended)
Optimize for the fewest interruptions. The project `.claude/settings.json` allowlists the git/az/kubectl/dotnet command surface + the Azure/NuGet sandbox network+filesystem egress, so individual commands do **not** prompt. Safety comes from **a single batched approval**, not per-command prompts:
1. **Pilot** the first repo end-to-end (fix → build → PR), show it, get one "go".
2. Then **fan out one subagent per remaining repo** (`fix-worktree → bump/remove → reconcile → build → push → open-pr`), running in parallel, each reporting pass/fail. Fan-out isolates a hung/failed repo instead of stalling the batch (a real failure mode from the manual workflow).
3. `--auto` / `AUTO=1` skips even the pilot gate for a fully unattended run; `--dry-run` is the brake.

## Non-negotiable safety invariants
1. **Never** edit, branch, or commit inside a `master`, `Work*`, or `Review` worktree. `master` may only be **fast-forwarded** to origin (the CLI enforces this). All fix work happens in a fresh `SecFix-*` worktree.
2. Get **one** explicit approval for the batch (the pilot "go", or `--auto` opt-out) before any `push`/PR. Do not re-prompt per repo once approved; do not push/PR without that one approval.
3. **Never** open a PR whose bump did not `dotnet build` cleanly.
4. **Never** guess an ambiguous image→repo mapping — ask.
5. **Never** silently drop a finding: every HIGH/CRITICAL ends as a Lane A PR or a Lane B option set.
6. **Never** deviate from an approved remediation option without re-asking. Compute blast-radius/fit **before** presenting choices, so the approved option is the one that ships.

## Environment
- Operating root: the **workspace dir** (default: the current directory). Repos are discovered generically (domain-group dirs with per-service bare repos, and workspace-level bare repos).
- Requires: `git`, `dotnet`, `az` (logged in — verify with `az account show`), `node`. Detection reuses the `kube-vuln` skill's `get-vulns.ts` (Trivy Operator reports).

## Model tiering
- Detection + `plan` are cheap — run directly or via a `haiku` subagent.
- The per-repo Lane A execute chain fans out as **one subagent per repo** (`haiku`/`sonnet`) — parallel, hang-isolating.
- **Lane B research must run on a higher-reasoning tier (sonnet/opus) WITH `WebSearch`/`WebFetch`.**
- Subagents do **not** bypass permissions; the settings allowlist does. Fan-out buys parallelism + isolation, not fewer prompts.

## Workflow

### Step 0 — Preflight
Confirm the workspace root, that `az account show` succeeds, and (for detection) that the kube context/namespace is set (see the `kube-vuln` skill for `kubectl dsp env/component`).

### Step 1 — Detect
Get the HIGH/CRITICAL findings as JSON, either from a file the user provides or by running kube-vuln's collector:
```
~/.local/share/my-claude-code/skills/kube-vuln/scripts/get-vulns.ts --severity=HIGH,CRITICAL > /tmp/vulns.json
```

### Step 2 — Plan (the bridge)
```
scripts/vuln-fix.ts plan --report /tmp/vulns.json --root <workspaceDir>
```
`plan` auto-loads two workspace-root config files: `repo-image-map.json` (repo↔image map, authoritative for the image→repo join; `--map` to override) and `.vuln-autofix-policy.json` (`{ "neverUpgrade": [...] }`; `--policy` to override). A package on `neverUpgrade` (e.g. AutoMapper — v15+ is commercial) is routed to Lane B `policy-hold` and never auto-bumped. Unmapped images fall back to the name heuristic. Returns `{ laneA, laneB }`. Present a table:
- **Lane A** (auto-fixable): CVE · package · `from→to` · owner (`Common` vs service) · group · mapped repos.
- **Lane B** (research): CVE · reason (`no-fix` / `not-a-packageref` / `transitive-only` / `breaking-major` / `ambiguous-mapping` / `policy-hold`) · affected.
If any `mappedServices` entry is `ambiguous` or `localRepo:null` (these surface as Lane B `ambiguous-mapping` rows for otherwise-fixable packages), **stop and ask** the user which local repo the image is, then re-run `plan` — the row will re-classify into Lane A or a genuine Lane B reason. Never guess the mapping.

### Step 3 — Lane A (auto-fix): pilot → batched fan-out, submodule ordering (a)
Group Lane A rows by owning repo. **If a row's owner `inCommon` is true, the fix goes in that group's `Common` first** — but first check whether `Common`'s *source* is already at ≥ the fixed version (a prior fix may have merged while the running image lagged); if so, skip the Common fix and go straight to the consumer submodule-advance.

Per-repo execute chain (what each pilot / fan-out subagent runs):
1. `fix-worktree --repo <name> --branch security/<cve-or-date>` → `SecFix-*` worktree (fetch → ff `master` → branch).
2. Apply the fix: `bump --csproj <path> --package <id> --to <fixedVersion> --worktree <wt>`. For the "drop a redundant ref that `Common` now provides" pattern, use `remove-package --csproj <path> --package <id>`.
3. `reconcile --worktree <wt>` — resolves NuGet downgrade cascades (restore → raise the offending pin → retry). Restores run with `NUGET_CREDENTIALPROVIDER_DISABLEINTERACTIVE=1`, so they never hang on a credential prompt (a real unattended-batch failure). If build/reconcile fails → **do not PR**; route the row to Lane B ("why did the bump break?").
4. `open-pr --repo <bare> --repo-name <n> --branch <b> --target <default> --title "…" --description "CVE-… installed→fixed; <links>" --execute` — org/project/repository are derived from the repo's git remote automatically (no `az devops configure` global state).

**Flow:** run 1–4 for **one pilot repo**, show diff + build + PR, get the single "go" (invariant #2). Then **fan out one subagent per remaining repo** running 1–4 in parallel; collect pass/fail. `--auto` skips the pilot gate.

**Ordering (a):** after a group's `Common` PR opens, **do not** open its consumer submodule PRs yet. List the consumers (`usesCommonSubmodule` services in that group that also shipped the CVE) as a follow-up for **after the Common PR merges**. On that follow-up, fan out per consumer: `fix-worktree` → `bump-submodule --consumer <wt> --submodule-path <Hoffmann.*.Common> --sha <merged Common sha>` → `reconcile`/build → (one batched gate) → `open-pr`.

### Step 4 — Lane B (research + propose)
For every Lane B row (and any Lane A bump that failed to build), on the higher-reasoning tier:
1. Research the advisory via `WebSearch`/`WebFetch` (CVE id / GHSA / NVD / package release notes) → a 1–2 sentence root-cause note **with a link**.
2. Propose **≥2 concrete remediation options scored 1–10 with tradeoffs**, choosing the family by reason:
   - `breaking-major` → major upgrade + migration · alternative package · documented mitigation.
   - `transitive-only` → pin via explicit `PackageReference` · bump the direct parent package · no-fix-available note.
   - `not-a-packageref` (OS/base-image) → bump the base-image tag · platform-managed/mitigation.
   - `no-fix` → config/workaround mitigation · monitor · justified temporary suppression.
   - `ambiguous-mapping` → NOT a research case: ask which local repo the affected image is, then re-run `plan` (the row re-classifies). Never research it as an OS package.
   - `policy-hold` → the package is on `neverUpgrade` (e.g. a licensing wall): propose within-policy options only — stay on the licensed-safe version + a mitigation, a maintained fork/alternative, or an explicit exception the user adds to `.vuln-autofix-policy.json`. Never auto-upgrade past the policy.
3. **Do not auto-apply.** If the user picks an option that reduces to a package bump, re-enter Step 3 (gated).

Confirm at the end that **every** HIGH/CRITICAL finding ended as either a Lane A PR or a Lane B option set (invariant #5).
