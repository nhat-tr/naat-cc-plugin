---
description: Generate or update the observability index for the current project.
---

Generate or update the observability index for the current project.

## Generate

Run:

```bash
observability-index --root .
```

This writes:
- `.observability/logs.json`
- `.observability/traces.json`

After it finishes, report:
- how many log entries and trace entries were written
- which config was used
- any warnings printed to stderr

## Optional Enrichment

If the user explicitly asks for caller/callee enrichment and the index already exists, follow `skills/observability-index/SKILL.md` Mode 2. Do not block basic generation on embedcode availability.
