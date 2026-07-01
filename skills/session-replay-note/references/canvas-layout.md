# Canvas layout — schema, grid, and worked example

The `.canvas` file is JSON with two arrays: `nodes` and `edges`. It lays the atomic notes
into the acts from the interview, with flow arrows between them. Read this before writing
the canvas, then adapt the grid to the actual number of notes.

## Node types

**File node** — embeds an atomic note as a card:
```json
{"id":"p1","type":"file","file":"Notes/<slug>/02-phase1.md","x":0,"y":480,"width":700,"height":360}
```
- `file` is **vault-relative** (starts with `Notes/…`), not absolute.
- Card content is styled by the `claude-session.css` snippet (Reading-view rules apply to
  canvas cards), so ```claude / ```claude-you blocks render as terminal panes here too.

**Text node** — title banners and section labels:
```json
{"id":"title","type":"text","text":"# My session — a 1.5 h replay\n\n*design → implement → debug → repeat*","x":0,"y":-240,"width":2220,"height":140}
```
- Use one wide banner for the title and one per act label (e.g. `### ①  Design → Implement`).

## Edge schema

```json
{"id":"e1","fromNode":"loop","toNode":"p1","fromSide":"bottom","toSide":"top","label":"design"}
```
- `fromSide`/`toSide` ∈ `top|bottom|left|right`.
- Optional `label` annotates the arrow ("run it", "debug", "fix & repeat", "takeaways").
- Optional `color`: `"1"` red · `"2"` orange · `"3"` yellow · `"4"` green · `"5"` cyan · `"6"` purple.
  Give the **loop-back edge** (debug → implement) a distinct color (`"4"` green in the
  reference) so "fix & repeat" reads as a loop, not a dead end.

## Grid

A clean three-column grid, top-to-bottom by act:

- **Columns:** x = `0`, `760`, `1520`. Cards `width: 700`. (gap 60)
- **Full-width banners** (title, act labels, intro/outcome): `width: 2220`, x = `0`.
- **Rows:** advance `y` by roughly `card height + ~120` between rows; leave ~`100` under an
  act label before its first card.
- Act-label text nodes: `height: 56`, placed ~`100` above their row.
- Card heights: size to content (300–460 typical); give text-heavy example cards more.

## Worked example (the reference build)

Layout that shipped for `recal-e2e-demo` (14 notes, 4 acts):

| Act | Notes (cards) | Row y |
|-----|---------------|-------|
| title banner | `title` | -240 |
| Overview row | `00-loop`, `01-equip` | 0 |
| ① Design → Implement | `02-phase1`, `03-phase2`, `04-phase3` | 480 |
| ② Act II (intro banner + 3 examples) | `05-act2-intro`; `06/07/08-example-a/b/c` | 1010 / 1220 |
| ③ Debug loop | `09-debug-funnel` (wide) | 1840 |
| ④ Judgment & outcome | `10-forks`, `11-stop`, `12-curriculum`; `13-outcome` (wide) | 2460 / 2960 |

Flow edges: `title→loop`; `loop→p1 (design)`; `p1→p2→p3`; `p3→act2 (run it)`;
`act2→exA/exB/exC`; `exC→funnel (debug)`; **`funnel→p3 (fix & repeat, color "4")`** — the
loop-back; `funnel→forks`; `forks→stop`; `stop→outcome`; `outcome→curriculum (takeaways)`.

## Minimal skeleton to start from

```json
{
  "nodes": [
    {"id":"title","type":"text","text":"# <Title>\n\n*<subtitle>*","x":0,"y":-240,"width":2220,"height":140},
    {"id":"lbl-1","type":"text","text":"### ①  <Act 1>","x":0,"y":0,"width":2220,"height":56},
    {"id":"n0","type":"file","file":"Notes/<slug>/00-first.md","x":0,"y":100,"width":700,"height":340}
  ],
  "edges": [
    {"id":"e0","fromNode":"title","toNode":"n0","fromSide":"bottom","toSide":"top"}
  ]
}
```
