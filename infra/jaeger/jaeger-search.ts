#!/usr/bin/env tsx
/**
 * Jaeger trace search via kubectl port-forward.
 *
 * Usage:
 *   tsx jaeger-search.ts [env]   # env: qss (default), oae, prod
 *
 * Stdin JSON examples:
 *   {"action": "services"}
 *   {"action": "operations", "service": "regrinding-core-service-v2.regrinding"}
 *   {"action": "search", "service": "regrinding-core-service-v2.regrinding", "lookback": "1h", "tags": "error=true"}
 *   {"action": "search", "service": "...", "minDuration": "500ms", "limit": 20}
 *   {"action": "trace", "id": "<traceID>"}
 */
import { withPortForward } from "../kubectl-portforward.ts";
import { apiGet, readStdinJson } from "../http.ts";

const ENV = process.argv[2] ?? "qss";
const NS = "pos-tracing";
const SVC = "pos-tracing-jaeger-query";
const REMOTE_PORT = 80;

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtDuration(us: number): string {
  if (us < 1_000) return `${us}µs`;
  if (us < 1_000_000) return `${(us / 1000).toFixed(1)}ms`;
  return `${(us / 1_000_000).toFixed(2)}s`;
}

function fmtTs(us: number): string {
  return new Date(us / 1000).toISOString().replace("T", " ").slice(0, 19);
}

function hasError(span: Span): boolean {
  return span.tags.some((t) => t.key === "error" && t.value === true);
}

function printServices(data: { data: string[] }) {
  const services = [...data.data].sort();
  console.log(`Services (${services.length}):\n`);
  for (const s of services) console.log(`  ${s}`);
}

function printOperations(data: { data: string[] }, service: string) {
  const ops = [...data.data].sort();
  console.log(`Operations for '${service}' (${ops.length}):\n`);
  for (const op of ops) console.log(`  ${op}`);
}

interface Span {
  spanID: string;
  operationName: string;
  startTime: number;
  duration: number;
  processID: string;
  references: { refType: string; spanID: string }[];
  tags: { key: string; value: unknown }[];
}

interface Trace {
  traceID: string;
  spans: Span[];
  processes: Record<string, { serviceName: string }>;
}

function printTraceList(data: { data: Trace[] }, query: Record<string, unknown>) {
  const traces = data.data ?? [];
  const parts: string[] = [];
  if (query.service) parts.push(`service=${query.service}`);
  if (query.operation) parts.push(`op=${query.operation}`);
  if (query.lookback) parts.push(`last ${query.lookback}`);
  if (query.tags) parts.push(`tags=${query.tags}`);
  if (query.minDuration) parts.push(`min=${query.minDuration}`);
  console.log(`Traces: ${traces.length}`);
  if (parts.length) console.log(`Query: ${parts.join(", ")}`);
  console.log();

  for (const trace of traces) {
    const { spans, processes } = trace;
    if (!spans.length) continue;
    const root = spans.reduce((a, b) => (a.startTime < b.startTime ? a : b));
    const totalDur = Math.max(...spans.map((s) => s.startTime + s.duration)) - root.startTime;
    const errors = spans.filter(hasError).length;
    const proc = processes[root.processID] ?? {};
    const op = root.operationName.slice(0, 60);
    const errMark = errors ? `  ✗ ${errors} error(s)` : "";
    console.log(`[${fmtTs(root.startTime)}] ${fmtDuration(totalDur).padStart(8)}  ${proc.serviceName}  ${op}${errMark}`);
    console.log(`  traceID=${trace.traceID}  spans=${spans.length}`);
  }
}

function printTraceDetail(data: { data: Trace[] }, traceId: string) {
  if (!data.data?.length) { console.log(`Trace ${traceId} not found.`); return; }
  const trace = data.data[0];
  const { spans, processes } = trace;
  if (!spans.length) { console.log("No spans in trace."); return; }

  const spanMap = new Map(spans.map((s) => [s.spanID, s]));
  const children = new Map<string, string[]>(spans.map((s) => [s.spanID, []]));
  const roots: string[] = [];

  for (const s of spans) {
    const parentRef = s.references.find((r) => r.refType === "CHILD_OF");
    if (parentRef && spanMap.has(parentRef.spanID)) {
      children.get(parentRef.spanID)!.push(s.spanID);
    } else {
      roots.push(s.spanID);
    }
  }

  const traceStart = Math.min(...spans.map((s) => s.startTime));
  const totalDur = Math.max(...spans.map((s) => s.startTime + s.duration)) - traceStart;

  console.log(`Trace: ${traceId}  total=${fmtDuration(totalDur)}  spans=${spans.length}`);
  console.log(`Start: ${fmtTs(traceStart)} UTC\n`);

  const walk = (spanId: string, depth: number) => {
    const s = spanMap.get(spanId)!;
    const proc = processes[s.processID] ?? {};
    const op = s.operationName.slice(0, 55);
    const offset = s.startTime - traceStart;
    const errMark = hasError(s) ? " ✗ ERROR" : "";
    const indent = "  ".repeat(depth);
    console.log(`${indent}[+${fmtDuration(offset).padStart(7)}] ${fmtDuration(s.duration).padStart(8)}  ${proc.serviceName?.padEnd(30) ?? "?".padEnd(30)} ${op}${errMark}`);
    for (const tag of s.tags) {
      if (["http.url", "http.status_code", "db.statement", "error.object"].includes(tag.key)) {
        console.log(`${indent}  ${tag.key}: ${String(tag.value).slice(0, 100)}`);
      }
    }
    for (const childId of children.get(spanId) ?? []) walk(childId, depth + 1);
  };

  for (const rootId of roots) walk(rootId, 0);
}

// ── Main ──────────────────────────────────────────────────────────────────────

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`jaeger — Jaeger trace search via kubectl port-forward

Usage:
  echo '<json>' | jaeger [env]

Environments: qss (default), oae, prod

Actions (JSON stdin):
  {"action":"services"}                                     List all services
  {"action":"operations","service":"<name>"}                List operations for a service
  {"action":"search","service":"<name>"}                    Search traces
  {"action":"search","service":"<name>","tags":"error=true","lookback":"1h","limit":20}
  {"action":"search","service":"<name>","minDuration":"500ms"}
  {"action":"trace","id":"<traceId>"}                       Full span waterfall

Search options:
  service      Service name (required for search)
  operation    Filter by operation name
  lookback     1h, 3h, 6h, 12h, 24h, 2d, 7d (default: 1h)
  tags         Tag filter, e.g. "error=true", "http.status_code=500"
  minDuration  Minimum duration, e.g. "100ms", "1s"
  maxDuration  Maximum duration
  limit        Max results (default: 20, max: 100)

Examples:
  echo '{"action":"services"}' | jaeger qss
  echo '{"action":"search","service":"regrinding-core-service-v2.regrinding","tags":"error=true"}' | jaeger oae
  echo '{"action":"trace","id":"abc123"}' | jaeger prod`);
  process.exit(0);
}

const q = await readStdinJson();
const action = (q.action as string) ?? "search";

try {
  await withPortForward(ENV, NS, SVC, REMOTE_PORT, async (port) => {
    const base = `http://localhost:${port}`;

    if (action === "services") {
      const data = await apiGet(base, "/api/services") as { data: string[] };
      printServices(data);

    } else if (action === "operations") {
      const svc = q.service as string;
      if (!svc) throw new Error("'service' required for operations action");
      const data = await apiGet(base, "/api/operations", { service: svc }) as { data: string[] };
      printOperations(data, svc);

    } else if (action === "search") {
      const params: Record<string, string | number> = {};
      if (q.service)    params.service    = q.service as string;
      if (q.operation)  params.operation  = q.operation as string;
      if (q.lookback)   params.lookback   = q.lookback as string;
      if (q.limit)      params.limit      = q.limit as number;
      if (q.minDuration) params.minDuration = q.minDuration as string;
      if (q.maxDuration) params.maxDuration = q.maxDuration as string;
      if (q.tags) {
        const tags = q.tags as string | Record<string, string>;
        params.tags = typeof tags === "string" && tags.includes("=")
          ? JSON.stringify(Object.fromEntries([tags.split("=", 2) as [string, string]]))
          : typeof tags === "object" ? JSON.stringify(tags) : tags as string;
      }
      params.limit ??= 20;
      params.lookback ??= "1h";
      const data = await apiGet(base, "/api/traces", params) as { data: Trace[] };
      printTraceList(data, q);

    } else if (action === "trace") {
      const id = q.id as string;
      if (!id) throw new Error("'id' required for trace action");
      const data = await apiGet(base, `/api/trace/${id}`) as { data: Trace[] };
      printTraceDetail(data, id);

    } else {
      throw new Error(`Unknown action '${action}'. Use: services, operations, search, trace`);
    }
  });
} catch (e) {
  console.error(`ERROR: ${(e as Error).message}`);
  process.exit(1);
}