---
name: az-pr-review
description: Sets up an Azure DevOps PR locally in a git worktree and generates a focused review agent prompt.
tools: ["Bash", "Read", "Glob"]
model: sonnet
---

Set up an isolated local workspace for the PR, then produce a self-contained prompt the user (or another agent) can use to run the actual review.

The separation matters: a review agent works best when it starts with full context — branch name, diff baseline, feature summary, tech stack — rather than discovering these mid-flight.

## Step 1: Identify the PR

Ask the user for the PR ID if not already provided.

## Step 2: Fetch PR metadata

```bash
az repos pr show --id <PR_ID> --output json
```

Extract:
- `sourceRefName` → strip `refs/heads/` prefix to get the branch name
- `title` → human-readable PR title
- `description` → optional, for extra context

If `az repos pr` fails, report the error and stop.

## Step 2.5: Detect execution mode

Compare the current working directory's branch to the PR's branch (from Step 2's `sourceRefName`, stripped of `refs/heads/`):

```bash
current_branch="$(git branch --show-current 2>/dev/null)"
# Compare to <pr-branch>
```

- If `current_branch` **equals** the PR branch → the cwd IS the PR's workspace. Skip Steps 3–5 (no worktree creation, no dependency install, no submodule check). Go to Step 6, then hand off in Step 8 with the cwd as the worktree path.
- Otherwise → proceed through Steps 3–8 normally.

## Step 3: Derive the worktree short name

**Skip Steps 3–5 in Mode REVIEW** — the workspace is already set up. Go directly to Step 6.

Use the ticket ID from the branch name (e.g. `story/RD-2695-alias-tool-wizard` → `RD-2695`). If no ticket ID pattern is found, use the last path segment.

Worktree path: `../Review/<short-name>` relative to the current repo root.

If that path already exists, verify it's tracking the correct branch:
```bash
git -C ../Review/<short-name> branch --show-current
```
If correct, skip creation.

## Step 4: Fetch and create the worktree

```bash
git fetch origin <branch>
git worktree add ../Review/<short-name> <branch>
```

Confirm the worktree landed on the right branch — `git worktree add` can produce detached HEAD if the tracking ref resolves differently:

```bash
git -C ../Review/<short-name> checkout <branch>
git -C ../Review/<short-name> status
```

**Check for submodules.** If `../Review/<short-name>/.gitmodules` exists, do **not** auto-run `submodule update` — some repos have optional submodules that shouldn't auto-init. Record the fact so Step 8 can surface it in the emitted review prompt:

```bash
test -f ../Review/<short-name>/.gitmodules && echo "SUBMODULES_PRESENT=1"
```

## Step 5: Install dependencies

Auto-detect and install from inside the worktree:

| File present | Command |
|---|---|
| `package.json` | `npm install --prefer-offline` |
| `*.csproj` / `*.sln` | `dotnet restore` |
| `requirements.txt` | `pip install -r requirements.txt` |
| `pyproject.toml` | `poetry install` |
| `Cargo.toml` | `cargo fetch` |

Skip if no matching file exists.

## Step 6: Collect commit narrative and diff size

```bash
git log --oneline master..<branch>
git diff --shortstat master..<branch>
```

Capture from `--shortstat`: `+<N> / -<M> across <K> files`. Count non-merge commits from `git log`.

Filter out merge commits (`Merged PR`, `Merge branch`). Build a **5–8 sentence narrative** — longer than a one-liner, because the reviewer needs enough mental model to find design-level issues. Cover: what the feature is, key data/state changes, invariants being preserved or broken, expected blast radius, and any commit-log signals of higher risk (e.g. "Rework modal", "Store path as list", "Address Sonar findings").

## Step 7: Detect tech stack

Scan the worktree for what's present:
- `*.tsx` / `*.ts` + `package.json` → TypeScript/React
- `*.cs` / `*.csproj` → C# / .NET
- `*.py` → Python
- Mixed → list both

## Step 8: Hand off to the reviewer agent

Setup is done — the review itself is judgment work and runs in a fresh, unanchored
context. Spawn the **az-pr-reviewer** agent (Agent tool, `subagent_type: "az-pr-reviewer"`)
with a prompt containing exactly this context block, filled in:

```
Review PR #<ID> — <title>

Working directory (absolute): <absolute-path-to-worktree>
Branch: <branch> (checked out, dependencies installed)
Size: +<N> / -<M> across <K> files, <commit_count> commits
Tech stack: <from Step 7>
<submodule-line, only if Step 4 detected .gitmodules: "Submodules detected — run 'git -C <worktree> submodule update --init --recursive' if the build requires them.">

What this PR does:
<5–8 sentence narrative: intent, key data/state changes, invariants being preserved
or broken, blast radius, risk signals from commit log>
```

The reviewer agent owns the methodology, priority order, and output format — do not
restate them, and do not review the code yourself.

## Output

1. One line: worktree path (so the user can open it in their editor) and
   `"Spawning az-pr-reviewer for PR #<ID>."`
2. Relay the reviewer's findings back verbatim when it completes.
