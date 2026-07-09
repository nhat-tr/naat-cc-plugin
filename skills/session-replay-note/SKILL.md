---
name: session-replay-note
description: >
  Turn a Claude Code (or any coding-agent) session into a visual, teaching-oriented
  Obsidian demo: a set of small atomic notes plus a Canvas that links them into a
  narrative, styled to look like a real terminal session. Use this whenever the user
  wants to "replay", "demo", "showcase", or "teach from" a session — e.g. "turn this
  session into a demo", "make a demo note for my colleagues", "create an Obsidian
  canvas showing how I used the agent", "show the highlights of what we just did",
  "build a session replay". The skill INTERVIEWS the user to decide the highlights and
  acts, then scaffolds notes with paste-ready prompt/response blocks and hints pointing
  back into the raw session so the user can copy the real text in. Trigger it even when
  the user doesn't say "skill" — any request to visually document or teach from a coding
  session belongs here.
---

# Session Replay Note

Produce a **visual, paste-friendly Obsidian demonstration** of a coding-agent session:
many small **atomic notes** (one beat each) tied together by a **Canvas** that tells the
story. The output is meant to be shown to colleagues — "here's how to drive a coding
agent well" — using *real* prompts and responses, styled to look like a Claude Code
terminal.

The reference build this skill generalizes lives at
`<vault>/Notes/recal-e2e-demo/` + `Recal e2e — demo.canvas`. Read it if you want a
worked example before building a new one.

## Helper: export the raw session first (`scripts/export_session.py`)

Before scaffolding, export the source session into the vault so the demo can reference real
text without digging through the terminal. The script parses a Claude Code `.jsonl` and
writes an Obsidian note where human prompts are ```` ```claude-you ```` blocks and each
assistant turn (text + tool calls + results) is a ```` ```claude ```` block — same styling
as the demo, with `## ▷ turn N` headings you can link or embed.

```bash
python3 scripts/export_session.py --current              # export THIS running session (preferred)
python3 scripts/export_session.py --list                 # browse recent sessions
python3 scripts/export_session.py --session <id|path>     # a specific one
python3 scripts/export_session.py --into <demo-slug>      # write to Notes/<demo-slug>/_session.md
```

**Getting the right session matters — a wrong export is worthless.** Resolution order:
explicit `--session` > the running session via the `CLAUDE_CODE_SESSION_ID` env var
(this is what `--current`, and a bare call, use) > latest-by-mtime as a last resort.
**Do not trust mtime to mean "current"** — a sibling session file can have a newer mtime
than the one you're actually in. When documenting the current session, use `--current`
(it errors loudly if the env var is missing rather than guessing). The script prints which
session it picked and how, e.g. `Session: 8f881037 (current session (CLAUDE_CODE_SESSION_ID))` —
glance at that line to confirm.

Default output: `<vault>/Notes/_sessions/<session-start-date>_<shortid>.md` (the filename uses
the session's start date, so re-exporting an ongoing session overwrites the same file rather
than spawning a new one each day). Flags: `--project <substr>`, `--with-thinking`,
`--no-tools`, `--full` (don't truncate long tool results), `--vault`, `--out`. The schema
matches the user's nvim session viewer, so the exported note lines up with what they see at
`<leader>cL` / `<leader>cj`.

With the session exported, the Step 4 paste-hints can point at exported headings
(e.g. `[[_session#▷ turn 7]]`) instead of vague terminal locations — or you can copy a
turn's block straight across.

## What is fixed vs. what the interview decides

**Fixed conventions (never re-litigate these):**
- One **atomic note per beat** (`NN-slug.md`, numbered for order), in `<vault>/Notes/<demo-slug>/`.
- A **Canvas** (`<Title>.canvas`) that lays the notes out in labeled sections with flow arrows.
- Prompt/response rendered with fenced blocks: ```` ```claude-you ```` (your prompt) and
  ```` ```claude ```` (the agent's response). These are styled by the `claude-session.css`
  snippet to look like a terminal.
- Obsidian **callouts** (`> [!tip]`, `> [!danger]`, `> [!success]`, …) carry the teaching point.
- **mermaid** for loops/diagrams.

**The interview decides:** the subject, the audience takeaway, the list of highlights
(→ notes), and how they group into acts/phases (→ canvas sections).

## Step 1 — Interview the user

Ask a few questions (batch with AskUserQuestion where it fits). Goal: pin the **highlights**
and their **grouping**. Do not start writing until these are settled.

1. **Subject & source.** Which session/work is this about? Is the raw transcript available
   (path to the `.jsonl`, or "it's this current session")? Knowing the transcript path lets
   you sharpen the paste-hints in Step 4.
2. **Audience & the one takeaway.** Who watches this and what should they leave believing?
   (e.g. "colleagues; a coding agent runs the normal design→implement→debug loop faster, but
   only with the right inputs and tools.") This becomes the title note and the curriculum note.
3. **Highlights → notes.** Propose a draft bullet list of highlights *from the session
   context you already have*, and let the user cut/add/reorder. Each surviving highlight is
   one atomic note. Aim for 8–16 for a full demo; 3–6 is fine for a compact demo or a
   dry-run — don't pad to hit a count. Good highlight types, from the reference build:
   - the **loop** itself (mermaid), the **toolbelt** (what the agent was equipped with)
   - **phase** beats (learn-from-prod → spec → implement)
   - **example** beats — *a borrowed-from-human-code pattern that was wrong here* (these are
     the heart of the teaching: "the spec wasn't enough; only running/reviewing exposed it")
   - a **debug-funnel** beat, **decision-fork** beats (where the human stayed in control),
     a **when-to-stop** beat, a **curriculum/takeaways** beat, an **outcome** beat.
4. **Acts/sections.** Group the highlights into 3–5 ordered acts (these become the canvas
   section labels and the column layout). The reference used: ① Design→Implement ·
   ② Act II "the spec wasn't enough" · ③ Debug loop · ④ Judgment & outcome.

Confirm the highlight list + grouping back to the user in one message before building.

## Step 2 — Ensure the styling snippet is installed & enabled

The notes are dark/plain text without the snippet. Before writing notes:

1. Confirm the vault path (default `~/Vaults/N8W`; ask if unsure).
2. If `<vault>/.obsidian/snippets/claude-session.css` does not exist, copy this skill's
   `assets/claude-session.css` there.
3. Read `<vault>/.obsidian/appearance.json`. If `enabledCssSnippets` does not contain
   `"claude-session"`, add it.
4. The snippet must be hot-reloaded once in the UI: *Settings → Appearance → CSS snippets →
   refresh (↻) → toggle `claude-session` ON.* Obsidian does not pick up a newly-added
   snippet from `appearance.json` alone until it's toggled in the UI. **Deliver this
   reminder in the Step 6 handoff message** (not mid-build), and only if you had to install
   or newly-enable the snippet — skip it if it was already active.

Important rendering facts (don't waste loops rediscovering them):
- The snippet renders in **Reading view, Canvas cards, embeds, exports** — **NOT Live Preview**.
  Tell the user to view the canvas/notes accordingly.
- Obsidian **strips `class`** from raw HTML but keeps inline `style`. That's *why* we use
  fenced ```` ```claude ```` blocks (which reliably get a `language-claude` class) instead
  of styled HTML. Do not switch to class-based raw HTML.
- Blank lines inside a raw HTML `<pre>` terminate the HTML block. Another reason to use
  fenced blocks, where blank lines are fine.

## Step 3 — Write the atomic notes

Create `<vault>/Notes/<demo-slug>/` and write one `NN-slug.md` per highlight, numbered in
narrative order (`00-`, `01-`, …).

Each note is small (a screenful). Shape:

```markdown
## <Short beat title>

> [!note] <the teaching point in one line>

​```claude-you
> <the user's prompt — pasted raw from the session>
​```

​```claude
⏺ <the agent's response — pasted raw, keep the ⏺ / ⎿ glyphs and tree indents>
​```

> [!danger] <why this mattered / what went wrong / the rule learned>
```

**The fenced ```` ```claude-you ```` / ```` ```claude ```` blocks are OPTIONAL** — include
them only when the beat *is* a specific prompt/response exchange. Many notes have none: a
loop or funnel note is mermaid + a `[!tip]`; a toolbelt note is a bulleted list under
`[!abstract]`; an outcome note is prose under `[!success]`. Don't force an empty terminal
block onto a note that has no exchange to show.

Conventions:
- **Lead with `## Title`.** No frontmatter is required (the reference notes have none); add
  it only if the user wants tags.
- Pick callout types by intent: `[!tip]` guidance · `[!note]` framing · `[!example]` a
  borrowed pattern · `[!danger]`/`[!warning]` the failure or risk · `[!success]` the win ·
  `[!abstract]` a summary/overview · `[!quote]` the agent's own words at a decision point ·
  `[!info]` neutral context. Use foldable (`[!info]-`) for long asides.
- Use ```` ```mermaid ```` for the loop / funnel / flow notes.
- Keep the agent transcript **authentic** — preserve `⏺`, `⎿`, indentation, file:line refs.
  Trim length, never paraphrase into fiction.

## Step 4 — Leave paste-hints, don't invent transcript

The user copies real prompts/responses from the raw session and pastes them in. Your job is
to make that lookup easy, **not** to fabricate exchanges.

For every ```` ```claude-you ```` / ```` ```claude ```` block whose content you are not 100%
sure of, write a **placeholder + hint comment** instead of guessing:

```markdown
​```claude-you
<!-- PASTE your prompt here. HINT: search the session for "why password" —
     it's the AskUserQuestion fork where you moved cluster access out of the subagent. -->
​```
```

- The hint should name a **searchable phrase** + a one-line locator ("around the spec
  review", "right after the first failing run").
- **If you ran the exporter**, point the hint at the exported note's turn heading
  (e.g. `[[<date>_<shortid>#▷ turn 7]]`) — the user can jump straight there and copy the
  block. This is the preferred hint form when a session note exists.
- If the transcript path is known but not exported, **grep it** for the candidate phrase and
  quote 3–6 words of the real line in the hint. Do **not** auto-paste the whole turn — the
  user explicitly wants to do the paste themselves.
- Where you *do* have the exact text from the current session context, fill it in directly
  and skip the hint.

## Step 5 — Build the Canvas

Write `<vault>/Notes/<demo-slug>/<Title>.canvas` (JSON). It lays the notes into the acts from
Step 1 with flow arrows, including the **loop-back edge** that makes "debug → fix → repeat"
visible. The full layout grid, node/edge schema, color codes, and a worked example are in
`references/canvas-layout.md` — read it before writing the canvas.

Key points: file paths in canvas nodes are **vault-relative** (`Notes/<slug>/NN-slug.md`);
canvas cards are styled by the snippet too; use a wide banner text node for the title and
section labels; give the debug→implement "fix & repeat" edge a distinct color.

The loop-back edge points from the "debug" beat back to the "implement"/"design" beat. If a
compact build has no dedicated debug node, attach it to whichever node represents the
"rerun / reconsider" moment (e.g. a wrong-pattern discovery → back to the design note).

## Step 6 — Hand off

Tell the user, concisely:
- where the folder + canvas are,
- to **open the `.canvas`** (and ensure the snippet is toggled on — Step 2.4),
- which notes still have **PASTE/HINT** placeholders to fill from the raw session,
- offer to adjust layout/wording/flow after they look.

## Notes on reuse

- Changing the look (terminal colors, title bar) is a one-line edit in
  `claude-session.css` — it updates every note and canvas card at once. Don't inline styles.
- This skill is generic across sessions; the `recal-e2e-demo` is just the first instance.
