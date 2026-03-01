---
description: Fast codebase entry-point discovery. Greps and tree-scans a codebase, returns a short navigable list of entry points for the given topic.
model: haiku
---

# /codediscover

Quickly discover entry points in a codebase for the given topic or symbol. Produces two files in `docs/codediscover/`:
1. `<slug>.txt` — quickfix-compatible entry points (auto-loaded into nvim)
2. `<slug>-flow.md` — flow summary diagram showing how the entry points connect

## Rules

- **NEVER read full files.** You already have the line number from LSP/grep output. Use it. Reading a whole file to "understand context" is a violation.
- **NEVER use Read without `offset` + `limit`.** If you must peek at a symbol, read max 20 lines around the match.
- **STOP after 5–10 entry points.** Do not keep grepping for more. Short list first; user can ask to expand.
- **Absolute filepaths only** — quickfix resolves via the path directly; relative paths will not work.
- **LSP → grep → embedcode only** (see Tool Priority). No other navigation tools.

## Output Format

Each line must follow this exact quickfix-compatible format:

```
/absolute/path/to/file.lua:10:0: [Symbol.Name] -- short description
```

- `filepath` — **absolute path**
- `line` — line number (single number, not a range)
- `0` — column (always 0)
- `[Symbol.Name]` — the identifier (class, function, method, module, etc.)
- `-- description` — one-phrase description of what it does

The format is `filepath:line:col: text` — standard quickfix errorformat.

## Tool Priority (MANDATORY order)

You MUST use LSP first. Do NOT skip to Grep or Embedcode without trying LSP.

1. **LSP FIRST (mandatory)**: Always start with `WorkspaceSymbols` or `DocumentSymbols`. These return filepath + line number directly and cost minimal tokens. If LSP returns results, **stop — do not use Grep or Embedcode**.
2. **Grep second**: Only if LSP returns zero results or errors. Run one targeted `rg` pattern. The line number is in the grep output — do not open the file.
3. **Embedcode last** (cross-repo only): Only when the query spans multiple repos or the exact symbol name is unknown.

**Violation**: Using Grep or Embedcode before trying LSP is a rule violation, even if you think Grep would be faster.

## Steps

1. Identify the topic. Determine if it is single-repo or cross-repo.
2. **LSP (mandatory first step)**: run `WorkspaceSymbols` with the topic/symbol name. If results are returned, **go straight to step 5**. Do NOT proceed to Grep.
3. **Grep fallback**: only if LSP returned zero results or errored. Run one targeted `rg` pattern. The line number is in the grep output — use it, do not open the file.
4. **Embedcode** only for cross-repo queries where the symbol name is unknown.
5. Select 5–10 entry points from what you have. **Do not read any file to fill gaps.**
6. Derive a short slug from the user's query (e.g. `auth-flow`, `plugin-loading`, `webhook-handler`).
7. Write both files using Bash:
   ```bash
   mkdir -p "$PWD/docs/codediscover"
   cat > "$PWD/docs/codediscover/<slug>.txt" << 'EOF'
   <quickfix lines>
   EOF
   cat > "$PWD/docs/codediscover/<slug>-flow.md" << 'EOF'
   <flow summary>
   EOF
   ```
   **Never use the Write tool with a relative path — it will fail. Always use Bash with `$PWD`.**
   Nvim auto-detects new `.txt` files in `docs/codediscover/` and loads them into quickfix automatically.
8. Print the flow summary inline in chat so the user sees it immediately.
9. Tell the user: "Quickfix will open automatically in nvim. Flow diagram saved to `docs/codediscover/<slug>-flow.md`."

## Flow Summary Format (`<slug>-flow.md`)

A concise markdown document showing how the discovered entry points connect:

```markdown
# <Topic> Flow

## Summary
<1-3 sentences describing the overall flow>

## Flow
1. **[Symbol1]** (`filename.ext:line`) — what it does
   ↓ calls
2. **[Symbol2]** (`filename.ext:line`) — what it does
   ↓ enqueues to
3. **[Symbol3]** (`filename.ext:line`) — what it does
   ↓ delegates to
4. **[Symbol4]** (`filename.ext:line`) — what it does

## Key Types
- `TypeName` — one-line description (only list types central to the flow)
```

Rules for the flow summary:
- Use the **numbered arrow format** above — no mermaid, no ASCII boxes
- Show the actual call/data flow order, not alphabetical
- Arrow labels describe the relationship: `calls`, `returns`, `enqueues to`, `delegates to`, `reads from`, etc.
- Only include symbols from the quickfix list — do not introduce new ones
- Keep it under 30 lines total

## Example Quickfix Output (`<slug>.txt`)

```
/Users/naat/.dotfiles/home/config/nvim/lua/nhat/discovery_list.lua:10:0: [parse_line] -- parses quickfix format filepath:line:col entries
/Users/naat/.dotfiles/home/config/nvim/lua/nhat/discovery_list.lua:22:0: [M.load] -- reads file and populates quickfix list
/Users/naat/.dotfiles/home/config/nvim/lua/nhat/discovery_list.lua:40:0: [M.setup] -- creates :DiscoveryOpen user command
/Users/naat/.dotfiles/home/config/nvim/init.lua:106:0: [discovery_list.setup] -- wires discovery module into nvim startup
```

## Example Flow Output (`<slug>-flow.md`)

```markdown
# Discovery List Flow

## Summary
Nvim loads discovery results from quickfix-formatted files into the quickfix list, with a polling timer for auto-detection.

## Flow
1. **[discovery_list.setup]** (`init.lua:106`) — called at startup, creates command + starts timer
   ↓ registers
2. **[DiscoveryOpen]** (`discovery_list.lua:40`) — user command with file completion
   ↓ calls
3. **[M.load]** (`discovery_list.lua:22`) — reads file, parses entries, populates quickfix
   ↓ uses
4. **[parse_line]** (`discovery_list.lua:10`) — extracts filepath, line, text from each line

## Key Types
- `quickfix entry` — `{filename, lnum, text}` table passed to `vim.fn.setqflist()`
```
