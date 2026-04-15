---
name: system-prompt-creator
description: >
  Rebuild or update the optimized Claude Code system prompt after upstream changes.
  Produces two versions: aggressive/compressed (~250 lines) and normal/uncompressed (~340 lines).
  Use when: merging upstream, rebuilding the prompt, classifying new files,
  compressing sections, or validating the prompt against the running instance.
  Triggers: "rebuild prompt", "update system prompt", "sync upstream", "compress section",
  "check for new files", "validate prompt", "build normal prompt", "compare prompt".
---

# System Prompt Creator

Rebuild an optimized, standalone system prompt from Claude Code's extracted prompt fragments. The source repo tracks upstream releases — the extracted files are ~60-70% of the actual running prompt. The rest is runtime-assembled and captured manually.

## Prerequisites: ensure the repo exists

The source repo must be at `../claude-code-system-prompts`. If missing, clone it:

```bash
if [ ! -d ~/HES/workspace/claude-code-system-prompts ]; then
  git clone https://github.com/nhat-tr/claude-code-system-prompts.git ../claude-code-system-prompts
  cd ../claude-code-system-prompts
  git remote add upstream https://github.com/Piebald-AI/claude-code-system-prompts
  npm install
fi
```

All commands in this skill run from `~/HES/workspace/claude-code-system-prompts`.

## Before rebuilding: sync upstream

```bash
cd ../claude-code-system-prompts
git fetch upstream
git merge upstream/main
```

If merge conflicts occur in `system-prompts/`, accept upstream changes — those are the source of truth. Conflicts in `raw/compressed/`, `prompt-build-config.json`, or `BUILD.md` need manual resolution.

## Workflow

The process has two modes: **incremental update** (after upstream merge) and **full rebuild** (rare, from scratch).

### Incremental update (common path)

This is what you do after merging upstream.

#### Step 1: Check for changes

```bash
npx tsx build-prompt.ts --check
```

This reports: unclassified files, changed files since last version, files needing review. If 0 across the board, nothing to do — skip to Step 5 (validate).

#### Step 2: Classify new files

For each unclassified file reported by `--check`:

1. **Check the family prefix.** Files matching a `family_defaults` entry in `prompt-build-config.json` (tool-description, system-reminder, agent-prompt, data, skill, tool-parameter) are bulk-excluded automatically. No action needed unless the file is an exception.

2. **For `system-prompt-*` files:** Read the file. Decide:
   - `"include"` — assign a section key from the config's `sections` map
   - `"exclude"` — add `notes` explaining why
   - `"review"` — come back later

3. **Section assignment rule:** Which section would break without this file? Assign it there. If ambiguous, note the secondary section in `notes`.

4. **Update config:** Add the entry to `prompt-build-config.json` under `files`. Update `version` and `version_commit` to the new upstream version.

#### Step 3: Assemble

```bash
npx tsx build-prompt.ts --assemble
```

This regenerates `raw/raw/*.md` (assembled source per section) and `raw/manifest.md`. Only sections with changed/new included files will have different content.

#### Step 4: Recompress changed sections

For each section whose raw source changed:

1. Read `raw/raw/NN-section-name.md` (the assembled source)
2. Read `raw/compress-instructions.md` (compression rules)
3. Read the current `raw/compressed/NN-section-name.md` (previous compressed version)
4. Rewrite the compressed version incorporating the changes

**Compression rules:**
- Strip YAML frontmatter (`<!-- ... -->`) from source — it's extraction metadata
- Resolve template variables to actual tool names (Read, Edit, Write, Glob, Grep, Bash, Agent, Skill)
- Preserve every behavioral rule. If cutting a rule, state why (redundant, too obvious).
- No forward references between sections. Each section is self-contained.
- `##` headers for sections, `###` max for subsections.
- Terse. No filler. Rules only.
- Preserve user custom additions (e.g., `[DESTRUCTIVE]` prefix) — these are intentional behavioral modifications, not compression artifacts.

**Validation after compressing:** List every distinct behavioral rule from the raw source. Confirm each appears in the compressed output. Flag any dropped rule with rationale. This step is not optional — skipping it caused missed rules in the initial build.

#### Step 5: Check runtime-only content

This is the most critical step. The extracted repo is incomplete — ~30-40% of the running prompt is assembled at runtime and NOT in any extracted file.

1. Read `raw/runtime-only/missing-behavioral-rules.md` and `raw/runtime-only/memory-system-full.md`
2. Compare against your current running system prompt (what's in your context right now)
3. If any rule in your running prompt is NOT in the compressed sections AND not in runtime-only captures, it's a new runtime-only rule. Capture it.
4. If a captured rule has changed, update it.

**How to verify:** Search for distinctive phrases from the runtime-only files in the extracted `system-prompts/` directory using Grep. If zero hits, the content is confirmed runtime-only and must be maintained manually.

**Known runtime-only content (not in any extracted file):**
- Full memory system (~130 lines): 4 types with XML structure, save mechanics, MEMORY.md index, what NOT to save, when to access, staleness, persistence hierarchy
- Error recovery: "diagnose why before switching tactics"
- UI/frontend testing: "start the dev server", "golden path", "feature correctness"
- Tool permission denial: "do not re-attempt the exact same tool call"
- No-emoji rule (standalone, beyond tool descriptions)
- Security guardrails (malicious activity policy)
- URL generation policy
- Context compaction note

#### Step 6: Build compressed version

```bash
npx tsx build-prompt.ts --build
```

`--build` validates all `raw/compressed/` section files exist (fails loudly if any missing), then concatenates into `raw/system-prompt.md`.

#### Step 6b: Build normal version

The normal version is **manually maintained** at `raw/system-prompt-normal.md`. It is the same content as the compressed version but at original verbosity — full paragraphs, all examples, complete XML memory type definitions.

After updating compressed sections, update the normal version to match:
- Same sections, same rules, same runtime-only content
- Uncompressed: original wording from source files + runtime captures
- Deduped: no repeated examples (source files sometimes have overlapping examples)
- Template variables resolved to actual tool names
- Skillify and worker instructions NOT included (loaded on demand / worker-only)

#### Step 7: Deep validation

Read `raw/system-prompt.md` and `raw/system-prompt-normal.md`. Validate both using this systematic process:

**Section-by-section comparison against running context:**

For each section in the output, go through every rule you can observe in your current running system prompt:

1. Is the rule in the compressed output? (verbatim or semantically equivalent)
2. Is the rule in the normal output?
3. If missing from both: is it in an extracted file? (search `system-prompts/` with Grep)
4. If not in extracted files: is it already captured in `raw/runtime-only/`?
5. If not captured anywhere: it's a new gap. Capture it.

**Evidence discipline — verify, don't assume:**
- Search for distinctive phrases using Grep. "Zero hits" is evidence. "I think it's there" is not.
- Quote exact text from your running context when claiming a rule exists.
- If you claim a rule is "runtime-managed" or "injected by runtime," verify by searching — don't assume.

**Content that should NOT be in the output:**
- Worker instructions (`system-prompt-worker-instructions.md`) — only injected for worker subagents
- Skillify workflow (`system-prompt-skillify-current-session.md`) — loaded on demand via /skillify
- Unresolved template variables (`${TOOL_NAME}` etc.)
- Duplicate examples from overlapping source files
- Content from excluded sections (git operations, plan mode, insights, etc.)

**Content that should be in the output:**
- All rules from included `system-prompt-*` files
- All runtime-only captured rules
- Environment placeholder (caller injects per session)
- `${MEMORY_DIR}` template variable (caller substitutes at runtime)
- User custom additions (e.g., `[DESTRUCTIVE]` prefix)

### Full rebuild (rare)

Only needed if starting from scratch or restructuring sections.

1. Classify all 72 `system-prompt-*` files in `prompt-build-config.json`
2. Run `--assemble`
3. Compress each section individually (8 sections + 00-system preamble)
4. Capture runtime-only content by comparing against running prompt
5. Write the normal version manually
6. Run `--build` for compressed version
7. Deep validation (Step 7 above)

## Key files

| File | Purpose |
|------|---------|
| `prompt-build-config.json` | Classification decisions: include/exclude per file, section assignments |
| `build-prompt.ts` | Build script: `--check`, `--assemble`, `--build` |
| `raw/compressed/00-system.md` | Static preamble (manual, not assembled from upstream) |
| `raw/compressed/01-08-*.md` | Compressed sections (one per section) |
| `raw/compress-instructions.md` | Rules for the compression step |
| `raw/runtime-only/` | Content from running prompt not in extracted files |
| `raw/system-prompt.md` | Compressed output (~250 lines, regenerated by `--build`) |
| `raw/system-prompt-normal.md` | Normal output (~340 lines, manually maintained) |
| `raw/system-prompt-aggressive.md` | Copy of compressed version, kept as reference |
| `BUILD.md` | Full documentation for the build system |

## Sections

| # | Section | Header in output |
|---|---------|-----------------|
| 00 | System preamble | `## System` |
| 01 | Core task execution | `## Doing Tasks` |
| 02 | Tool usage policy | `## Using Your Tools` |
| 03 | Executing with care | `## Executing Actions With Care` |
| 04 | Agent delegation | `## Agent Delegation` |
| 05 | Memory system | `## Memory` |
| 06 | Skills | `## Skills` |
| 07 | Tone and style | `## Tone and Style` |
| 08 | Browser automation | `## Browser Automation` |

## What NOT to include

These are intentionally excluded. Don't add them back without discussion:

- **Git operations** (commit/PR flows) — handled by CLAUDE.md and skill files
- **Plan mode** — not used
- **Insights / learning mode** — not used
- **Autonomous loop / cron** — not used
- **Data references** (API docs, model catalog) — loaded on demand by runtime
- **Worker instructions** — injected only for worker subagents, not main prompt
- **Skillify workflow** — loaded on demand via /skillify, not baked in
- **PowerShell** — macOS user
- **Scratchpad, teammate, minimal mode, option previewer, auto mode** — not used

## The 60/40 problem

The extracted `system-prompts/` files contain ~60-70% of the actual running prompt. The rest is:

| Content | Where it lives | How we handle it |
|---------|---------------|-----------------|
| Full memory system (4 types, mechanics, MEMORY.md) | Runtime-assembled from templates | Captured in `raw/runtime-only/memory-system-full.md` |
| Error recovery, UI testing, tool denial, emoji, security, URL, compaction | Runtime-assembled | Captured in `raw/runtime-only/missing-behavioral-rules.md` |
| Environment block | Runtime per-session | Placeholder in 00-system.md |
| Tool descriptions | Injected with tool schemas | Not included — provided separately |
| CLAUDE.md content | Injected per-project | Not included — separate layer |

Every upstream update: run Step 5 to check if runtime content changed. This is the most likely source of silent regressions.

## Compression style guide

The user prefers:
- No filler words, no emotional language, no unnecessary padding
- Points stated directly — bullet points over prose where possible
- Only text that serves the agent's context, the memory system, or the user's reading comprehension
- Examples only where behavior would be ambiguous without them (agent delegation examples: yes. Memory type examples: in normal version only)
