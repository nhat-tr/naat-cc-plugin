# Bounded Evidence Scout

Use one lower-tier scout only when repository reconnaissance would otherwise flood the main conversation. Small or already-localized work stays with the coordinator.

For approved Review Slice manifests, use the bounded batch command. Deterministic indexing happens before delegation; the model never chooses packet ownership or grouping.

## Contract

The scout is an ephemeral, read-only evidence compressor:

- Codex defaults to `gpt-5.4-mini` with low effort.
- Claude defaults to Haiku with low effort.
- The brief is at most 4 KB; the evidence packet is at most 6 KB.
- Citations must resolve to observed repository files and exact ranges of at most 12 lines.
- Editing, delegation, web research, architecture recommendations, and automatic runtime fallback are forbidden.
- The command prints metadata and usage only; raw worker events stay outside the main conversation.
- A batch packet contains at most 4 Review Slices, 40 changed files, or 1,200 changed lines, and remains at most 6 KB.
- Batch execution uses at most 3 concurrent scouts, 2 waves, and 6 low-tier calls. Remaining Review Slices are reported as deferred.
- An individually oversized Review Slice becomes a deterministic shortlist of public symbols, boundary crossings, tests, and unknowns. Its raw diff is never delegated.
- Batch evidence merges only by exact `evidence_key`; similar prose is not an identity rule and conflicts remain visible for coordinator verification.
- Every attempted call is counted. Failed and timed-out calls are written atomically with status and a bounded diagnostic; they do not trigger replacement calls or extra waves.
- Batch output, schemas, and raw worker responses stay under `CLAUDE_SCRATCH_DIR`. `run-batch` rejects an output path outside that root or through a symlink.

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

## Run a Review Slice Batch

Pass the canonical `review-index.cjs` Review Slice manifest (`schema: 1`) with its Work ID, base/head trees, plan digest, indexer version, stable task IDs, and actual changes. `run-batch` verifies change identities and derives paths, exact line deltas, changed public symbols, imports or boundary crossings, tests, and unknowns from the named Git trees. Attribute-free blob comparisons keep local or global Git attributes and diff drivers from changing packets; NUL detection on the tree blobs determines binary status. Caller-authored counts and shortlist annotations are not part of the canonical contract.

The earlier `version: 1` scout manifest remains readable as a compatibility adapter for existing integrations. New callers must use the canonical Review Slice manifest; only the canonical path has Git-derived evidence authority.

```bash
node <skill-dir>/scripts/evidence-scout.cjs run-batch \
  --manifest <scratch-review-slices.json> \
  --root "$PWD" \
  --runtime codex \
  --output <scratch-batch-evidence.json>
```

The output path must be inside `CLAUDE_SCRATCH_DIR`. The result follows `schemas/scout-batch.schema.json`. Inspect failed or timed-out `calls` and `deferred_review_slice_ids` before deciding whether to reprioritize, inspect directly, or start another explicitly approved batch. Do not automatically continue beyond the two-wave budget.

## Consume Without Repeating the Work

1. Read the compact evidence packet once.
2. Open only the 2–5 citations that support load-bearing design claims.
3. Correct or discard any observation not supported by those exact lines.
4. Let unknowns drive targeted inspection or one user question; never fill them with invented framework behavior.
5. Do not ask the scout to format the visual or decide the architecture. The deterministic visual shell is already cheaper.

For batch output, verify every load-bearing record in `evidence_by_key` against its cited path and lines. Multiple records under one key are separate observations, not an automatic consensus.

The packet is reconnaissance, not proof. The coordinator remains accountable for every claim placed in the design or specification.
