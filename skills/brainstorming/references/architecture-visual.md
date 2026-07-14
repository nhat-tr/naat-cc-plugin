# Architecture Visual Interview

Use this bounded runbook for a new Architecture Canvas. Do not read `visual-companion.md`, JSON schemas, generated Visual Shell assets, or renderer source on the normal path.

## Operating Budget

- Confirm the Core Anchor or show a compact first canvas within 120 seconds.
- Use one bounded lower-tier evidence scout only when direct reconnaissance would exceed six relevant files.
- Verify 2-5 exact evidence ranges; do not delegate architecture decisions.
- Start with 5-8 nodes and 2-3 viable Decision Options. Deepen only the selected direction after feedback.

## Author The Draft

Write one Architecture Draft under `$CLAUDE_SCRATCH_DIR/<repo>/brainstorm/`. It contains intent-owned facts only: Work ID, title, Evidence References, ownership boundaries, typed nodes and ports, edges, Scenario Paths, and optional Decisions.

Use this complete compact grammar; fields not listed are rejected:

| Draft object | Required values | Optional values |
|---|---|---|
| Every `id` | 1-120 characters, lower kebab case (`service-api`) | Evidence IDs use `EVD-name` |
| Boundary | `id`, `label` | `parent_id` |
| Node | `id`, `label`, `owner_id`, `ports` | `type`: `adapter`, `artifact`, `data_store`, `external_system`, `interface`, `service`, or `worker`; `modes`: `current`/`proposed`; `change`: `added`/`modified`/`removed`/`unchanged`; `points`: up to 6 short claims |
| Port | `id`, `label`, `direction`: `input`/`output`, `kind`, `protocol` | none |
| Edge | `id`, `label`, `source`, `target` | `type`: `command`, `control`, `data`, `event`, or `evidence`; `modes` |
| Scenario | `id`, `label`, `description`, both mode paths | none |
| Decision | `id`, `title`, 2-5 Options | `multiselect` |

```json
{
  "work_id": "work-YYYYMMDD-slug",
  "title": "Review feedback delivery",
  "evidence": [{ "id": "EVD-001-runtime-trace", "label": "Observed runtime trace" }],
  "boundaries": [{ "id": "runtime", "label": "Runtime" }],
  "nodes": [
    {
      "id": "browser-client",
      "label": "Browser client",
      "owner_id": "runtime",
      "type": "interface",
      "ports": [{ "id": "feedback-output", "label": "Feedback", "direction": "output", "kind": "event", "protocol": "HTTP" }]
    },
    {
      "id": "agent-session",
      "label": "Agent Session",
      "owner_id": "runtime",
      "type": "service",
      "ports": [{ "id": "feedback-input", "label": "Feedback", "direction": "input", "kind": "event", "protocol": "HTTP" }]
    }
  ],
  "edges": [{
    "id": "feedback-delivery",
    "label": "Feedback delivery",
    "type": "event",
    "source": { "node_id": "browser-client", "port_id": "feedback-output" },
    "target": { "node_id": "agent-session", "port_id": "feedback-input" }
  }],
  "scenarios": [{
    "id": "submit-feedback",
    "label": "Submit feedback",
    "description": "Deliver browser feedback to the same Agent Session.",
    "paths": {
      "current": { "node_ids": ["browser-client", "agent-session"], "edge_ids": ["feedback-delivery"] },
      "proposed": { "node_ids": ["browser-client", "agent-session"], "edge_ids": ["feedback-delivery"] }
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

## Present And Revise

Start the verified v2 Visual Session directly from the Draft:

```bash
node <skill-dir>/scripts/visual-session.cjs present --draft <architecture-draft.json>
```

This path does not require scaffold, start, or migrate. Keep the command in the foreground. `elk_preflight.status="ready"` proves the pinned layout engine produced finite geometry; it does not prove the Visual Shell rendered. Share `connection_url` only after browser control confirms `data-layout-status="ready"` and at least one visible Architecture node.

After feedback, edit the same Draft while preserving stable IDs, then publish it without manual Revision work:

```bash
node <skill-dir>/scripts/visual-session.cjs publish --draft <architecture-draft.json>
```

## Receive Feedback

Read `feedback_delivery` truthfully. `automatic: codex_idle_worker` means that worker started; `not_probed` is not a connection claim. `wait_receiver: not_listening` means no blocking receiver was observed yet.

Use an injected Claude Channel delivery when it arrives. Otherwise use one callable `wait_for_feedback` request or one foreground CLI Wait. Never run Wait in the background, poll status, start a second model, or ask the user to type in the terminal.

## Recovery

Only on failure, read the relevant recovery range in `visual-companion.md`. A render-preflight failure preserves the previous Visual Document. Do not simplify topology blindly; use the phase-specific compiler, semantic, or ELK error.
