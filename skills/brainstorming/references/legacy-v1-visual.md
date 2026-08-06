# Legacy Visual Document v1 Compatibility

Read this only when maintaining an existing Visual Document v1 session (`screen.json`) or importing one. New work always uses a v2 Workspace Kind (`workspace.json`) or an Architecture/UML Draft — see `visual-companion.md`.

## v1 Section Kinds

The following reusable section kinds apply only to Visual Document v1 content:

- `flow`: ordered architecture canvases, data paths, or process nodes
- `cards`: comparable concepts, constraints, risks, or opportunities
- `decision`: 2–5 selectable options, optional 1–10 scores and one recommendation
- `anchor`: purpose, rejection criteria, and contrasts
- `callout`: one important conclusion, warning, or open question
- `timeline`: stages, journeys, rollout, or event order
- `mockup`: a desktop or mobile screen prototype — regions carrying typed UI elements (`heading`, `text`, `button`, `input`, `tabs`, `table`, `list`, `metric`, `badge`, `placeholder`, `cells` for slot/rack/bin/seat grids)

Every section and item has a stable lowercase `id`. The renderer turns it into `data-brainstorm-id`; preserve an ID while its concept remains the same.

### v1 Mockups Are Prototypes, Not Descriptions

When the decision is about a screen, a `mockup` section with typed `elements` **is** the prototype. A mockup whose regions carry only `title`/`detail` prose is the text-only failure mode. Put the words INTO the controls:

- A region is one surface area (toolbar, sidebar, content, footer). Use `span` (1–12) to lay regions out — e.g. sidebar `span: 4` beside content `span: 8`.
- Real labels in real controls: `button` with the actual action name, `input` with the actual placeholder, `table` with the actual columns and 2–3 realistic rows, `tabs` with the actual tab names, `metric` for the numbers the user watches, `badge` for statuses, `placeholder` only for charts/media.
- Every element is its own annotation target (`<region-id>-e1`, `-e2`, … — positional), so the user can annotate one button or one column.
- The prototype is deliberately inert: no navigation or state. One screen per mockup section; show a variant as another mockup section or a revision after feedback.

## v1 Scaffold

```bash
node <skill-dir>/scripts/visual-session.cjs scaffold \
  --profile technical \
  --audience "Software developers" \
  --title "Agent request flow" \
  --summary "Framework-owned path and one application decision." \
  --kinds anchor,flow,cards,decision,callout \
  --output <scratch-visual.json>
```

Profiles (`technical`, `product`, `business`) are a v1 contract only. The v1 scaffold emits the correct section fields (`items`, `nodes`, `options`, `body`, or `regions`) and normalizes them through the same validator as the server. The v1 schema rejects arbitrary fields, HTML, style, and unsupported components. Its hard limit is 8 KB; target 5 KB or less.

## Migrating a v1 Session to v2

A Visual Session created with the compatibility `start` command begins on v1 so backout remains available. Before its first v2 Publish, migrate it once with the same Work ID and Workspace Kind a v2 scaffold would use:

```bash
node <skill-dir>/scripts/visual-session.cjs migrate \
  --work-id work-YYYYMMDD-slug \
  --workspace-kind product

node <skill-dir>/scripts/visual-session.cjs publish \
  --document "$CLAUDE_SCRATCH_DIR/<repo>/brainstorm/product-workspace.json"
```

Migration retains the original v1 document side by side. `backout` reactivates those exact v1 bytes without overwriting the retained v2 document; a later migration reactivates that same v2 state:

```bash
node <skill-dir>/scripts/visual-session.cjs backout
```

Feedback batches recorded from a v1 document carry `null` for the v2 annotation context fields (`componentId`, `tabId`, `frameId`); fall back to matching the `label` across the served document.
