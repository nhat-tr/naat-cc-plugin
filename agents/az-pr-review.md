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

- If `current_branch` **equals** the PR branch → **Mode REVIEW**. The current working directory IS the PR's workspace. Skip Steps 3–5 entirely. Go to Step 6, then execute the review directly in Step 8 (do NOT emit a prompt block).
- Otherwise → **Mode SETUP**. Proceed through Steps 3–8 normally. Step 8 emits a prompt block for the user to paste into a fresh session.

Mode REVIEW treats the current directory as the prepared worktree — no worktree creation, no dependency install, no submodule check. Assume the workspace is already usable.

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

## Step 8: Review the PR (emit or execute, depending on mode)

The template below is the single source of truth for the review. Step 2.5's mode decides how to use it:

- **Mode SETUP** — Emit the filled-in template verbatim as a copyable fenced block. Do NOT execute the methodology yourself; the user will paste it into a fresh session. The `<submodule-line>` row is included **only if** Step 4 detected `.gitmodules`; otherwise omit it.
- **Mode REVIEW** — Do NOT emit the template. You are already in the workspace — **execute** the methodology described inside it (build mental model → hunt hacks/smells → readability/maintainability → data flow → test stress → YAGNI sweep). Read the code. Produce the findings directly in the output format at the bottom of the template (`file:line — observation — impact (confidence)`). No "copy this" — you are the reviewer.

```
**Review PR #<ID> — <title>**

Working directory: `<absolute-path-to-worktree>`
Size: +<N> / -<M> across <K> files, <commit_count> commits
Branch `<branch>` is checked out and dependencies are installed.
<submodule-line>

**Be technically rigorous, not diplomatic.** Push back when the code is wrong. Soft hedging ("might be worth considering") hides real issues — state the problem directly.

## What this PR does
<5–8 sentence narrative: intent, key data/state changes, invariants being preserved or broken, blast radius, risk signals from commit log>

## Review methodology — work through in order, do NOT skip

1. **Build the mental model FIRST.** `git diff --stat master...<branch>`. For the top 5 files by churn, read each end-to-end (not just diff chunks). For modified public methods, trace callers/callees via JetBrains MCP.

2. **Hunt hacks and smells (top priority).** Magic constants, commented-out code, silent `catch` blocks, `// TODO`/`// HACK`, workarounds bypassing existing abstractions, clever-over-clear patterns, "just happened to work" code. Every occurrence is review-worthy regardless of confidence.

3. **Check readability and maintainability.** Would a future reader understand the intent without external context? Does this introduce hidden coupling, implicit state, or patterns that will bite later? Flag abstractions added without clear reuse.

4. **Trace the critical data flow.** Pick the highest-risk path (e.g. "request X → service Y → DB write Z"). Walk step-by-step: null/empty input? concurrent writes? partial failure? retry? rollback?

5. **Stress-test the tests.** Per project rules, tests must catch realistic failures — not appearances. For each modified test: would it still pass if the feature were broken? Flag mock-heavy tests that don't exercise real behavior.

6. **YAGNI sweep.** Before flagging a feature as under-built, grep the codebase for actual usage. If nothing calls it, the finding is "remove it (YAGNI)?", not "implement properly".

## Priority order for findings
1. **Readability** — intent-clarity, naming, control-flow obviousness
2. **Maintainability** — coupling, implicit state, abstraction boundaries
3. **Hacks / smells** — enumerated in methodology step 2
4. **Correctness** — logic errors, edge cases, concurrency
5. **Language-specific quality** — <language-specific items>
6. **Security** — always flag regardless of confidence: hardcoded credentials/secrets, SQL injection via string concatenation, path traversal, auth bypasses on protected endpoints, secrets in logs, insecure deserialization, command injection. In modified paths.
7. **Performance** — only if measurably important

## Depth calibration
- **Do NOT filter by confidence.** Report every finding with a marker: **(high)** / **(medium)** / **(speculative)**. Medium and speculative findings are the core ask — do not suppress them.
- **Target 5+ findings for any PR >100 lines.** Fewer only if genuinely trivial.
- **Required categories** for non-trivial PRs: at least one **design/maintainability concern** (architectural or cross-file), at least one **test gap** (scenario uncovered).
- **Repository Convention Gate.** Infer conventions before flagging style or architecture. If the repo has no clear pattern (analyzers, lint rules, dominant existing usage), don't raise HIGH on style — either skip or mark as LOW suggestion. Don't push modern framework patterns the target framework doesn't support.
- **Consolidate similar issues.** "5 test methods miss teardown" = one finding with 5 file:line references, not five separate findings.
- A review that reports only 2–3 "safe" findings is shallow by construction. If your first pass is that short, you haven't completed steps 1–6.

Format: `file:line — <observation> — <impact or question> (confidence)`

Use `evidence-discipline` before claiming specific field shapes or runtime behavior.
```

**Submodule line template** (insert verbatim when `.gitmodules` was detected in Step 4; omit otherwise):
> `Submodules detected — run 'git -C <worktree> submodule update --init --recursive' if the build requires them.`

**Language-specific quality items:**
- *TypeScript/React*: inline styles over CSS modules, component decomposition, hook boundaries, key prop correctness
- *C#*: NUnit test names (`[Action]_When[Scenario]_Then[Expectation]`), LINQ readability, DI pattern correctness
- *Python*: type annotations on new functions, error handling at boundaries only

## Output

**Mode SETUP:**
1. Worktree path (so the user can open it in their editor)
2. The review agent prompt as a copyable fenced block

Keep the summary short — the prompt block is the deliverable.

**Mode REVIEW:**
1. One-line confirmation: `"Reviewing PR #<ID> in-place at <cwd>."`
2. The review findings — follow the template's methodology and output format. Do not emit the template itself.
3. No prompt block. No handoff text.
