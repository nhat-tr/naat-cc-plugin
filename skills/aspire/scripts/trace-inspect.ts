#!/usr/bin/env -S node --experimental-strip-types
// trace-inspect — bundled with the aspire skill.
//
// Why this exists: the aspire CLI is the right tool for filtering logs/traces
// (`--severity Error`, `--has-error`, `--trace-id`, `-n`), but two jobs are
// awkward in raw shell:
//   1. Span attributes like `gen_ai.input.messages` are JSON-encoded strings
//      embedded inside the per-span attribute map. jq can do it but the
//      escaping is brittle.
//   2. Resolving a partial trace-id and stitching spans + logs together for a
//      single trace requires multiple coordinated calls.
//
// Zero deps. Runs anywhere `aspire` is on PATH and a running AppHost can be
// resolved (via --apphost, CWD, or auto-discovery through `aspire ps`).

import { runAspire, aspireJson, resolveApphost, parseFlags, type Attrs, type Resource } from "./aspire-lib.ts";

type Span = {
    traceId: string;
    spanId: string;
    name: string;
    kind: string;
    source?: string;
    destination?: string;
    durationMs: number;
    timestamp: string;
    hasError?: boolean;
    attributes?: Attrs;
};
type Trace = {
    traceId: string;
    durationMs: number;
    title: string;
    spans: Span[];
    hasError: boolean;
    timestamp: string;
    dashboardUrl: string;
};

// Some span/log attribute values are JSON-encoded strings (notably gen_ai.*).
// Returns the parsed value if it looks like JSON, otherwise the original.
function unwrap(value: string): unknown {
    const t = value.trim();
    if (!(t.startsWith("{") || t.startsWith("["))) return value;
    try {
        return JSON.parse(t);
    } catch {
        return value;
    }
}

function fmt(v: unknown): string {
    return typeof v === "string" ? v : JSON.stringify(v, null, 2);
}

function findTrace(prefix: string, apphost: string): Trace {
    const ap = ["--apphost", apphost];
    // The CLI returns a single object for --trace-id, an array for --limit.
    // Try direct lookup first.
    try {
        const direct = aspireJson<Trace | Trace[]>(["otel", "traces", ...ap, "--trace-id", prefix]);
        if (Array.isArray(direct)) {
            if (direct.length === 1) return direct[0];
        } else if (direct && direct.traceId) {
            return direct;
        }
    } catch {
        // fall through to prefix-match
    }
    // Fall back to listing recent traces and prefix-matching.
    const all = aspireJson<Trace[]>(["otel", "traces", ...ap, "--limit", "500"]);
    const matches = all.filter((t) => t.traceId.startsWith(prefix));
    if (matches.length === 0) throw new Error(`no trace matches prefix ${prefix}`);
    if (matches.length > 1) {
        const ids = matches.slice(0, 5).map((t) => t.traceId).join("\n  ");
        throw new Error(`prefix ${prefix} matched ${matches.length} traces:\n  ${ids}`);
    }
    return matches[0];
}

// ----------- commands -----------

function cmdApphost(argv: string[]) {
    const { values } = parseFlags(argv, { apphost: "string" });
    console.log(resolveApphost(values.apphost));
}

function cmdResource(argv: string[]) {
    const { values, positionals } = parseFlags(argv, { apphost: "string", wait: "bool" });
    const [name, action] = positionals;
    if (!name || !action) throw new Error("resource: missing <name> or <action> (see --help)");
    const apphost = resolveApphost(values.apphost);
    process.stdout.write(runAspire(["resource", name, action, "--apphost", apphost]));
    if (values.wait) process.stdout.write(runAspire(["wait", name, "--apphost", apphost]));
}

function cmdWait(argv: string[]) {
    const { values, positionals } = parseFlags(argv, { apphost: "string" });
    const name = positionals[0];
    if (!name) throw new Error("wait: missing <resource> (see --help)");
    const apphost = resolveApphost(values.apphost);
    const out = runAspire(["wait", name, "--apphost", apphost]);
    process.stdout.write(out);
}

function cmdDescribe(argv: string[]) {
    const { values, positionals } = parseFlags(argv, { apphost: "string", unhealthy: "bool" });
    const filter = positionals[0];
    const apphost = resolveApphost(values.apphost);
    const data = aspireJson<{ resources: Resource[] }>(["describe", "--apphost", apphost]);
    let resources = data.resources;
    if (filter) resources = resources.filter((r) => r.name === filter || r.name.startsWith(filter));
    if (values.unhealthy) resources = resources.filter((r) => r.healthStatus && r.healthStatus !== "Healthy");
    for (const r of resources) {
        const url = r.urls?.[0]?.url ?? "";
        console.log(`${r.name.padEnd(28)} ${r.state.padEnd(12)} ${(r.healthStatus ?? "-").padEnd(12)} ${r.resourceType.padEnd(28)} ${url}`);
    }
}

function printTraceList(traces: Trace[]) {
    for (const t of traces) {
        const sources = [...new Set(t.spans.map((s) => s.source).filter(Boolean))].join(",");
        const tag = t.hasError ? " [ERR]" : "";
        console.log(`${t.traceId}  ${t.timestamp}  ${String(t.durationMs).padStart(6)}ms  ${t.title}${tag}  [${sources}]`);
    }
}

function cmdErrors(argv: string[]) {
    // Sugar for `traces --has-error`; the two used to be duplicate implementations.
    cmdTraces(["--has-error", ...argv]);
}

function cmdTraces(argv: string[]) {
    const { values, positionals } = parseFlags(argv, {
        apphost: "string",
        limit: "string",
        "has-error": "bool",
    });
    const apphost = resolveApphost(values.apphost);
    const resource = positionals[0];
    const args = ["otel", "traces", "--apphost", apphost];
    if (resource) args.push(resource);
    if (values["has-error"]) args.push("--has-error");
    args.push("--limit", values.limit ?? "20");
    const traces = aspireJson<Trace[]>(args);
    if (traces.length === 0) {
        console.log("no traces");
        return;
    }
    printTraceList(traces);
}

function cmdShow(argv: string[]) {
    const { values, positionals } = parseFlags(argv, { apphost: "string", attrs: "bool" });
    const id = positionals[0];
    if (!id) throw new Error("show: missing <trace-id-prefix> (see --help)");
    const apphost = resolveApphost(values.apphost);
    const trace = findTrace(id, apphost);
    console.log(`trace ${trace.traceId}  ${trace.timestamp}  ${trace.durationMs}ms  hasError=${trace.hasError}`);
    console.log(`title ${trace.title}`);
    console.log(`dashboard ${trace.dashboardUrl}`);
    console.log("spans:");
    for (const s of trace.spans) {
        const tag = s.hasError ? "  [ERR]" : "";
        const route = s.source && s.destination ? `${s.source} -> ${s.destination}` : (s.source ?? s.destination ?? "-");
        console.log(`  ${s.spanId}  ${s.kind.padEnd(8)}  ${String(s.durationMs).padStart(6)}ms  ${route}  ${s.name}${tag}`);
        if (values.attrs) {
            const keys = Object.keys(s.attributes ?? {}).sort();
            for (const k of keys) {
                const raw = s.attributes![k];
                const preview = raw.length > 120 ? raw.slice(0, 117) + "..." : raw;
                console.log(`      ${k} = ${preview.replace(/\n/g, " ")}`);
            }
        }
    }
}

function cmdAttr(argv: string[]) {
    const { values, positionals } = parseFlags(argv, { apphost: "string", span: "string" });
    const [id, key] = positionals;
    if (!id || !key) throw new Error("attr: missing <trace-id-prefix> or <key> (see --help)");
    const apphost = resolveApphost(values.apphost);
    const trace = findTrace(id, apphost);
    const spans = values.span
        ? trace.spans.filter((s) => s.name.toLowerCase().includes(values.span!.toLowerCase()))
        : trace.spans;
    let found = 0;
    for (const s of spans) {
        const v = s.attributes?.[key];
        if (v === undefined) continue;
        found++;
        console.log(`--- ${s.spanId}  ${s.name}  ${s.durationMs}ms`);
        console.log(fmt(unwrap(v)));
    }
    if (found === 0) {
        console.error(`no spans had attribute ${key}`);
        process.exitCode = 1;
    }
}

function cmdLlm(argv: string[]) {
    const { values, positionals } = parseFlags(argv, { apphost: "string" });
    const id = positionals[0];
    if (!id) throw new Error("llm: missing <trace-id-prefix> (see --help)");
    const apphost = resolveApphost(values.apphost);
    const trace = findTrace(id, apphost);
    const llmSpans = trace.spans.filter((s) =>
        Object.keys(s.attributes ?? {}).some((k) => k.startsWith("gen_ai."))
    );
    if (llmSpans.length === 0) {
        console.error("no gen_ai.* spans in this trace");
        process.exitCode = 1;
        return;
    }
    for (const s of llmSpans) {
        const a = s.attributes ?? {};
        console.log(`--- ${s.spanId}  ${s.name}  ${s.durationMs}ms`);
        const lines: string[] = [];
        const sys = a["gen_ai.system"];
        const model = a["gen_ai.request.model"] ?? a["gen_ai.response.model"];
        const inTok = a["gen_ai.usage.input_tokens"];
        const outTok = a["gen_ai.usage.output_tokens"];
        if (sys) lines.push(`system: ${sys}`);
        if (model) lines.push(`model:  ${model}`);
        if (inTok || outTok) lines.push(`tokens: in=${inTok ?? "?"} out=${outTok ?? "?"}`);
        if (lines.length) console.log(lines.join("\n"));
        const inp = a["gen_ai.input.messages"] ?? a["gen_ai.prompt"];
        const out = a["gen_ai.output.messages"] ?? a["gen_ai.completion"];
        if (inp) {
            console.log("input:");
            console.log(fmt(unwrap(inp)));
        }
        if (out) {
            console.log("output:");
            console.log(fmt(unwrap(out)));
        }
    }
}

// ----------- entry -----------

const usage = `usage: trace-inspect <command> [args]

commands:
  apphost                                  Print the AppHost path (auto-discovered via \`aspire ps\`)
  errors [resource] [--limit N]            List recent failing traces (uses --has-error)
  traces [resource] [--has-error] [--limit N]
                                           List recent traces (use \`errors\` for failures only)
  show   <trace-id-prefix> [--attrs]       Show all spans in a trace (--attrs lists every attribute key+value preview)
  attr   <trace-id-prefix> <key> [--span S]
                                           Extract a span attribute; parses embedded JSON
                                           (e.g. attr abc gen_ai.input.messages)
  llm    <trace-id-prefix>                 Show gen_ai.* input/output/tokens for an LLM trace

  (For OTel structured logs, use the sibling helper \`aspire-logs.ts\` —
   same flag set, name-matched to the concern.)

state-changing / health (auto --apphost):
  describe [name-prefix] [--unhealthy]     List resources, state, health, primary URL
  resource <name> <start|stop|restart> [--wait]
                                           Run an aspire resource command; --wait then blocks
                                           until the resource reports healthy (so a single
                                           "resource X restart --wait" replaces the common
                                           stop/sleep/start/wait chain).
  wait <name>                              Block until resource reports healthy

common flags:
  --apphost <path>   AppHost project. If omitted, the helper auto-discovers via
                     \`aspire ps\` and uses the single running AppHost (errors if 0
                     or 2+ are running).
`;

const [, , cmd, ...rest] = process.argv;
const commands: Record<string, (args: string[]) => void> = {
    apphost: cmdApphost,
    describe: cmdDescribe,
    errors: cmdErrors,
    traces: cmdTraces,
    show: cmdShow,
    attr: cmdAttr,
    llm: cmdLlm,
    resource: cmdResource,
    wait: cmdWait,
};

const isHelp = !cmd || cmd === "--help" || cmd === "-h";
if (isHelp || !commands[cmd]) {
    if (!isHelp) console.error(`unknown command: ${cmd}\n`);
    console.error(usage);
    process.exit(isHelp ? 0 : 1);
}

try {
    commands[cmd](rest);
} catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
}
