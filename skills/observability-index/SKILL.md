---
name: observability-index
description: Generate and optionally enrich the observability index (logs.json, traces.json) for the current project.
---

# Observability Index Skill

Use this skill when asked to generate, update, or enrich the observability index for a project.

## Mode 1: Generate Index

Run the extractor script against the current project root:

```bash
observability-index --root .
```

This produces:
- `.observability/logs.json` — all log call sites with level, template, structured flag, properties, and trace context flag
- `.observability/traces.json` — all span/activity call sites with span names

Both files include a metadata envelope with timestamp, git commit hash, config used, and `"tier": 1`.

If the project has a per-project config at `.observability/extractor.yaml`, the script picks it up automatically. Otherwise it uses the default `configs/dotnet.yaml` from the toolkit.

After the script finishes, report:
- How many log entries and trace entries were written
- Which config was used (reported in metadata.config)
- Any warnings printed to stderr

## Mode 2: Enrich Index (Optional — Tier 2)

Tier 2 enrichment adds caller/callee chains to index entries using `embedcode_trace`. This mode is strictly optional — Tier 1 output is complete and usable on its own.

### Step 1: Check embedcode availability

Attempt a probe call to `embedcode_trace` with a known method name from the index. If it returns an error or is unavailable, skip enrichment entirely and report "Tier 2 enrichment skipped — embedcode not available. Tier 1 index is complete."

### Step 2: Read the existing index

Read `.observability/logs.json` and `.observability/traces.json`. These must exist (run Mode 1 first if they don't).

### Step 3: Build the unique method list

From all entries across both files, collect unique `class.method` combinations. Each entry already has `class` and `method` fields — concatenate them as `ClassName.MethodName`. Do not call `embedcode_trace` once per log line; call it once per unique method. A class with 10 log lines in one method is one call, not ten.

Example deduplication:
```
SapSyncService.SynchronizeOrderItems  → 1 call
ProductClient.SendAsync               → 1 call
OrderItemWorkflow.Process             → 1 call
```

### Step 4: Call embedcode_trace per unique method

For each unique `ClassName.MethodName`:
- Call `embedcode_trace` with the method identifier
- Collect the returned callers and callees
- Store result keyed by `ClassName.MethodName`

If a call fails for a specific method, skip that method and continue — do not abort the enrichment.

### Step 5: Write enriched entries back

For each entry in `logs.json` and `traces.json`:
- Look up `ClassName.MethodName` in the results from Step 4
- If found: add `callers` and `callees` arrays to the entry
- If not found (call failed or no results): leave the entry unchanged

Update `metadata.tier` from `1` to `2` in both files.

Write the updated files back to `.observability/logs.json` and `.observability/traces.json`.

### Step 6: Report

After enrichment:
- Report how many unique methods were queried
- Report how many entries were enriched (had callers/callees added)
- Confirm `metadata.tier` is now `2` in both files

## Rules

- Never run Mode 2 without first confirming the index exists (Mode 1 must have run)
- Never modify the script source at `infra/observability-index/src/` — the index files at `.observability/` are the only files this skill writes
- If embedcode is unavailable, Tier 1 output is correct and complete — do not block on Tier 2
- Keep enrichment batched: one embedcode call per unique method, not per entry
- Preserve all existing fields in index entries; only add `callers` and `callees`, and update `metadata.tier`
