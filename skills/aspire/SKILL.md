---
name: aspire
description: "Use this skill WHENEVER the user wants to inspect, debug, search, or change state in a locally-running .NET service orchestrated by an Aspire AppHost — even when they do NOT say the word 'aspire'. The user almost always describes the task, not the tool. Triggers: LOGS — 'logs from <service>', 'errors in <service>', 'why is <service> failing', 'find logs containing X', 'tail the logs'. TRACES — 'investigate this trace', 'why did this request fail', 'debug a slow request', 'show LLM prompt/response', 'inspect span attributes'. STATE — 'what's running/healthy', 'restart/stop/start <service>'. DB — 'query the <db> database', 'select from <table>', 'list tables in <db>'. Uses three Node helpers (trace-inspect, aspire-logs, aspire-db) that auto-discover the AppHost. DO NOT USE FOR: production observability (Grafana/Datadog), Azure-deployed services (az tools), non-Aspire .NET apps (dotnet CLI), Docker Compose stacks."
---

# Aspire Skill

Aspire orchestrates a distributed .NET application from an AppHost project (`*.AppHost.csproj`, often containing an `apphost.cs`). The CLI talks to a running AppHost via its dashboard; everything below assumes one is running (`aspire start`).

## Helper-first rule

The single biggest mistake is reaching for a Python or curl-to-Jaeger script to filter, count, or extract things from logs/traces. **The Aspire CLI already filters server-side**, and for the few jobs it doesn't cover cleanly (embedded-JSON span attributes, stitching a trace's spans, regex content search across log entries) the skill bundles three name-matched helpers in `scripts/`: `trace-inspect.ts` (traces + resource state), `aspire-logs.ts` (structured logs), `aspire-db.ts` (read-only SQL). Reach for one of these or a native CLI flag (`--severity`, `--has-error`, `--trace-id`, `-n`, `--format Json`) before writing anything yourself — full flag table in `references/cli-reference.md`.

## Permission-prompt guidance

**Prefer a bundled helper over raw `aspire`** — each auto-discovers the AppHost via `aspire ps`, so most invocations are just `<helper> <cmd> ...` with zero setup and match the existing allow rule. If `aspire ps` shows zero or multiple AppHosts, the helper errors with a list — pass `--apphost <path>` explicitly to disambiguate.

Raw `aspire` is only the right answer for what the helpers don't wrap (live OTel streaming, raw process stdout/stderr, `aspire start --isolated`). For those:

- **Never use `APPHOST=$(...)` shell substitution** — the assignment can't be statically analyzed by the permission system and always prompts. Inline a literal path, or run the helper's `apphost` subcommand once on its own to capture it manually.
- **Never use `cd <dir> && aspire ...`** — the `cd &&` compound also defeats the permission allow-list.
- **Don't wrap commands in `sed`/`awk`/`tail`/temp-files either** — these compounds turn every invocation into a fresh permission prompt and bury the actual question. Use a CLI flag (`-n`, `--format Json`, `-f`) or the bundled helper instead. Full anti-pattern list in `references/cli-reference.md`.

## Reference Map

Read only what is relevant:

- `references/workflows.md`: step-by-step recipes — health overview, finding failing traces, logs with content search, listing traces, extracting a span attribute, LLM input/output for a trace, restart-and-wait, running/restarting, querying dev databases (SELECT-only), adding integrations, Playwright CLI.
- `references/cli-reference.md`: native CLI flag table, the full `aspire` command reference, MCP-vs-CLI tradeoffs, the `cd`/`sed`/`awk` anti-pattern list, when raw `jq` piping is appropriate, and the bundled helper inventory.

## Important rules

- **Always `aspire start` before making changes**, to verify the starting state.
- **To restart, just `aspire start` again** — it stops the previous instance. Never use `aspire run`. Never chain `aspire stop` then `aspire start`.
- **Use `--isolated` in a git worktree** to avoid port and user-secret collisions.
- **Avoid persistent containers** early in development to prevent state-management surprises.
- **Never install the Aspire workload** — it is obsolete.
- Prefer `aspire.dev` and `learn.microsoft.com/dotnet/aspire` for official docs.
