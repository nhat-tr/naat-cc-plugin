# Aspire CLI Reference

Native CLI flags, the full `aspire` command table, MCP-vs-CLI tradeoffs, the `cd`/`sed`/`awk` anti-pattern list, and the bundled helper inventory. Read `../SKILL.md` first for the helper-first rule and permission-prompt guidance this reference expands on.

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

Raw `aspire` is only the right answer for the small set of cases the helper doesn't wrap: `aspire otel logs <res> -f` (live streaming), `aspire logs <res>` (raw process stdout/stderr), `aspire start --isolated`, and similar. For those, **do NOT use `APPHOST=$(...)` shell substitution** — the assignment can't be statically analyzed by the permission system and will always prompt. Either inline a literal path (`--apphost /path/to/AppHost.csproj`) or run the helper's `apphost` subcommand once on its own to capture the path manually.

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
