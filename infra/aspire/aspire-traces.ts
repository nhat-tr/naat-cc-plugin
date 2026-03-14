#!/usr/bin/env tsx
/**
 * Aspire distributed trace reader — reads OTLP JSON lines from file exporter,
 * filters, and outputs clean text waterfalls for agent consumption.
 *
 * Usage:
 *   aspire-traces --resource DT-Core --errors --last 5m
 *   aspire-traces --id abc123def456
 *   aspire-traces --list-resources
 *   aspire-traces --resource RG-Core --min-duration 500ms
 */
import { parseArgs } from "node:util";
import {
  readJsonlLines, fmtTimestamp, fmtDuration,
  parseDuration, attrsToMap, getResourceName,
  type OtlpResource, type OtlpKeyValue,
} from "./otlp.ts";

const DEFAULT_FILE = "/tmp/aspire-telemetry/traces.jsonl";

// ── Args ──────────────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
  options: {
    resource:         { type: "string", short: "r" },
    errors:           { type: "boolean", short: "e" },
    last:             { type: "string", short: "t" },
    "min-duration":   { type: "string", short: "d" },
    grep:             { type: "string", short: "g" },
    id:               { type: "string" },
    "list-resources": { type: "boolean" },
    limit:            { type: "string", short: "n" },
    help:             { type: "boolean", short: "h" },
  },
  strict: true,
});

if (args.help) {
  console.log(`aspire-traces — Filtered Aspire distributed trace reader

Usage:
  aspire-traces [options]

Options:
  -r, --resource <name>       Filter by service name (substring match)
  -e, --errors                Only traces with error spans
  -t, --last <duration>       Time range: 5m, 1h, 30s
  -d, --min-duration <dur>    Minimum trace duration: 100ms, 1s
  -g, --grep <text>           Search span names and attribute values
      --id <traceId>          Show full waterfall for a specific trace
      --list-resources        Show available resource names and exit
  -n, --limit <count>         Max traces to show (default 20)
  -h, --help                  Show this help

Environment:
  ASPIRE_TRACES_FILE          Path to OTLP traces JSONL (default: ${DEFAULT_FILE})

Examples:
  aspire-traces --resource DT-Core --errors --last 5m
  aspire-traces --id abc123def456
  aspire-traces -r RG-Core --min-duration 500ms --last 10m`);
  process.exit(0);
}

// ── Flatten ───────────────────────────────────────────────────────────────────

interface FlatSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string;
  name: string;
  resource: string;
  startTime: Date;
  durationMs: number;
  isError: boolean;
  attributes: Record<string, string | number | boolean>;
}

function flattenBatch(batch: unknown): FlatSpan[] {
  const spans: FlatSpan[] = [];
  const b = batch as {
    resourceSpans?: {
      resource?: OtlpResource;
      scopeSpans?: {
        spans?: Record<string, unknown>[];
      }[];
    }[];
  };
  if (!b.resourceSpans) return spans;

  for (const rs of b.resourceSpans) {
    const resource = getResourceName(rs.resource);
    for (const ss of rs.scopeSpans ?? []) {
      for (const s of ss.spans ?? []) {
        const startNanos = String(s.startTimeUnixNano ?? "0");
        const endNanos = String(s.endTimeUnixNano ?? "0");
        const startMs = Number(BigInt(startNanos) / 1_000_000n);
        const endMs = Number(BigInt(endNanos) / 1_000_000n);
        const status = s.status as { code?: number } | undefined;
        spans.push({
          traceId: String(s.traceId ?? ""),
          spanId: String(s.spanId ?? ""),
          parentSpanId: String(s.parentSpanId ?? ""),
          name: String(s.name ?? ""),
          resource,
          startTime: new Date(startMs),
          durationMs: endMs - startMs,
          isError: status?.code === 2,
          attributes: attrsToMap(s.attributes as OtlpKeyValue[] | undefined),
        });
      }
    }
  }
  return spans;
}

// ── Group by trace ────────────────────────────────────────────────────────────

interface TraceGroup {
  traceId: string;
  spans: FlatSpan[];
  rootSpan: FlatSpan;
  totalDurationMs: number;
  errorCount: number;
  resources: Set<string>;
}

function groupTraces(spans: FlatSpan[]): Map<string, TraceGroup> {
  const byTrace = new Map<string, FlatSpan[]>();
  for (const s of spans) {
    const arr = byTrace.get(s.traceId) ?? [];
    arr.push(s);
    byTrace.set(s.traceId, arr);
  }

  const groups = new Map<string, TraceGroup>();
  for (const [traceId, traceSpans] of byTrace) {
    const root = traceSpans.reduce((a, b) => (a.startTime < b.startTime ? a : b));
    const endMs = Math.max(...traceSpans.map((s) => s.startTime.getTime() + s.durationMs));
    groups.set(traceId, {
      traceId,
      spans: traceSpans,
      rootSpan: root,
      totalDurationMs: endMs - root.startTime.getTime(),
      errorCount: traceSpans.filter((s) => s.isError).length,
      resources: new Set(traceSpans.map((s) => s.resource)),
    });
  }
  return groups;
}

// ── Filter ────────────────────────────────────────────────────────────────────

function filterTraces(groups: Map<string, TraceGroup>): TraceGroup[] {
  let result = [...groups.values()];

  if (args.last) {
    const cutoff = new Date(Date.now() - parseDuration(args.last));
    result = result.filter((g) => g.rootSpan.startTime >= cutoff);
  }

  if (args.resource) {
    const r = args.resource.toLowerCase();
    result = result.filter((g) => [...g.resources].some((res) => res.toLowerCase().includes(r)));
  }

  if (args.errors) {
    result = result.filter((g) => g.errorCount > 0);
  }

  if (args["min-duration"]) {
    const minMs = parseDuration(args["min-duration"]);
    result = result.filter((g) => g.totalDurationMs >= minMs);
  }

  if (args.grep) {
    const needle = args.grep.toLowerCase();
    result = result.filter((g) =>
      g.spans.some((s) =>
        s.name.toLowerCase().includes(needle) ||
        Object.values(s.attributes).some((v) => String(v).toLowerCase().includes(needle)),
      ),
    );
  }

  result.sort((a, b) => b.rootSpan.startTime.getTime() - a.rootSpan.startTime.getTime());

  const limit = parseInt(args.limit ?? "20", 10);
  return result.slice(0, limit);
}

// ── Output: trace list ────────────────────────────────────────────────────────

function printTraceList(traces: TraceGroup[]) {
  console.log(`Traces: ${traces.length}\n`);
  for (const g of traces) {
    const errMark = g.errorCount ? `  ✗ ${g.errorCount} error(s)` : "";
    const resources = [...g.resources].join(", ");
    console.log(
      `[${fmtTimestamp(g.rootSpan.startTime)}] ${fmtDuration(g.totalDurationMs).padStart(8)}  ${g.rootSpan.resource}  ${g.rootSpan.name.slice(0, 60)}${errMark}`,
    );
    console.log(`  traceId=${g.traceId}  spans=${g.spans.length}  resources=${resources}`);
  }
}

// ── Output: waterfall ─────────────────────────────────────────────────────────

const SHOW_ATTRS = new Set([
  "http.method", "http.url", "http.target", "http.status_code",
  "db.statement", "db.system", "db.name",
  "rpc.method", "rpc.service",
  "error.message", "exception.message", "exception.type",
  "messaging.system", "messaging.operation", "messaging.destination",
]);

function printWaterfall(group: TraceGroup) {
  const { spans, traceId, totalDurationMs } = group;
  const spanMap = new Map(spans.map((s) => [s.spanId, s]));
  const children = new Map<string, string[]>(spans.map((s) => [s.spanId, []]));
  const roots: string[] = [];

  for (const s of spans) {
    if (s.parentSpanId && spanMap.has(s.parentSpanId)) {
      children.get(s.parentSpanId)!.push(s.spanId);
    } else {
      roots.push(s.spanId);
    }
  }

  const traceStart = group.rootSpan.startTime.getTime();

  console.log(`Trace: ${traceId}  total=${fmtDuration(totalDurationMs)}  spans=${spans.length}`);
  console.log(`Start: ${fmtTimestamp(group.rootSpan.startTime)} UTC\n`);

  const walk = (spanId: string, depth: number) => {
    const s = spanMap.get(spanId)!;
    const offset = s.startTime.getTime() - traceStart;
    const errMark = s.isError ? " ✗ ERROR" : "";
    const indent = "  ".repeat(depth);

    console.log(
      `${indent}[+${fmtDuration(offset).padStart(7)}] ${fmtDuration(s.durationMs).padStart(8)}  ${s.resource.padEnd(30)} ${s.name.slice(0, 55)}${errMark}`,
    );

    for (const [k, v] of Object.entries(s.attributes)) {
      if (SHOW_ATTRS.has(k)) {
        console.log(`${indent}  ${k}: ${String(v).slice(0, 100)}`);
      }
    }

    // Sort children by start time
    const childIds = children.get(spanId) ?? [];
    childIds.sort((a, b) => spanMap.get(a)!.startTime.getTime() - spanMap.get(b)!.startTime.getTime());
    for (const childId of childIds) walk(childId, depth + 1);
  };

  roots.sort((a, b) => spanMap.get(a)!.startTime.getTime() - spanMap.get(b)!.startTime.getTime());
  for (const rootId of roots) walk(rootId, 0);
}

// ── Main ──────────────────────────────────────────────────────────────────────

const filePath = process.env.ASPIRE_TRACES_FILE ?? DEFAULT_FILE;
const batches = readJsonlLines(filePath);
const allSpans = batches.flatMap(flattenBatch);

if (args["list-resources"]) {
  const counts = new Map<string, number>();
  for (const s of allSpans) counts.set(s.resource, (counts.get(s.resource) ?? 0) + 1);
  const sorted = [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));
  console.log(`Resources (${sorted.length}):\n`);
  for (const [name, count] of sorted) console.log(`  ${name.padEnd(40)} ${count} spans`);
  process.exit(0);
}

const groups = groupTraces(allSpans);

if (args.id) {
  const group = groups.get(args.id);
  if (!group) {
    console.error(`Trace ${args.id} not found.`);
    process.exit(1);
  }
  printWaterfall(group);
} else {
  const filtered = filterTraces(groups);
  if (filtered.length === 0) {
    console.log("No traces match the filters.");
  } else {
    printTraceList(filtered);
  }
}
