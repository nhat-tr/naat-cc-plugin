# UML Visual Interview

Use this bounded runbook for a new UML Diagram. Do not read `visual-companion.md`, JSON schemas, generated Visual Shell assets, or renderer source on the normal path.

## Operating Budget

- Confirm the diagram kind and show a compact first diagram within 120 seconds.
- Use one bounded lower-tier evidence scout only when direct reconnaissance would exceed six relevant files.
- Verify 2-5 exact evidence ranges; do not delegate modeling decisions.
- Start with 5-10 elements. Deepen only after feedback.

## One Kind, Four Diagram Families

The `uml` Workspace Kind renders four standard UML diagram families from one self-describing compact Draft, compiled to a v2 Visual Document. Two layout backends do the spatial work:

- **ELK graph layout** — `component`, `state_machine`, `activity`.
- **Deterministic sequence layout** — `sequence` (lifelines and ordered messages; not ELK).

Every element — every container, node, edge, lifeline, message, and fragment — and every `points` claim on it is its own annotatable target, exactly like the Architecture Canvas.

## Author The Draft

Write one UML Draft under `$CLAUDE_SCRATCH_DIR/<repo>/brainstorm/`. It is self-describing via a top-level `kind: "uml"`; the compiler picks `diagram_kind` from there.

Use this complete compact grammar; the Draft is strict and allow-listed — fields not listed are rejected:

| Draft field | Required values | Optional values |
|---|---|---|
| Common top-level | `kind` (`"uml"`), `diagram_kind`, `work_id` (`work-YYYYMMDD-slug`), `title` | `evidence`: 0-100 of `{id, label}`; evidence ids use `EVD-*` |
| Every `id` | 1-120 characters, lowercase kebab case | none |

GRAPH kinds (`component` \| `state_machine` \| `activity`):

| Draft object | Required values | Optional values |
|---|---|---|
| Container | `id`, `label` | `container_kind` (defaults per diagram — see below); `parent_id` |
| Node | `id`, `label` | `node_kind` (defaults per diagram); `container_id`; `points`: up to 6 short claims |
| Edge | `id`, `source`, `target` | `label`; `relation` (defaults per diagram) |
| Direction | — | `direction`: `RIGHT`/`DOWN` (defaults per diagram) |

Legal `container_kind` and default per diagram: component → `package` (also `node`, `frame`); state_machine → `composite_state` (also `frame`); activity → `partition` (also `frame`).

Legal `node_kind` by diagram (default is the first listed):

- component: `component`, `interface`, `artifact`, `deployment_node`, `actor`, `use_case`
- state_machine: `state`, `initial`, `final`, `choice`, `junction`, `fork`, `join`, `terminate`, `history`
- activity: `action`, `initial`, `final`, `flow_final`, `decision`, `merge`, `fork`, `join`, `object`, `accept_event`, `send_signal`

Legal `relation` by diagram (default is the first listed): component → `dependency`, `assembly`, `delegation`, `realization`, `association`, `generalization`; state_machine → `transition`; activity → `control_flow`, `object_flow`.

Direction defaults: component → `RIGHT`; state_machine → `DOWN`; activity → `DOWN`.

SEQUENCE kind (`sequence`):

| Draft object | Required values | Optional values |
|---|---|---|
| Lifeline | `id`, `label` | `lifeline_kind` (default `participant`; also `actor`, `object`, `boundary`, `control`, `entity`, `database`); `points` |
| Message | `id`, `label`, `from`, `to` (lifeline ids) | `message_kind` (default `sync`; also `async`, `reply`, `create`, `destroy`, `self` — a `self` message requires `from === to`); `points` |
| Fragment | `id`, `label`, `fragment_kind`, `message_ids` | none — a combined fragment; `fragment_kind`: `alt`, `opt`, `loop`, `par`, `break`, `critical`, `ref` |

`points`: any node, lifeline, or message may carry up to 6 short claims (≤160 chars). Each renders as its own annotatable target with a derived id `<component-id>-p1`, `-p2`, … — the same claim-level feedback contract as the Architecture Canvas.

Do not add `version`, `workspace_kind`, `revision`, `frames`, `components`, `component_id`, `layout`, `camera`, `focus_targets`, `annotation_targets`, HTML, or style fields. The compiler derives and validates them.

### Component example

```json
{
  "kind": "uml",
  "diagram_kind": "component",
  "work_id": "work-20260723-checkout",
  "title": "Checkout component view",
  "containers": [{ "id": "checkout-svc", "label": "Checkout Service" }],
  "nodes": [
    { "id": "checkout-api", "label": "Checkout API", "container_id": "checkout-svc" },
    { "id": "payment-gateway", "label": "Payment Gateway", "node_kind": "interface" }
  ],
  "edges": [
    { "id": "api-to-payment", "label": "charges", "source": "checkout-api", "target": "payment-gateway" }
  ]
}
```

### State machine example

```json
{
  "kind": "uml",
  "diagram_kind": "state_machine",
  "work_id": "work-20260723-order",
  "title": "Order lifecycle",
  "nodes": [
    { "id": "start", "node_kind": "initial", "label": "Start" },
    { "id": "placed", "label": "Placed" },
    { "id": "shipped", "label": "Shipped" },
    { "id": "done", "node_kind": "final", "label": "Done" }
  ],
  "edges": [
    { "id": "place", "source": "start", "target": "placed" },
    { "id": "ship", "label": "ship", "source": "placed", "target": "shipped" },
    { "id": "close", "source": "shipped", "target": "done" }
  ]
}
```

### Activity example

```json
{
  "kind": "uml",
  "diagram_kind": "activity",
  "work_id": "work-20260723-refund",
  "title": "Refund approval flow",
  "nodes": [
    { "id": "start", "node_kind": "initial", "label": "Start" },
    { "id": "review", "label": "Review request" },
    { "id": "gate", "node_kind": "decision", "label": "Approved?" },
    { "id": "issue", "label": "Issue refund" },
    { "id": "deny", "label": "Deny" },
    { "id": "end", "node_kind": "final", "label": "End" }
  ],
  "edges": [
    { "id": "e1", "source": "start", "target": "review" },
    { "id": "e2", "source": "review", "target": "gate" },
    { "id": "e3", "label": "yes", "source": "gate", "target": "issue" },
    { "id": "e4", "label": "no", "source": "gate", "target": "deny" },
    { "id": "e5", "source": "issue", "target": "end" },
    { "id": "e6", "source": "deny", "target": "end" }
  ]
}
```

### Sequence example

```json
{
  "kind": "uml",
  "diagram_kind": "sequence",
  "work_id": "work-20260723-login",
  "title": "Login sequence",
  "lifelines": [
    { "id": "browser", "label": "Browser", "lifeline_kind": "actor" },
    { "id": "auth-api", "label": "Auth API" },
    { "id": "user-store", "label": "User Store", "lifeline_kind": "database" }
  ],
  "messages": [
    { "id": "submit", "label": "POST /login", "from": "browser", "to": "auth-api" },
    { "id": "lookup", "label": "find user", "from": "auth-api", "to": "user-store",
      "points": ["Looks up by normalized email, not raw input."] },
    { "id": "found", "label": "user row", "message_kind": "reply", "from": "user-store", "to": "auth-api" },
    { "id": "ok", "label": "200 session token", "message_kind": "reply", "from": "auth-api", "to": "browser" }
  ],
  "fragments": [
    { "id": "opt-mfa", "label": "if MFA enabled", "fragment_kind": "opt", "message_ids": ["lookup", "found"] }
  ]
}
```

## Present And Revise

Start the verified v2 Visual Session directly from the Draft:

```bash
node <skill-dir>/scripts/visual-session.cjs present --draft <uml-draft.json>
```

The draft is self-describing via its top-level `kind: "uml"`; this path does not require scaffold, start, or migrate. Keep the command in the foreground. For the graph kinds, `elk_preflight.status="ready"` proves the pinned layout engine produced finite geometry; the sequence kind renders with the deterministic client-side layout instead and skips ELK preflight. Neither proves the Visual Shell rendered — share `connection_url` only after browser control confirms `data-layout-status="ready"` and at least one visible UML element.

After feedback, edit the same Draft while preserving stable IDs, then publish it without manual Revision work — it reuses the live session in place:

```bash
node <skill-dir>/scripts/visual-session.cjs publish --draft <uml-draft.json>
```

`validate --draft <uml-draft.json>` runs the same compiler, semantic, and (for graph kinds) ELK checks without serving — use it after a targeted edit, before publishing.

## Receive Feedback

`feedback_delivery.mechanism` is `background_wait`; `wait_receiver: not_listening` means no wait has bound to the store yet.

Run one `visual-session.cjs wait --timeout-ms <ms>` **as a background task** and end your turn; when the user submits feedback the wait exits and you are re-invoked automatically. Use `drain` only for an explicit synchronous check. Do not poll status on a timer, start a second model, or ask the user to type in the terminal.

## Recovery

Only on failure, read the relevant recovery range in `visual-companion.md`. A render-preflight failure preserves the previous Visual Document. Do not simplify topology blindly; use the phase-specific compiler, semantic, or ELK error.
