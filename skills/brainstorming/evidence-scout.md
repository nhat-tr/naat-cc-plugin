# Bounded Evidence Scout

Use one lower-tier scout only when repository reconnaissance would otherwise flood the main conversation. Small or already-localized work stays with the coordinator.

## Contract

The scout is an ephemeral, read-only evidence compressor:

- Codex defaults to `gpt-5.4-mini` with low effort.
- Claude defaults to Haiku with low effort.
- The brief is at most 4 KB; the evidence packet is at most 6 KB.
- Citations must resolve to observed repository files and exact ranges of at most 12 lines.
- Editing, delegation, web research, architecture recommendations, and automatic runtime fallback are forbidden.
- The command prints metadata and usage only; raw worker events stay outside the main conversation.

Do not retry with another model automatically. On failure, use one bounded direct inspection and report the missing evidence.

## Write a Compact Brief

Write the brief under `$CLAUDE_SCRATCH_DIR/<repo>/brainstorm/`. Include only the confirmed purpose, target paths or symbols, load-bearing questions, and constraints. Never copy the full transcript.

```json
{
  "version": 1,
  "purpose": "Determine which agent lifecycle behavior the installed framework already owns.",
  "targets": ["src/AgentSession.cs", "AgentSessionFactory", "project.assets.json"],
  "questions": [
    "Where is the session created?",
    "Which lifecycle behavior is already provided?"
  ],
  "constraints": [
    "Report observations and unknowns only; do not propose architecture."
  ]
}
```

## Run Once

From the target repository:

```bash
node <skill-dir>/scripts/evidence-scout.cjs run \
  --brief <scratch-brief.json> \
  --root "$PWD" \
  --runtime codex \
  --output <scratch-evidence.json>
```

Use `--runtime claude` only when Claude is the intended lower-tier worker. Override defaults with `BRAINSTORM_SCOUT_CODEX_MODEL` or `BRAINSTORM_SCOUT_CLAUDE_MODEL`; never set either to `default`. Keep `--effort low`.

## Consume Without Repeating the Work

1. Read the compact evidence packet once.
2. Open only the 2–5 citations that support load-bearing design claims.
3. Correct or discard any observation not supported by those exact lines.
4. Let unknowns drive targeted inspection or one user question; never fill them with invented framework behavior.
5. Do not ask the scout to format the visual or decide the architecture. The deterministic visual shell is already cheaper.

The packet is reconnaissance, not proof. The coordinator remains accountable for every claim placed in the design or specification.
