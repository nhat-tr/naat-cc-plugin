---
description: V2.1 Fast codebase entry-point discovery. Discovers entry points for a topic and outputs a navigable quickfix list.
model: sonnet
allowedTools:
  - Bash(mkdir -p docs/codediscover)
  - Bash(cat > docs/codediscover/*)
  - Bash(for *)
  - Bash(rg *)
  - Bash(ls *)
  - mcp__embedcode__embedcode_trace
  - mcp__embedcode__embedcode_get_symbol
  - Read(docs/codediscover/*)
---

# /codediscover

## RULES — read these first, they override everything below

1. **NEVER use `--heading`** with rg.
2. **NEVER use `-B`, `-A`, `-C`** context flags with rg.
3. **NEVER pass multiple directories as arguments to rg.** Use a `for` loop.
4. **NEVER use broad patterns** like `class.*Service`, `public.*Twin`, `.*Create`. Use domain nouns from the query.
5. **NEVER fabricate paths.** If a file path did not appear in rg or embedcode output, do not use it.
6. **ONE rg call.** Finds entry points (STEP 2). Call tracing uses `embedcode_trace` (STEP 4).
7. **NEVER use the Read tool** (except for docs/codediscover/).
8. **Every directory the user names MUST be searched.** If the user says "check Core, Frontend, Client.*", all three MUST appear in your `for` loop. Missing a user-specified directory is a critical failure.
9. **NEVER guess call relationships.** The flow tree MUST come from `embedcode_trace`. If embedcode is unavailable, fall back to a second rg call for call sites.

## What this produces

Two files in `docs/codediscover/`:
1. `<slug>.txt` — quickfix entry points for nvim
2. `<slug>-flow.md` — call tree from trace data

## STEP 1: ls then SCOPE

**If user specifies subdirectories** (e.g. `Regrinding/Core`, `Regrinding/Frontend`, `Regrinding/Client.*`):
- Run `ls <parent>` to expand globs. E.g. `ls /Users/nhat/Work/worktrees/Regrinding/` to see all Client.* dirs.
- The for loop dirs are the expanded subdirectory paths, NOT top-level dirs.

**If user specifies top-level repos** (e.g. `Calibration, NIA, Regrinding`):
- Run `ls <root>` to enumerate repos.

Then print:

```
SCOPE
─────
Directories: <all dirs from ls>
Searching:   <dirs to search — MUST include every dir user named>
Excluding:   <dirs to skip>
Topic:       <query topic>
Pattern:     <rg regex — domain nouns from the query>
```

Do NOT search until SCOPE is printed.

### Pattern construction

- **Exact symbol query** ("find CreateTwin"): `CreateTwin|CreateTwinAsync`
- **Flow/lifecycle query** ("lifecycle of slot to twin to order"): extract key domain nouns from the query: `LaserProcess|Slot|Twin|OrderItem`
- **NEVER** use `class.*Service`, `public.*Create`, or other broad regex. Use the nouns/names the user gave you.

## STEP 2: Search (ONE Bash call)

**This is the ONLY allowed rg command format:**

```bash
for dir in dir1 dir2 dir3; do echo "=== $dir ===" && rg "Noun1|Noun2|Noun3" "<root>/$dir" --type cs -n | grep -v "excluded/" | head -15; done
```

Example — user said "check Regrinding/Core, Regrinding/Frontend, Regrinding/Client.*":
```bash
for dir in Core Frontend Client.LaserProcess Client.LaserEquipment; do echo "=== $dir ===" && rg "LaserProcess|Slot|Twin|OrderItem" "/Users/nhat/Work/worktrees/Regrinding/$dir" --type cs -n | head -15; done
```

Rules:
- `for` loop — one dir per iteration, each with its own `head -15`
- **Every user-specified dir MUST be in the loop** — no exceptions
- Expand globs before searching: `Client.*` → `Client.LaserProcess Client.LaserEquipment` (from ls)
- `-n` for line numbers
- `--type cs` (or `py`, `ts`) for language filter. If a dir is Frontend (TypeScript), use `--type ts`
- `grep -v` for exclusions
- **NO `--heading`, NO `-B`/`-A`/`-C`** — every rg line must be `filepath:linenum:content`

### Expected rg output format (every line self-contained):
```
/Users/nhat/Work/worktrees/Regrinding/Core/Services/LaserProcessService.cs:15:    public async Task CreateLaserProcessAsync(...)
```

If a line has NO filepath prefix (just `3:public class Foo`), that line is CORRUPT — skip it entirely.

## STEP 3: Pick 5–10 entry points

Extract from rg output lines only:
- **Path**: text before first `:` — must start with `/`
- **Line**: number between first and second `:`
- **Symbol**: from the code after second `:`

**Skip any rg line where the path does not start with `/`.** That means the filepath was stripped.

## STEP 4: Trace call chain (embedcode_trace)

Use `embedcode_trace` to trace call relationships between entry points from STEP 3.

For 1–3 key entry point symbols, call:
```
embedcode_trace(symbol: "ClassName.MethodName", direction: "callees", depth: 3)
```

- Trace the **top-level entry point** with `direction: "callees"` to see what it calls
- If the query is about "what calls X", use `direction: "callers"` instead
- Max 2 trace calls to stay within budget
- Cross-reference trace results with the rg entry points from STEP 3 to build the flow tree


### Fallback: if embedcode_trace is unavailable

If embedcode_trace fails (index not ready, DB error, etc.), fall back to a **second rg call** to find call sites:

```bash
for dir in dir1 dir2 dir3; do echo "=== $dir ===" && rg "symbolA|symbolB|symbolC" "<root>/$dir" --type cs -n | head -20; done
```

Extract connections from call-site lines (e.g. `await _service.CreateTwinAsync(` proves caller→callee).

## STEP 5: Validate

```
VALIDATION
──────────
- [x] Core/ — N points
- [x] Frontend/ — N points
- [x] Client.LaserProcess/ — N points
- [ ] excluded/ — excluded
- Total: N
- All user-specified dirs have results: yes/no
- All paths start with /: yes/no
- Flow tree source: embedcode_trace / rg fallback
```

**CRITICAL: If a user-specified directory has 0 results, you MUST flag it:**
```
- [!] Frontend/ — 0 results ⚠ USER SPECIFIED THIS DIR — pattern may not match this codebase
```
Do NOT silently omit directories the user asked to search.

## STEP 6: Write

```bash
mkdir -p "$PWD/docs/codediscover" && cat > "$PWD/docs/codediscover/<slug>.txt" << 'QFEOF'
/abs/path/file.ext:10:0: [Symbol] -- description
QFEOF
cat > "$PWD/docs/codediscover/<slug>-flow.md" << 'FLOWEOF'
# Topic Flow

## Summary
<1-3 sentences>

## Flow
```
EntryPoint                         Dir/File.cs:line
├─ CalledSymbol                    Dir/File.cs:line
│  └─ DeeperCall                   Dir/File.cs:line
└─ OtherBranch                     Dir/File.cs:line
   └─ LeafCall                     Dir/File.cs:line
```

## Key Types
- `Type` — description
FLOWEOF
```

Flow format rules:
- **Tree with box-drawing chars** (`├─`, `└─`, `│`) — shows call hierarchy through indentation
- Indentation = caller-callee relationship from trace data. Child is called by parent.
- Right-align file references for scannability
- One line per symbol — NO bullet descriptions, NO multi-line entries
- Only symbols confirmed by embedcode_trace or rg output
- Under 15 lines
- **Tree structure MUST match trace output.** Do not rearrange or guess relationships.

## STEP 7: Present

Print flow inline, then: "Quickfix saved to `docs/codediscover/<slug>.txt`. Flow saved to `docs/codediscover/<slug>-flow.md`."

## Anti-patterns

| Wrong | Right |
|---|---|
| `rg "pattern" dir1 dir2 dir3` | `for dir in dir1 dir2 dir3; do rg "pattern" "$root/$dir" ...; done` |
| `--heading` | Never. Format must be `path:line:content` per line. |
| `-B2` or `-A3` | Never. Context lines lack file paths → hallucination. |
| `class.*Service.*Twin` or `public.*Create` | `LaserProcess\|Slot\|Twin\|OrderItem` (domain nouns) |
| Path not in rg or trace output | Only use paths from tool output |
| `3:public class Foo` (no path prefix) | Skip this line — filepath was stripped |
| User said "check Frontend" but Frontend not in for loop | **Every user-specified dir MUST be in the loop** |
| Frontend returned 0 results, silently omitted | Flag it: `[!] Frontend/ — 0 results ⚠` |
| User said `Client.*` but only searched `Client.LaserProcess` | Expand globs with `ls` first |
| Guessed call chain: "Controller → Service is obvious" | Use `embedcode_trace` for actual callers/callees |

## Example

Query: `/codediscover lifecycle of slot to twin, check Regrinding/Core and Regrinding/Client.*`

Step 1 — ls to expand globs:
```bash
ls /Users/nhat/Work/worktrees/Regrinding/
```
Output: `Core/ Frontend/ Client.LaserProcess/ Client.LaserEquipment/ ...`

```
SCOPE
─────
Directories: Core/ Frontend/ Client.LaserProcess/ Client.LaserEquipment/ ...
Searching:   Core/ Client.LaserProcess/ Client.LaserEquipment/
Excluding:   none
Topic:       lifecycle of slot to twin
Pattern:     LaserProcess|Slot|Twin|OrderItem
```

Step 2 — search:
```bash
for dir in Core Client.LaserProcess Client.LaserEquipment; do echo "=== $dir ===" && rg "LaserProcess|Slot|Twin|OrderItem" "/Users/nhat/Work/worktrees/Regrinding/$dir" --type cs -n | head -15; done
```

Step 4 — trace with embedcode:
```
embedcode_trace(symbol: "LaserProcessService.Execute", direction: "callees", depth: 3)
```
Returns: Execute → CreateTwin → DigitalTwinService.CreateTwinAsync → ...

If embedcode fails, fallback second rg:
```bash
for dir in Core Client.LaserProcess Client.LaserEquipment; do echo "=== $dir ===" && rg "CreateTwinAsync|Execute|OrderItemService|UpdateSlots" "/Users/nhat/Work/worktrees/Regrinding/$dir" --type cs -n | head -20; done
```

Step 5 — validate:
```
VALIDATION
──────────
- [x] Core/ — 4 points
- [x] Client.LaserProcess/ — 3 points
- [x] Client.LaserEquipment/ — 2 points
- Total: 9
- All user-specified dirs have results: yes
- All paths start with /: yes
- Flow tree source: embedcode_trace
```

Flow output (from trace):
```
Execute                            Client/LaserProcessService.cs:58
├─ CreateTwin                      Client/LaserProcessService.cs:196
│  └─ DigitalTwinService.Create    Client/DigitalTwinService.cs:20
│     └─ DigitalTwinService        Core/DigitalTwinService.cs:17
├─ UpdateSlotsAsync                Core/ProcessSlotService.cs:28
└─ OrderItemService                Core/OrderItemService.cs:29
```