---
description: Implement the current stream or fix review findings. Reads `.pair/status.json` to determine mode, makes code changes, runs targeted verification, and updates `.pair/stream-log.md`.
---

# Pair Implement

Execute these instructions directly. Do NOT spawn a subagent.

## First Steps

1. Read `.pair/status.json` — check `waiting_for` (implement or fix)
2. Read the language skill file from your CLAUDE.md "Global Language Rules" section (the absolute path is there)
3. Read `.pair/plan.md` — `## Implementation Context` section first, then find the current stream
4. If fix mode: read `.pair/review.md`
5. Read `.pair/stream-log.md` — **last 2 entries only**: run `grep -n "^###" .pair/stream-log.md | tail -2` to get line offsets, read from the earlier one

## Mode

- **`implement`**: First stream with unchecked tasks, up to `**Review boundary**`
- **`fix`**: Address BLOCKER and IMPORTANT from `.pair/review.md` (NITs optional unless cheap)

## Workflow

1. Identify current stream. Output: `## Stream N: [name]`
2. Implement tasks. Mark each done: `bash ~/.dotfiles/scripts/pair-check.sh "Task ID"`
3. Keep changes scoped to current stream
4. Verify (language-specific):
   - **C#**: `dotnet build`, then `dotnet test --filter <filter>`. If JetBrains MCP available: `mcp__jetbrains__get_file_problems` + `mcp__jetbrains__reformat_file` on touched files
   - **TypeScript**: `tsc --noEmit`, then test runner from config
   - **Rust**: `cargo check` + `cargo test` + `cargo clippy`
   - **Python**: `pytest` + type checker
5. Run `/pair-simplify` to review changed code for quality and clean up any issues found
6. **Update `.pair/stream-log.md`** — append `### YYYY-MM-DD HH:MM UTC — Stream N: implement/fix`:
   - Agent: `claude / <model>`
   - Language detected, skill path used
   - What changed, files touched, key decisions
   - Verification result (or why skipped)
7. **Signal**: `jq -r '.dispatch_id' .pair/status.json > .pair/.ready`

## Rules

- Do NOT write `.pair/status.json` directly
- Do NOT write `.pair/review.md`
- One change at a time, verify before next
- If stuck after 2 attempts, stop and report
- No optimistic assumptions — read code before claiming anything
- Do not write `.ready` before updating stream log
