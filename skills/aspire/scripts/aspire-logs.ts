#!/usr/bin/env -S node --experimental-strip-types
// aspire-logs — bundled with the aspire skill.
//
// Filters and content-searches OTel structured logs from a service inside a
// running Aspire AppHost. Uses native `aspire otel logs` server-side filters
// (--severity, --trace-id, -n) plus a client-side regex content search across
// the full log entry (message + attribute values + exception text + ids).
//
// Logs are the primary diagnostic signal in this stack; this helper exists so
// `logs` is a name-discoverable concept, not a subcommand buried inside
// trace-inspect.

import { aspireJson, parseFlags, resolveApphost, type Attrs } from "./aspire-lib.ts";

type LogEntry = {
    logId: number;
    message: string;
    severity: string;
    resourceName: string;
    attributes?: Attrs;
    source?: string;
    traceId?: string;
    spanId?: string;
    exception?: string;
    dashboardUrl: string;
};

type TraceStub = { traceId: string };

// Resolve a trace-id prefix to the full id via the aspire CLI. The CLI returns
// a single object for --trace-id and an array for --limit, so both shapes are
// handled.
function findTraceId(prefix: string, apphost: string): string {
    const ap = ["--apphost", apphost];
    try {
        const direct = aspireJson<TraceStub | TraceStub[]>(["otel", "traces", ...ap, "--trace-id", prefix]);
        if (Array.isArray(direct)) {
            if (direct.length === 1) return direct[0].traceId;
        } else if (direct && direct.traceId) {
            return direct.traceId;
        }
    } catch {
        // fall through to prefix-match
    }
    const all = aspireJson<TraceStub[]>(["otel", "traces", ...ap, "--limit", "500"]);
    const matches = all.filter((t) => t.traceId.startsWith(prefix));
    if (matches.length === 0) throw new Error(`no trace matches prefix ${prefix}`);
    if (matches.length > 1) {
        const ids = matches.slice(0, 5).map((t) => t.traceId).join("\n  ");
        throw new Error(`prefix ${prefix} matched ${matches.length} traces:\n  ${ids}`);
    }
    return matches[0].traceId;
}

const usage = `aspire-logs — query OTel structured logs from a running Aspire AppHost.

usage:
  aspire-logs <resource> [--severity S] [--limit N] [--match REGEX]... [--exclude REGEX]...
  aspire-logs --trace-id <id-prefix> [--severity S] [--match REGEX]... [--exclude REGEX]...

options:
  --severity <S>     Server-side filter (Trace|Debug|Information|Warning|Error|Critical).
  --limit <N>        Cap result count server-side (-n N).
  --trace-id <id>    Scope to one distributed trace; id-prefix is resolved to full id.
  --match <regex>    Repeatable AND filter; case-insensitive; tested against the whole
                     log entry (message + every attribute value + exception text +
                     spanId/traceId). All must match.
  --exclude <regex>  Repeatable OR filter; same haystack. Skip if any matches.
                     Great for cutting healthcheck/metrics-exporter noise.
  --apphost <path>   AppHost path. Auto-discovered via "aspire ps" if omitted
                     (errors if 0 or 2+ AppHosts are running).

note:
  No --since flag — aspire dashboard's JSON output carries logId (monotonic)
  but not timestamps. For time-windowed queries, raise --limit and rely on
  result ordering, or use \`aspire otel logs ... --format Table\` (which does
  show HH:MM:SS.mmm) directly.

examples:
  aspire-logs <resource> --severity Error --limit 30
  aspire-logs <resource> --limit 2000 --match "<session-id>" --match "SSE WIRE|ui.render"
  aspire-logs <resource> --severity Warning --limit 500 --exclude "healthz" --exclude "OtlpMetricExporter"
  aspire-logs --trace-id abc12 --severity Warning
`;

function main(): void {
    const argv = process.argv.slice(2);
    if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
        process.stdout.write(usage);
        process.exit(argv.length === 0 ? 1 : 0);
    }

    const { values, positionals } = parseFlags(argv, {
        apphost: "string",
        severity: "string",
        limit: "string",
        "trace-id": "string",
        match: "array",
        exclude: "array",
    });

    const resource = positionals[0];
    const traceIdArg = values["trace-id"];
    if (!resource && !traceIdArg) {
        process.stderr.write("aspire-logs: pass <resource> or --trace-id <id>. Run --help.\n");
        process.exit(1);
    }

    const apphost = resolveApphost(values.apphost);
    const args = ["otel", "logs", "--apphost", apphost];
    if (resource) args.push(resource);
    if (traceIdArg) args.push("--trace-id", findTraceId(traceIdArg, apphost));
    if (values.severity) args.push("--severity", values.severity);
    if (values.limit) args.push("-n", values.limit);
    const logs = aspireJson<LogEntry[]>(args);

    const matchers = (values.match ?? []).map((p) => new RegExp(p, "i"));
    const excluders = (values.exclude ?? []).map((p) => new RegExp(p, "i"));
    const needHaystack = matchers.length > 0 || excluders.length > 0;
    let printed = 0;
    for (const l of logs) {
        if (needHaystack) {
            // Concatenate just the searchable fields. Attributes are a flat
            // string map so no recursion is needed; we skip JSON.stringify
            // overhead and keep spanId/traceId searchable for id hunts.
            const haystack =
                l.message +
                "\n" + l.severity +
                "\n" + l.resourceName +
                "\n" + (l.source ?? "") +
                "\n" + (l.exception ?? "") +
                "\n" + (l.spanId ?? "") +
                "\n" + (l.traceId ?? "") +
                "\n" + Object.entries(l.attributes ?? {}).map(([k, v]) => `${k}=${v}`).join("\n");
            if (matchers.length > 0 && !matchers.every((re) => re.test(haystack))) continue;
            if (excluders.length > 0 && excluders.some((re) => re.test(haystack))) continue;
        }
        console.log(`[${l.severity.padEnd(11)}] ${l.resourceName.padEnd(20)} ${l.message}`);
        printed++;
    }
    if (needHaystack && printed === 0) {
        const filterDesc = [
            matchers.length > 0 ? `${matchers.length} --match` : "",
            excluders.length > 0 ? `${excluders.length} --exclude` : "",
        ].filter(Boolean).join(", ");
        process.stderr.write(`no logs survived the filter (${filterDesc}) over ${logs.length} candidate entries\n`);
        process.exit(1);
    }
}

try {
    main();
} catch (e) {
    process.stderr.write((e instanceof Error ? e.message : String(e)) + "\n");
    process.exit(1);
}
