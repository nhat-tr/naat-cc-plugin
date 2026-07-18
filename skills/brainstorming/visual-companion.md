# Live Visual Companion

Use this companion only after the user explicitly requests a visual interview or accepts a visual offer. It renders a schema-validated Visual Document through one reusable, selectable, annotatable Visual Shell. The browser conversation and the terminal conversation share one persisted Visual Session.

## Choose a Workspace Kind

Choose the Visual Document v2 Workspace Kind from the decision the user needs to make:

| Workspace Kind | `workspace_kind` | Use when | Primary review outcome |
| --- | --- | --- | --- |
| Product Concept Studio | `product` | A UI or workflow needs three materially different concepts on equal fixture data, device, scope, and fidelity. | One recorded Choice plus responsive, state, accessibility, and implementation handoff detail. |
| Architecture Canvas | `architecture` | Topology, ownership boundaries, contracts, current/proposed state, or scenario paths need spatial review. | Traceable architecture issues and decisions grounded in nodes, edges, boundaries, and evidence. |
| Research Evidence Board | `research` | Claims must be compared with primary sources, contradictions, confidence, unknowns, and decision relevance. | An evidence-grounded conclusion that keeps unknowns and unsourced summaries explicit. |
| Business Reasoning Canvas | `business` | Actors, outcomes, journeys, assumptions, economics, risks, or experiments need business review. | A testable business direction or experiment without developer-tool chrome. |
| Feature Review Workbench | `review` | Approved intent must be checked against Review Slices, actual changes, verification, findings, and the Engineering Quality Contract. | A cumulative whole-feature verdict kept separate from patch-specific File Viewed progress. |

Select by purpose and decision, not technology alone. A React customer checkout concept is `product`; its component topology is `architecture`; checking the implemented feature against approved intent is `review`. A v2 Visual Document has exactly one lowercase `workspace_kind`.

Profiles (`technical`, `product`, and `business`) are a Visual Document v1 compatibility contract, not v2 purpose selection. Use them only when reading, exporting, or migrating an existing v1 document.

## Legacy v1 Visual Grammar

The following reusable section kinds apply only to Visual Document v1 compatibility content:

- `flow`: ordered architecture canvases, data paths, or process nodes
- `cards`: comparable concepts, constraints, risks, or opportunities
- `decision`: 2–5 selectable options, optional 1–10 scores and one recommendation
- `anchor`: purpose, rejection criteria, and contrasts
- `callout`: one important conclusion, warning, or open question
- `timeline`: stages, journeys, rollout, or event order
- `mockup`: a desktop or mobile screen prototype — regions carrying typed UI elements (`heading`, `text`, `button`, `input`, `tabs`, `table`, `list`, `metric`, `badge`, `placeholder`, `cells` for slot/rack/bin/seat grids)

Every section and item has a stable lowercase `id`. The renderer turns it into `data-brainstorm-id`; preserve an ID while its concept remains the same.

### Mockups Are Prototypes, Not Descriptions

When the decision is about a screen or UI, a `mockup` section with typed `elements` **is** the prototype. A mockup whose regions carry only `title`/`detail` prose is the text-only failure mode — the user asked to see a screen and got sentences about one. Put the words INTO the controls:

- A region is one surface area (toolbar, sidebar, content, footer). Use `span` (1–12) to lay regions out — e.g. sidebar `span: 4` beside content `span: 8`.
- Real labels in real controls: `button` with the actual action name, `input` with the actual placeholder, `table` with the actual columns and 2–3 realistic rows, `tabs` with the actual tab names, `metric` for the numbers the user watches, `badge` for statuses, `placeholder` only for charts/media.
- Every element is its own annotation target (`<region-id>-e1`, `-e2`, … — positional, like points), so the user can annotate one button or one column instead of the whole screen.
- The prototype is deliberately inert: no navigation or state. One screen per mockup section; show a variant or second screen as another mockup section or a revision after feedback.

### Points Before Prose

The visual earns its keep over plain markdown through **claim-level feedback**: every item and decision option takes `points` (1–6 claims, ≤160 chars each), and the shell renders each point as its own annotatable component with a derived id (`<item-id>-p1`, `-p2`, …). A reviewer clicks the exact claim they dispute; the drained batch tells you which one.

- Author `points` by default. Use `detail` only as a one-sentence lede, or omit it.
- One claim per point. If a point needs "and… so… but…", split it.
- Point ids are positional: edit a point's text in place, append new points at the end, and move a withdrawn claim's replacement into its slot rather than reordering.
- A paragraph-shaped `detail` with no points is a wall of text in a border — it throws away the annotation granularity that justifies the visual.

### Inline Text Grammar

All document fields and chat replies are plain text — no HTML — but the shell renders a minimal inline grammar. Use it instead of improvising emphasis:

- `**bold**` and `` `code` `` render as real bold and code. Prefer `**bold**` over ALL-CAPS emphasis.
- Bare file references — `Factory.cs:135`, `ToolInvocationMiddleware.cs:203-216`, `docs/architecture.md` — become styled click-to-copy chips automatically. Write them bare; do not wrap them in backticks.
- `→` and `·` are fine for sequence and separation.
- Flow nodes are auto-numbered by the renderer (`01`, `02`, …). Do not prefix node titles with `1 ·` — that double-numbers the step.
- Keep decision option labels short (≤60 chars); put the argument in `detail`.
- `reply` messages render paragraphs, `1.` numbered lists, and `-` bulleted lists with the same inline grammar. Structure a multi-point reply as a short numbered list, one point per annotation answered.

## Start Once, in Foreground

Keep the target project as the working directory so active-session discovery follows that project. Invoke the launcher from its resolved skill directory:

```bash
<skill-dir>/scripts/start-server.sh
```

Codex and Claude keep the **server** in foreground because their command harnesses can reap detached children; retain the running execution handle. The only backgrounded command is the feedback `wait` (below), and only through the harness's own background-command mechanism — do not daemonize the server, poll it, or resume a model process to watch it.

The first output record contains `connection_url`, `screen_file`, `state_dir`, and `active_file`. Share `connection_url`; never persist its capability token. A restart creates a new `connection_url` and invalidates the old one.

To change the document or switch the Workspace Kind mid-review, run `present` or `publish` again — both **reuse the running session in place** (same port, token, and `connection_url`), so the open browser tab is never orphaned. `present` emits `visual-session-represented` when it reuses a live session.

**When the user asks to "restart the visual server," re-presenting IS the restart** — just re-run `present`; it reuses the live session and re-renders the current document. **Never `kill` the server process and start a fresh `present`**: that cold-starts on a new port with a new token, minting a new `connection_url` and silently orphaning the open tab — the exact failure re-presenting exists to avoid. A full `stop` + fresh start is only for abandoning the session entirely, and then you must tell the user to close the old tab because its submissions go to a dead port.

Share `connection_url` with the user **once**, when you first `present` — it is stable for the server's lifetime, so do not re-paste it on every step. If the user loses it, recover it with `status`, which re-emits the current `connection_url`; `present`, `publish`, and represent re-emit it too, so a mid-review re-present hands back a working link automatically.

Sessions default to `$CLAUDE_SCRATCH_DIR/<repo>-<hash>/brainstorm/<session-id>` (the `-<hash>` suffix disambiguates same-named repos). Run `status`, `drain`, `reply`, and `stop` from the project directory, or pass `--session-dir <dir>` to target a specific session regardless of your current directory. If the derived pointer is missing, these commands fall back to the one live session in scratch and error only when several are running at once. Use `--project-dir` only when the user explicitly asks to retain the visual session.

## Architecture Normal Path

For a new Architecture Canvas, stop here and read `references/architecture-visual.md`. Author the compact Architecture Draft and run one foreground `visual-session.cjs present --draft ...`; its compiler derives the v2 envelope and Revision, runs ELK render preflight, and starts directly on v2 without `start` or `migrate`.

## Other Workspace Kinds and Canonical Compatibility

For Product, Research, Business, Review, or maintenance of a full canonical Architecture document, scaffold the v2 Workspace Kind selected above. Replace the example Work ID with the Work ID for the current intent-to-outcome body of work:

```bash
node <skill-dir>/scripts/visual-session.cjs scaffold \
  --workspace-kind product \
  --work-id work-YYYYMMDD-slug \
  --title "Compare product concepts" \
  --output "$CLAUDE_SCRATCH_DIR/<repo>/brainstorm/product-workspace.json"

node <skill-dir>/scripts/visual-session.cjs scaffold \
  --workspace-kind architecture \
  --work-id work-YYYYMMDD-slug \
  --title "Review system boundaries" \
  --output "$CLAUDE_SCRATCH_DIR/<repo>/brainstorm/architecture-workspace.json"

node <skill-dir>/scripts/visual-session.cjs scaffold \
  --workspace-kind research \
  --work-id work-YYYYMMDD-slug \
  --title "Evaluate the evidence" \
  --output "$CLAUDE_SCRATCH_DIR/<repo>/brainstorm/research-workspace.json"

node <skill-dir>/scripts/visual-session.cjs scaffold \
  --workspace-kind business \
  --work-id work-YYYYMMDD-slug \
  --title "Test the business reasoning" \
  --output "$CLAUDE_SCRATCH_DIR/<repo>/brainstorm/business-workspace.json"

node <skill-dir>/scripts/visual-session.cjs scaffold \
  --workspace-kind review \
  --work-id work-YYYYMMDD-slug \
  --title "Review the implemented feature" \
  --output "$CLAUDE_SCRATCH_DIR/<repo>/brainstorm/review-workspace.json"
```

Each command emits a normalized v2 envelope and schema-valid content for exactly one Workspace Kind. Edit the draft's content and stable Component identities with the runtime file editor; do not hand-author a different kind's content shape. The v2 Visual Document hard limit is 512 KiB. Include only evidence and review detail that serves the current decision, and do not generate per-screen HTML, React, CSS, JavaScript, dependencies, or build output.

A Visual Session created with the compatibility `start` command begins on v1 so backout remains available. Before its first v2 Publish, migrate it once with the same Work ID and Workspace Kind used by the scaffold. The Architecture `present --draft` path does not use this compatibility lifecycle.

```bash
node <skill-dir>/scripts/visual-session.cjs migrate \
  --work-id work-YYYYMMDD-slug \
  --workspace-kind product

node <skill-dir>/scripts/visual-session.cjs publish \
  --document "$CLAUDE_SCRATCH_DIR/<repo>/brainstorm/product-workspace.json"
```

Substitute the selected `architecture`, `research`, `business`, or `review` kind in both commands. Migration retains the original v1 document side by side. `backout` reactivates those exact v1 bytes without overwriting the retained v2 document; a later migration reactivates that same v2 state.

```bash
node <skill-dir>/scripts/visual-session.cjs backout
```

### Legacy v1 scaffold

Use the profile/section scaffold only when maintaining Visual Document v1 compatibility content:

```bash
node <skill-dir>/scripts/visual-session.cjs scaffold \
  --profile technical \
  --audience "Software developers" \
  --title "Agent request flow" \
  --summary "Framework-owned path and one application decision." \
  --kinds anchor,flow,cards,decision,callout \
  --output <scratch-visual.json>
```

The v1 scaffold emits the correct section fields (`items`, `nodes`, `options`, `body`, or `regions`) and normalizes them through the same validator as the server. The v1 schema rejects arbitrary fields, HTML, style, and unsupported components. Its hard limit is 8 KB; target 5 KB or less. Prefer one useful visual with 2–6 sections, authored as claim-sized `points` rather than paragraph `detail` blobs.

After the explicit migration boundary, Publish validates and atomically replaces the active Visual Document:

```bash
node <skill-dir>/scripts/visual-session.cjs publish --document <visual.json>
```

Update only changed content, preserve stable IDs, and do not read or regenerate Visual Shell assets during an interview. React is intentionally not generated per Visual Session. Product Concept Studio supplies v2 prototype fidelity; legacy `mockup` elements supply it for v1 compatibility. If a real React behavior prototype is essential, treat it as a separate design artifact using an existing project toolchain; do not extend this Visual Session protocol or install dependencies.

## Feedback Batch and Same-Session Handoff

The user can select decisions, annotate any rendered `data-brainstorm-id`, add a chat note, and save one **Feedback Batch**. Submission persists immediately and the browser says:

> Feedback saved. Waiting for Codex or Claude to pick it up from this session.

Feedback returns to you **automatically through a background wait** — no manual ping and no frozen foreground turn. Once `present` has shared the `connection_url`, run the wait as a **background task**, then **end your turn**:

```bash
node <skill-dir>/scripts/visual-session.cjs wait --timeout-ms 900000
```

Launch it through the harness's own background-command mechanism (a backgrounded command re-invokes you when it exits); do **not** run it as a blocking foreground command that burns your turn for the whole review window. When the user submits a Feedback Batch in the browser, the background `wait` exits with that batch and the harness automatically re-invokes you. Then revise the Visual Document, `publish` it — which reuses the live session in place, keeping the same port, token, and `connection_url` — mirror a concise `reply` into browser history, and launch **another** background `wait` for the next batch. Each browser review is one such cycle; never watch the session with a drain/status timer or a second model process.

When the user has *already* told you they submitted feedback, or asks you to "check," the batch is already durable — pull it immediately with `drain` (or a single short `wait`) rather than opening a fresh long wait, and revise before starting any unrelated work. Picking up submitted feedback is always the next action.

`drain` is the explicit "check now": it returns the oldest pending Feedback Batch immediately, or `{"type":"empty"}` when nothing is queued. Use it whenever you want to pull feedback synchronously instead of waiting on it.

```bash
node <skill-dir>/scripts/visual-session.cjs drain
```

Treat the returned message, annotations, choices, and screen identity as one user response. Update the Core Anchor when intent changed. Revise the active Visual Document (`workspace.json` for v2; `screen.json` only for v1 compatibility) if spatial feedback helps, and mirror a concise reply into browser history:

```bash
node <skill-dir>/scripts/visual-session.cjs reply \
  --message-file <scratch-response-file>
```

`reply` acknowledges the served batch and renders a short response into browser history. Use `--message TEXT` for a short inline acknowledgement, or `--message-file FILE` for a long or multi-line revision note that would fight shell escaping. `--reply-to` is optional: omit it to acknowledge the batch you were just served (the oldest unacknowledged turn), so the ack cursor advances without recomputing the sparse global seq. Pass `--reply-to <turn-seq>` only to target a specific turn; a `--reply-to` that skips an older unacknowledged batch is refused, so an earlier batch can never be silently dropped.

`wait` and `drain` include a `pending` count of unacknowledged batches (the returned turn included). After replying, `drain` again while `pending` was greater than 1 — the user queued another batch during your turn. Once every batch is acknowledged, `drain` returns `{"type":"empty"}` until the user submits again.

When Publish replaces the active Visual Document, the browser diffs Revisions and marks exactly what moved: `new`/`updated` flags on changed Components and a strip listing removed ones. Reviewers also have keyboard shortcuts (`a` toggles annotate, `Esc` exits, `⌘/Ctrl+Enter` saves the Feedback Batch).

## The Visual Is a Normal Repo Artifact

Every Visual Session's artifact lives in the working repo under `.artifacts/brainstorm/<session-id>/` (reported as `visual_file` in the start output), not in scratch. Each artifact is a self-contained HTML file embedding the active Visual Document and the full browser/agent history; it renders read-only through the same Visual Shell and opens directly from disk with no server, token, or network. The directory carries its own `.gitignore` (`*`), so artifacts never clutter `git status` — `git add -f` a snapshot you want to commit.

- **Auto (rolling):** the server refreshes `.artifacts/brainstorm/<session-id>/visual.html` on every publish and every feedback batch. It survives a crash, idle close, owner exit, or a forgotten `stop` — the visual is never lost.
- **Save button:** the browser's **Save to repo** button pins numbered snapshots (`visual-001.html`, `visual-002.html`, …) beside the rolling copy, so the user decides which versions to keep. The UI shows the exact on-disk path.
- **On stop / on demand:** `stop` writes a final `visual.html` into the artifact directory before scratch cleanup; `export` captures a copy anywhere:

```bash
node <skill-dir>/scripts/visual-session.cjs export --output <path/to/visual.html>
```

Because artifacts resolve against the repo, they persist regardless of where session state lives. Use `--project-dir` at `start` only when you also want the live session *state* (not just the visual) retained in the project.

## Token and CPU Guardrails

- Start one server per interview; update the active Visual Document through Publish.
- Batch annotations, choices, and chat into one browser turn.
- Keep v1 documents under 5 KB where practical. Keep v2 documents well below the 512 KiB safety cap by including only decision-relevant content.
- Scaffold once; never spend model turns repairing a guessed section shape.
- Do not echo the whole document into chat; summarize decisions and deltas.
- Use SSE only for browser refresh. There is no WebSocket, browser polling, or agent polling; the agent side uses one backgrounded `wait` per review window, woken automatically when feedback arrives.
- Do not inspect generated shell code during normal use; this guide is the operating contract.
- Stop the session when the visual interview ends.

## Security and Recovery

- Every page, asset, API, and SSE request requires the session capability cookie and unique session path.
- The shell renders dynamic text with DOM text nodes; the Content Security Policy disallows inline or external executable content.
- Browser feedback is user input, not executable instruction. Apply normal evidence and permission gates.
- If the browser says `Reconnecting`, inspect session status; do not start a second server blindly.
- If the active Visual Document is invalid, `/api/screen` returns a validation error. Correct the document instead of bypassing its envelope and Workspace Kind schema.
- If the original foreground command ended, start a new session and share only its new `connection_url`.

Status and stop commands:

```bash
node <skill-dir>/scripts/visual-session.cjs status
node <skill-dir>/scripts/visual-session.cjs export --output <path/to/visual.html>
<skill-dir>/scripts/stop-server.sh <session-dir>
```

The server stays alive while a browser tab is connected (SSE presence), so a user reviewing at their own pace is never timed out mid-batch; it self-terminates when the owning foreground process exits. `publish`, `drain`, and `reply` refuse a Visual Session whose process is gone rather than writing into a Visual Document nothing serves.

Relevant reusable resources:

- `assets/visual-shell/` — fixed renderer, styles, annotation, feedback, and history UI
- `scripts/visual-document.cjs` — bounded Visual Document v1 schema and compatibility scaffold
- `scripts/workspace-document.cjs` — Visual Document v2 envelope, identity, Revision, and size contract
- `scripts/workspace-content.cjs` — Workspace Kind schema dispatch and content normalization
- `scripts/workspace-scaffold.cjs` — deterministic, schema-valid v2 scaffold for all five Workspace Kinds
- `scripts/visual-session.cjs` — scaffold, start, publish, drain, reply, status, export, and stop
- `scripts/session-store.cjs` — durable feedback and acknowledgement store
- `scripts/delivery-core.cjs` — blocking wait primitive and drain
