---
name: aspire
description: "Use this skill WHENEVER the user wants to inspect, debug, search, or change state in a locally-running .NET service orchestrated by an Aspire AppHost — even when they do NOT say the word 'aspire'. The user almost always describes the task, not the tool. Triggers: LOGS — 'logs from <service>', 'errors in <service>', 'why is <service> failing', 'find logs containing X', 'tail the logs'. TRACES — 'investigate this trace', 'why did this request fail', 'debug a slow request', 'show LLM prompt/response', 'inspect span attributes'. STATE — 'what's running/healthy', 'restart/stop/start <service>'. DB — 'query the <db> database', 'select from <table>', 'list tables in <db>'. Uses three Node helpers (trace-inspect, aspire-logs, aspire-db) that auto-discover the AppHost. DO NOT USE FOR: production observability (Grafana/Datadog), Azure-deployed services (az tools), non-Aspire .NET apps (dotnet CLI), Docker Compose stacks."
---

# Aspire Skill

Aspire orchestrates a distributed .NET application from an AppHost project (`*.AppHost.csproj`, often containing an `apphost.cs`). The CLI talks to a running AppHost via its dashboard; everything below assumes one is running (`aspire start`).

## Do not write custom log/trace parsers

The single biggest mistake is reaching for a Python or curl-to-Jaeger script to filter, count, or extract things from logs/traces. **The Aspire CLI already filters server-side**, and for the few jobs it doesn't cover cleanly (embedded-JSON span attributes, stitching a trace's spans, regex content search across log entries) the skill bundles three name-matched helpers in `scripts/`: `trace-inspect.ts` (traces + resource state), `aspire-logs.ts` (structured logs), `aspire-db.ts` (read-only SQL). Reach for one of these or a CLI flag before writing anything yourself.

Native CLI filters you probably don't know exist:

| Need | Flag |
|---|---|
| Only errors | `aspire otel logs <resource> --severity Error` |
| Only failed traces | `aspire otel traces --has-error` |
| One specific trace | `aspire otel logs --trace-id <id>` / `aspire otel traces --trace-id <id>` |
| Last N entries | `-n <N>` (works on `logs`, `otel logs`, `otel traces`) |
| Stream live | `-f` (follow) |
| Machine-readable | `--format Json` |
| Tail with timestamps | `aspire logs <resource> -n 100 -t` |

Use these before pipelining to `jq`. They run on the server, return less data, and are far easier to read in a script.

## Targeting an AppHost

**Prefer a bundled helper over raw `aspire`** — `trace-inspect.ts` (apphost, describe, errors, traces, show, attr, llm, resource, wait), `aspire-logs.ts` (logs with regex content search), `aspire-db.ts` (read-only SELECT). Each auto-discovers the AppHost via `aspire ps`, so most invocations are just `<helper> <cmd> ...` with zero setup. When in doubt, run `--help` and pick a subcommand instead of falling back to raw aspire.

Raw `aspire` is only the right answer for the small set of cases the helper doesn't wrap: `aspire otel logs <res> -f` (live streaming), `aspire logs <res>` (raw process stdout/stderr), `aspire start --isolated`, and similar. For those, **do NOT use `APPHOST=$(...)` shell substitution** — the assignment can't be statically analyzed by the permission system and will always prompt. Either inline a literal path (`--apphost /Users/.../AppHost.csproj`) or run the helper's `apphost` subcommand once on its own to capture the path manually.

Never use `cd <dir> && aspire ...` — the `cd &&` compound also defeats the permission allow-list.

If `aspire ps` shows zero or multiple AppHosts, the helper errors with a list — pass `--apphost <path>` explicitly to disambiguate.

## Do not wrap commands in cd / sed / awk / tail / temp-files

These compounds turn every invocation into a fresh permission prompt, waste tokens, and bury the actual question. They're the hallmark of "I'm parsing aspire output by hand" — exactly the pattern this skill is meant to replace.

- ❌ `cd <dir> && aspire ...` — pass `--apphost` instead
- ❌ `aspire ... > /tmp/trace.json; cat /tmp/trace.json | sed ... | awk ...` — pipe `aspire ... --format Json` directly into `jq`, or use the helper
- ❌ `aspire ... 2>&1 | sed 's/\x1b...//g'` — the banner/footer are easy to skim; `jq` reads the JSON regardless
- ❌ `aspire ... | tail -50` — use the `-n 50` flag on the aspire command itself
- ❌ `... trace-inspect.ts ... | tail` — the helper already returns trimmed, ANSI-free output
- ❌ Writing a parser to "find out what fields are in a trace" — run `trace-inspect.ts show <id> --attrs` instead; it lists every span attribute with its value preview.

Only reach for `sed` or `jq` when an aspire flag and the helper genuinely don't cover what you need.

## Common workflows

The bundled helper auto-discovers the AppHost. **Prefer it over raw `aspire …` for every read-only inspection** — every helper invocation matches the existing allow rule, while raw `aspire` commands almost always need `$APPHOST` substitution which triggers a permission prompt.

Invoke the helper by its full path each time — `~/.local/share/my-claude-code/skills/aspire/scripts/trace-inspect.ts`. **Do NOT use a shell variable** like `T=~/...; ~/.local/share/my-claude-code/skills/aspire/scripts/trace-inspect.ts cmd` — the assignment + `$T` expansion both trip the static analyzer and fire a permission prompt. Verbosity here is the price of every call being a single allow-rule match.

### Health overview

```bash
~/.local/share/my-claude-code/skills/aspire/scripts/trace-inspect.ts describe                        # everything: name | state | health | type | url
~/.local/share/my-claude-code/skills/aspire/scripts/trace-inspect.ts describe --unhealthy            # only resources not reporting Healthy
~/.local/share/my-claude-code/skills/aspire/scripts/trace-inspect.ts describe Paragon                # name-prefix filter
```

### Find what's failing

```bash
~/.local/share/my-claude-code/skills/aspire/scripts/trace-inspect.ts errors --limit 20               # failing traces (uses --has-error server-side)
~/.local/share/my-claude-code/skills/aspire/scripts/trace-inspect.ts traces <resource> --has-error   # failing traces for one service
```

Then drill into one:

```bash
~/.local/share/my-claude-code/skills/aspire/scripts/trace-inspect.ts show <trace-id> --attrs         # all spans + every attribute key/value preview
~/.local/share/my-claude-code/skills/aspire/scripts/aspire-logs.ts --trace-id <trace-id> --severity Warning
```

### Logs for a service (with content search)

```bash
~/.local/share/my-claude-code/skills/aspire/scripts/aspire-logs.ts <resource> --severity Error --limit 30
~/.local/share/my-claude-code/skills/aspire/scripts/aspire-logs.ts <resource> --severity Warning --limit 50

# --match and --exclude are repeatable case-insensitive regexes tested against
# the whole log entry (message + every attribute value + exception text).
# --match is AND (all must match), --exclude is OR (skip if any matches).
# Together they replace `aspire otel logs <res> -n N | grep | grep | grep -v`.
~/.local/share/my-claude-code/skills/aspire/scripts/aspire-logs.ts Paragon-Api --limit 2000 --match "<session-id>" --match "SSE WIRE|ui.render"
~/.local/share/my-claude-code/skills/aspire/scripts/aspire-logs.ts Paragon-Api --severity Warning --limit 500 --exclude "healthz" --exclude "OtlpMetricExporter"

# Note: there is no --since flag because the aspire dashboard's JSON output
# does not carry timestamps (only `logId`, which is monotonic but not a date).
# For time-windowed queries, increase --limit and rely on result ordering, or
# inspect `aspire otel logs ... --format Table` (which does show HH:MM:SS.mmm).
```

Raw `aspire` is only needed for the unwrapped cases — live OTel streaming (`aspire otel logs <res> -f`) and raw process stdout/stderr (`aspire logs <res>`). For those, **inline the apphost path** (run `trace-inspect.ts apphost` once on its own to discover it; then paste the literal path into the `--apphost` flag). Do NOT use `APPHOST=$(...)` shell substitution — it always prompts.

### List traces for a service

```bash
~/.local/share/my-claude-code/skills/aspire/scripts/trace-inspect.ts traces <resource> --limit 30
~/.local/share/my-claude-code/skills/aspire/scripts/trace-inspect.ts traces <resource> --has-error
```

### Extract a deeply-nested span attribute

OTel span attributes are a flat string map, but values like `gen_ai.input.messages` are themselves JSON-encoded strings. The helper parses the embedded JSON for you:

```bash
~/.local/share/my-claude-code/skills/aspire/scripts/trace-inspect.ts attr <id> gen_ai.input.messages
~/.local/share/my-claude-code/skills/aspire/scripts/trace-inspect.ts attr <id> db.statement
~/.local/share/my-claude-code/skills/aspire/scripts/trace-inspect.ts attr <id> http.request.body --span "POST"
```

If you don't know which attribute key to ask for, run `~/.local/share/my-claude-code/skills/aspire/scripts/trace-inspect.ts show <id> --attrs` first to list every key on every span — that view is also what replaces "dump the trace JSON and grep around for what's in there".

### LLM input/output for a trace

```bash
~/.local/share/my-claude-code/skills/aspire/scripts/trace-inspect.ts llm <id>
```

Shows model, token counts, and parsed input/output messages for every `gen_ai.*` span in the trace.

### Restart a service, wait for it healthy

One call does both — `--wait` after the action blocks on health:

```bash
~/.local/share/my-claude-code/skills/aspire/scripts/trace-inspect.ts resource Paragon-Api restart --wait
```

This replaces the common-but-prompt-firing `aspire resource X stop && sleep 2 && aspire resource X start && aspire wait X` chain. Don't write that chain — `aspire resource X restart` is atomic, and `--wait` covers the health check.

### Running and restarting

```bash
aspire start                  # detected AppHost; auto-stops any previous instance
aspire start --isolated       # required in a git worktree — avoids port + secret collisions
aspire wait <resource>        # block until healthy
aspire stop
```

`aspire start` is idempotent; **never** use `aspire run` or chain `stop` then `run`. Restarting is just `aspire start` again.

## Querying dev databases (SELECT-only)

The skill bundles `scripts/aspire-db.ts` for running read-only SQL against any postgres database in the running Aspire stack. **Use it instead of building a `psql` invocation by hand or pulling the connection string with `aspire mcp call <postgres> PostgreSQLGetConnectionString`** — the latter exposes auto-generated credentials and is off-limits.

Conventions baked into the helper:

- **Credentials are static `postgres` / `root`** (the dev convention for the local Aspire postgres container). The password is passed via `PGPASSWORD`, never echoed on the command line. Do not extract the auto-generated password from anywhere.
- **Read-only enforcement**: any of `INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|GRANT|REVOKE|COPY|VACUUM|REINDEX|MERGE|CALL|DO|LOCK|REFRESH|CLUSTER|COMMENT|SET|RESET|BEGIN|START|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE|DECLARE|FETCH|PREPARE|EXECUTE|DEALLOCATE|NOTIFY|LISTEN|UNLISTEN|IMPORT|SECURITY` (case-insensitive word match) cause the call to be refused. This is a guard, not a parser — false positives inside string literals will also be refused, so rephrase if hit.
- **Auto-resolution of Aspire-resource → real-postgres-name**: Aspire resource names (`agent-data-db`, `recalcore-db`, ...) often differ from the real database name on the server (`agent_data`, `calibration_core_db`, ...). The helper scans the AppHost project's `*.cs` files for `.AddDatabase("aspire-name", "real-name")` patterns and builds the mapping at runtime. You pass the Aspire resource name you see in `describe`; the helper handles the rest. `--dbname <real>` is an escape hatch for AppHosts that build the name dynamically.
- **Failure recovery**: if the resolved name still doesn't exist on the server, the helper lists every real database from `pg_database` so you can pick the right one and retry with `--dbname`.

Examples:

```bash
# What postgres databases are running? (list PostgresDatabaseResource resources)
~/.local/share/my-claude-code/skills/aspire/scripts/trace-inspect.ts describe | grep PostgresDatabaseResource

# Run a SELECT — Aspire name is what `describe` shows; the helper resolves the real DB name
~/.local/share/my-claude-code/skills/aspire/scripts/aspire-db.ts <db-resource> "SELECT count(*) FROM <table>"
~/.local/share/my-claude-code/skills/aspire/scripts/aspire-db.ts <db-resource> "SELECT id, name FROM <table> ORDER BY id DESC LIMIT 10"

# Tab-separated output for machine parsing
~/.local/share/my-claude-code/skills/aspire/scripts/aspire-db.ts <db-resource> "SELECT <col1>, <col2> FROM <table>" --tsv

# Inspect a schema without dumping every column
~/.local/share/my-claude-code/skills/aspire/scripts/aspire-db.ts <db-resource> "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name"
~/.local/share/my-claude-code/skills/aspire/scripts/aspire-db.ts <db-resource> "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = '<table>'"
```

For full usage run `~/.local/share/my-claude-code/skills/aspire/scripts/aspire-db.ts --help`.

## When jq is appropriate

After exhausting the native flags, `--format Json | jq` is fine for projections the CLI doesn't offer (counting, grouping, distinct values):

```bash
aspire otel logs myapi --format Json --severity Error \
  | jq 'group_by(.attributes.EventId) | map({eventId: .[0].attributes.EventId, count: length})'

aspire otel traces myapi --format Json --has-error -n 50 \
  | jq '[.[] | {trace: .traceId, dur: .durationMs, root: .spans[0].name}] | sort_by(.dur) | reverse | .[0:10]'
```

Two practical notes about the CLI output:

- The CLI prints a banner before and a footer after JSON. When piping to `jq`, this usually works (jq reads stdin until valid JSON), but if you see parse errors, strip ANSI and grab only the JSON span: `sed 's/\x1b\[[0-9;]*[a-zA-Z]//g'` then jq. The bundled helper handles this automatically.
- `--format Json` is supported by `describe`, `logs`, `otel logs`, `otel traces`, `mcp tools`, and `docs list`.

## CLI command reference

| Task | Command |
|---|---|
| Start / restart the app | `aspire start` (use `--isolated` in worktrees) |
| Wait for a resource | `aspire wait <resource>` |
| Stop | `aspire stop` |
| List resources + state | `aspire describe` |
| Start/stop a single resource | `aspire resource <name> start\|stop\|restart` |
| Console logs | `aspire logs [<resource>] [-n N] [-t] [-f]` |
| Structured (OTel) logs | `aspire otel logs [<resource>] [--severity S] [--trace-id ID] [-n N] [-f]` |
| Traces | `aspire otel traces [<resource>] [--has-error] [--trace-id ID] [-n N]` |
| Add an integration | `aspire add` (then `aspire start` to apply) |
| Running AppHosts on this machine | `aspire ps` |
| Update AppHost packages | `aspire update` |
| Docs | `aspire docs search <q>`, `aspire docs get <slug>`, `aspire docs list` |
| Diagnose env issues | `aspire doctor` |
| Resource MCP tools | `aspire mcp tools`, `aspire mcp call <res> <tool> --input '<json>'` |

## MCP vs CLI

The `mcp__aspire__*` tools (`list_traces`, `list_structured_logs`, `list_resources`, …) return structured data already in your context, but they accept only `resourceName` / `traceId` — they have **no severity, error, time, or limit filters**. The CLI does. For any targeted query (errors only, last N, one trace, one severity), the CLI wins because it filters before returning. Use MCP only for quick overviews where the unfiltered structure is fine (e.g. "what resources are running?"). For everything else, prefer the CLI; for the two cases the CLI can't do cleanly, use the bundled `trace-inspect.ts`.

## Bundled helpers in `scripts/`

Three zero-dependency Node/TypeScript helpers, each `chmod +x` with shebang `#!/usr/bin/env -S node --experimental-strip-types` (Node 22+; on 18-21 prefix with `npx tsx`). Shared aspire-CLI plumbing lives in `aspire-lib.ts`.

| Helper | Purpose | `--help` |
|---|---|---|
| `trace-inspect.ts` | Distributed traces, span attributes, LLM input/output, resource state | `... trace-inspect.ts --help` |
| `aspire-logs.ts`   | OTel structured logs with server-side filters + `--match`/`--exclude` regex content search | `... aspire-logs.ts --help` |
| `aspire-db.ts`     | Read-only SELECT against postgres resources; auto-resolves Aspire DB name → real DB name | `... aspire-db.ts --help` |

Behaviour worth knowing without reading the source: when `--apphost` is omitted each helper auto-discovers via `aspire ps` (uses the single running AppHost or errors with a list if 0 or 2+). Trace-id prefixes are resolved to the full ID. JSON-encoded attribute values (the OTel pattern for `gen_ai.input.messages`, `gen_ai.output.messages`, `EventId`, etc.) are parsed before printing. `aspire-logs.ts`'s `--match`/`--exclude` regexes are tested against the whole log entry — message + attribute values + exception text — so identifiers like `session_id` or `EventId` values are searchable.

## Adding integrations

```bash
aspire docs search <keyword>          # find integration docs
aspire docs get <slug>                # read the doc
aspire add                            # interactive: pick package, AppHost, target project
aspire start                          # apply
```

## Important rules

- **Always `aspire start` before making changes**, to verify the starting state.
- **To restart, just `aspire start` again** — it stops the previous instance. Never use `aspire run`. Never chain `aspire stop` then `aspire start`.
- **Use `--isolated` in a git worktree** to avoid port and user-secret collisions.
- **Avoid persistent containers** early in development to prevent state-management surprises.
- **Never install the Aspire workload** — it is obsolete.
- Prefer `aspire.dev` and `learn.microsoft.com/dotnet/aspire` for official docs.

## Playwright CLI

If configured, use Playwright CLI for functional testing of resources. Get endpoints via `aspire describe`. Run `playwright-cli --help` for available commands.
