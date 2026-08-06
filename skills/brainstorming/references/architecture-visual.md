# Architecture Visual Interview

Use this bounded runbook for a new Architecture Canvas. Do not read `visual-companion.md`, schemas, or generated shell assets on the normal path.

## Operating Budget

- Confirm the Core Anchor or show a compact first canvas within 120 seconds.
- Use one bounded lower-tier evidence scout only when direct reconnaissance would exceed six relevant files.
- Verify 2-5 exact evidence ranges; do not delegate architecture decisions.
- Start with 5-8 nodes and 2-3 viable Decision Options. Deepen only the selected direction after feedback.

## Author The Draft

Write one Architecture Draft under `$CLAUDE_SCRATCH_DIR/<repo>/brainstorm/` with intent-owned facts only: Work ID, title, Evidence References, boundaries, typed nodes and ports, edges, Scenario Paths, and optional Decisions.

Use this complete compact grammar; fields not listed are rejected:

| Draft object | Required values | Optional values |
|---|---|---|
| Every `id` | 1-120 characters, lower kebab case (`service-api`) | Evidence IDs use `EVD-name` |
| Boundary | `id`, `label` | `parent_id` |
| Node | `id`, `label`, `owner_id`, `ports` | `type`: `adapter`, `artifact`, `data_store`, `external_system`, `interface`, `service`, or `worker`; `modes`: always an array — `["current"]`, `["proposed"]`, or both; `change`: `added`/`modified`/`removed`/`unchanged`; `points`: up to 6 short claims |
| Port | `id`, `label`, `direction`: `input`/`output`, `kind`, `protocol` | none |
| Edge | `id`, `label`, `source`, `target` | `type`: `command`, `control`, `data`, `event`, or `evidence`; `modes` (array, as on nodes) |
| Scenario | `id`, `label`, `description`, both mode paths | none |
| Decision | `id`, `title`, 2-5 Options | `multiselect` |

**Scenario Path rules:** `node_ids` are stations in order; `edge_ids` the hops between — one fewer than `node_ids`. `edge_ids[i]` connects `node_ids[i]`→`node_ids[i+1]`. Every referenced node/edge must list the path's mode in its own `modes` (reuse for both `current`+`proposed` needs both listed). One linear walk only — split forks/branches into separate scenarios.

```json
{
  "work_id": "work-YYYYMMDD-slug",
  "title": "Review feedback delivery",
  "evidence": [{ "id": "EVD-001-runtime-trace", "label": "Observed runtime trace" }],
  "boundaries": [{ "id": "runtime", "label": "Runtime" }],
  "nodes": [
    { "id": "browser-client", "label": "Browser client", "owner_id": "runtime", "type": "interface", "ports": [{ "id": "feedback-output", "label": "Feedback", "direction": "output", "kind": "event", "protocol": "HTTP" }] },
    { "id": "agent-session", "label": "Agent Session", "owner_id": "runtime", "type": "service", "ports": [{ "id": "feedback-input", "label": "Feedback", "direction": "input", "kind": "event", "protocol": "HTTP" }, { "id": "archive-output", "label": "Out", "direction": "output", "kind": "event", "protocol": "HTTP" }] },
    { "id": "audit-log", "label": "Audit Log", "owner_id": "runtime", "type": "data_store", "modes": ["proposed"], "ports": [{ "id": "archive-input", "label": "In", "direction": "input", "kind": "event", "protocol": "HTTP" }] }
  ],
  "edges": [
    { "id": "feedback-delivery", "label": "Feedback delivery", "source": { "node_id": "browser-client", "port_id": "feedback-output" }, "target": { "node_id": "agent-session", "port_id": "feedback-input" } },
    { "id": "session-archive", "label": "Archive", "modes": ["proposed"], "source": { "node_id": "agent-session", "port_id": "archive-output" }, "target": { "node_id": "audit-log", "port_id": "archive-input" } }
  ],
  "scenarios": [{
    "id": "submit-feedback",
    "label": "Submit feedback",
    "description": "Deliver feedback to Agent Session; proposed also archives it.",
    "paths": {
      "current": { "node_ids": ["browser-client", "agent-session"], "edge_ids": ["feedback-delivery"] },
      "proposed": { "node_ids": ["browser-client", "agent-session", "audit-log"], "edge_ids": ["feedback-delivery", "session-archive"] }
    }
  }],
  "decisions": [{
    "id": "feedback-receiver",
    "title": "Choose the feedback receiver",
    "options": [
      { "id": "channel-delivery", "label": "Channel delivery" },
      { "id": "foreground-wait", "label": "Foreground Wait" },
      { "id": "queued-recovery", "label": "Queued recovery" }
    ]
  }]
}
```

Do not add `version`, `workspace_kind`, `revision`, `frames`, `components`, `component_id`, layout, camera, focus, annotation, feedback, HTML, or style fields. The compiler derives and validates them.

## Validate, Then Present

`validate` runs the same compiler, semantic, and ELK checks without a server — most first-present failures (broken scenario walks, non-array `modes`) die here for one cheap retry:

```bash
node <skill-dir>/scripts/visual-session.cjs validate --draft <architecture-draft.json>
node <skill-dir>/scripts/visual-session.cjs present --draft <architecture-draft.json>
```

This path does not require scaffold, start, or migrate. **The first `present` becomes the server and does not exit** — run it via the harness background-command mechanism and retain the handle; a blocking foreground `present` dies at the ~2-minute shell timeout. A live session makes later `present`/`publish` quick foreground calls that reuse it in place. `elk_preflight.status="ready"` proves finite layout geometry, not a rendered shell — share `connection_url` only after browser control confirms `data-layout-status="ready"` and one visible node.

After feedback, apply targeted edits to the same Draft preserving stable IDs, validate, then publish without manual Revision work:

```bash
node <skill-dir>/scripts/visual-session.cjs publish --draft <architecture-draft.json>
```

## Receive Feedback

Run one `visual-session.cjs wait --timeout-ms <ms>` **as a background task** and end your turn; when the user submits feedback the wait exits and you are re-invoked automatically (`wait_receiver: not_listening` in status just means no wait is bound yet). Use `drain` only for an explicit synchronous check. Do not poll status on a timer, start a second model, or ask the user to type in the terminal.

## Recovery

On failure only, read the recovery range in `visual-companion.md`. A render-preflight failure preserves the previous Visual Document; fix the phase-specific compiler, semantic, or ELK error rather than blindly simplifying topology.
