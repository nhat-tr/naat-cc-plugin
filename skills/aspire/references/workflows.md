# Aspire Workflows Reference

Step-by-step recipes for the common Aspire inspection, restart, integration, and testing tasks. All commands assume the bundled helpers in `scripts/` — see `cli-reference.md` for the native flag table, full command reference, and helper inventory.

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

## Adding integrations

```bash
aspire docs search <keyword>          # find integration docs
aspire docs get <slug>                # read the doc
aspire add                            # interactive: pick package, AppHost, target project
aspire start                          # apply
```

## Playwright CLI

If configured, use Playwright CLI for functional testing of resources. Get endpoints via `aspire describe`. Run `playwright-cli --help` for available commands.
