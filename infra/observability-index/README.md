# Observability Index

Extracts log and trace instrumentation from .NET codebases into compact JSON files. The agent uses these files to construct precise Kibana/Jaeger queries instead of scanning source code.

## Quick Start

```bash
# From any .NET project root:
observability-index --root .

# Or via Claude Code command:
/generate-index
```

This produces two files in `.observability/`:
- `logs.json` — every log call site (template, level, structured flag, properties)
- `traces.json` — every span/activity call site (span name, pattern type)

## How the Agent Uses It

Three-tier priority when investigating production issues:

1. **Playbooks** (`.observability/playbooks/index.yaml`) — human-written runbooks for known scenarios
2. **Index** (`logs.json` / `traces.json`) — exact templates and span names for queries
3. **Source code** — last resort

The Kibana, Jaeger, and Grafana agents all check for these files before constructing queries. The troubleshoot workflow does the same.

## Investigating Production Issues

First, generate the index from the project root (one-time, re-run after code changes):

```
/generate-index
```

Then ask the agents naturally. Environment is `oae`, `prod`, or `qss`:

```
# Search logs
/kibana-logs errors in regrinding-core-service last 1h on oae

# Search traces
/jaeger slow traces in regrinding-core-service on oae

# Check service health / metrics
/grafana health of regrinding namespace on prod

# Full diagnostic workflow (playbooks → index → source → tool queries)
/troubleshoot orders stuck in Processing status on oae
```

The agents automatically check `.observability/playbooks/index.yaml` for matching playbooks, then `.observability/logs.json` / `traces.json` for exact log templates and span names, and only fall back to source code if neither matches.

## CLI Options

```
npx tsx src/index.ts [options]

  --root <path>        Project root to scan (default: cwd)
  --config <path>      Config file override
  --output-dir <path>  Output directory (default: <root>/.observability)
  --verbose            Print progress to stderr
  --dry-run            Show counts without writing files
```

## Per-Project Config

By default the script uses `configs/dotnet.yaml` (ILogger, Serilog, RunInActivity, etc.).

To customize for a project, create `.observability/extractor.yaml`:

```yaml
# Extend the default and add project-specific patterns
extends: dotnet

patterns:
  - name: "Custom logger"
    category: log
    regex: 'MyLogger\.Write\(\s*"(?<template>[^"]+)"'
    structured: detect
```

Or replace entirely (omit `extends`):

```yaml
file_globs: ["**/*.cs"]
exclude_globs: ["**/bin/**", "**/obj/**"]
include_submodules: false

patterns:
  - name: "Only this pattern"
    category: log
    regex: '...'
    structured: true
```

Config resolution: project `.observability/extractor.yaml` → toolkit `configs/dotnet.yaml`.

## Writing Playbooks

Playbooks encode domain expertise for known diagnostic scenarios. They live in the project repo at `.observability/playbooks/`.

1. Copy `templates/playbook-template.md` to `.observability/playbooks/<name>.md`
2. Fill in triggers, steps, and root causes
3. Add an entry to `.observability/playbooks/index.yaml`:

```yaml
playbooks:
  - file: stuck-order.md
    triggers: ["order stuck", "Processing status", "not progressing"]
    services: ["regrinding-core-service"]
```

The agent reads `index.yaml` (one small file), matches triggers against the investigation goal, then reads only the matching playbook.

See `.observability/playbooks/stuck-order.md` in Calibration Core for a real example.

## Tier 2 Enrichment (Optional)

If `embedcode_trace` is available, the `/generate-index` command can enrich entries with caller/callee chains. This adds context like "who calls this method" without reading source.

Tier 2 is strictly optional — Tier 1 output is complete and usable on its own.

## Adding Patterns

All extraction is config-driven. To add a new instrumentation pattern:

1. Add a YAML entry to `configs/dotnet.yaml` (or your project's `extractor.yaml`)
2. Each pattern needs: `name`, `category` (log/trace), `regex` (with named capture groups)
3. For logs: set `structured: detect` to auto-detect `{Placeholder}` vs string interpolation
4. Re-run the script

No code changes needed.

## Tests

```bash
cd infra/observability-index
npm test              # unit + integration tests (39 tests)
npm run test:watch    # watch mode
```

Integration tests run against Calibration Core if available, skip otherwise.
