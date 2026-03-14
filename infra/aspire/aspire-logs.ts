#!/usr/bin/env tsx
/**
 * Aspire structured log reader — reads OTLP JSON lines from file exporter,
 * filters, and outputs clean text for agent consumption.
 *
 * Usage:
 *   aspire-logs --resource RG-Core --level Error,Warning --last 5m
 *   aspire-logs --list-resources
 *   aspire-logs --resource DT-Core --exclude "Microsoft.*" --grep "connection"
 *   aspire-logs --resource RG-Core --level Error --follow
 *   aspire-logs --resource RG-Core --level Error -o /tmp/diag.txt
 */
import { parseArgs } from "node:util";
import { writeFileSync } from "node:fs";
import {
  readJsonlLines, followFile, nanosToDate, fmtTimestamp,
  parseDuration, attrsToMap, getResourceName, matchesAnyGlob,
  type OtlpResource, type OtlpKeyValue,
} from "./otlp.ts";

const DEFAULT_FILE = "/tmp/aspire-telemetry/logs.jsonl";
const DEFAULT_EXCLUDES = [
  "Microsoft.AspNetCore.Hosting.*",
  "Microsoft.AspNetCore.Routing.*",
  "Microsoft.AspNetCore.StaticFiles.*",
  "Microsoft.AspNetCore.Server.Kestrel.*",
  "*HealthCheck*",
  "Serilog.AspNetCore.RequestLoggingMiddleware",
  "System.Net.Http.HttpClient.*",
  "Microsoft.Hosting.Lifetime",
];

// ── Args ──────────────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
  options: {
    resource:             { type: "string", short: "r" },
    level:                { type: "string", short: "l" },
    last:                 { type: "string", short: "t" },
    exclude:              { type: "string", short: "x" },
    grep:                 { type: "string", short: "g" },
    "list-resources":     { type: "boolean" },
    follow:               { type: "boolean", short: "f" },
    "no-default-excludes":{ type: "boolean" },
    output:               { type: "string", short: "o" },
    help:                 { type: "boolean", short: "h" },
  },
  strict: true,
});

if (args.help) {
  console.log(`aspire-logs — Filtered Aspire structured log reader

Usage:
  aspire-logs [options]

Options:
  -r, --resource <name>       Filter by service name (substring match)
  -l, --level <levels>        Comma-separated: Error,Warning,Information,Debug
  -t, --last <duration>       Time range: 5m, 1h, 30s
  -x, --exclude <patterns>    Comma-separated source glob patterns to exclude
  -g, --grep <text>           Search message and attribute values
      --list-resources        Show available resource names and exit
  -f, --follow                Tail mode — watch for new logs
      --no-default-excludes   Disable default noise exclusions
  -o, --output <file>         Write output to file
  -h, --help                  Show this help

Environment:
  ASPIRE_LOGS_FILE            Path to OTLP logs JSONL (default: ${DEFAULT_FILE})

Examples:
  aspire-logs --resource DT-Core --level Error --last 5m
  aspire-logs --list-resources
  aspire-logs -r RG-Core -x "Microsoft.*,HealthCheck" --last 10m`);
  process.exit(0);
}

// ── Flatten ───────────────────────────────────────────────────────────────────

interface FlatLog {
  timestamp: Date;
  severity: string;
  resource: string;
  source: string;
  body: string;
  attributes: Record<string, string | number | boolean>;
  traceId: string;
  spanId: string;
}

function flattenBatch(batch: unknown): FlatLog[] {
  const logs: FlatLog[] = [];
  const b = batch as { resourceLogs?: { resource?: OtlpResource; scopeLogs?: { scope?: { name?: string }; logRecords?: Record<string, unknown>[] }[] }[] };
  if (!b.resourceLogs) return logs;

  for (const rl of b.resourceLogs) {
    const resource = getResourceName(rl.resource);
    for (const sl of rl.scopeLogs ?? []) {
      const scopeName = sl.scope?.name ?? "";
      for (const lr of sl.logRecords ?? []) {
        const attrs = attrsToMap(lr.attributes as OtlpKeyValue[] | undefined);
        const source = scopeName || String(attrs["CategoryName"] ?? attrs["category"] ?? "");
        const bodyObj = lr.body as { stringValue?: string } | undefined;
        logs.push({
          timestamp: nanosToDate(String(lr.timeUnixNano ?? lr.observedTimeUnixNano ?? "0")),
          severity: String(lr.severityText ?? ""),
          resource,
          source,
          body: bodyObj?.stringValue ?? "",
          attributes: attrs,
          traceId: String(lr.traceId ?? ""),
          spanId: String(lr.spanId ?? ""),
        });
      }
    }
  }
  return logs;
}

// ── Filter ────────────────────────────────────────────────────────────────────

function applyFilters(logs: FlatLog[]): FlatLog[] {
  let result = logs;

  // Time range
  if (args.last) {
    const cutoff = new Date(Date.now() - parseDuration(args.last));
    result = result.filter((l) => l.timestamp >= cutoff);
  }

  // Resource
  if (args.resource) {
    const r = args.resource.toLowerCase();
    result = result.filter((l) => l.resource.toLowerCase().includes(r));
  }

  // Severity
  if (args.level) {
    const levels = new Set(args.level.split(",").map((l) => l.trim().toLowerCase()));
    result = result.filter((l) => levels.has(l.severity.toLowerCase()));
  }

  // Exclusions
  const excludePatterns = [
    ...(!args["no-default-excludes"] ? DEFAULT_EXCLUDES : []),
    ...(args.exclude ? args.exclude.split(",").map((p) => p.trim()) : []),
  ];
  if (excludePatterns.length) {
    result = result.filter((l) => !matchesAnyGlob(l.source, excludePatterns));
  }

  // Grep
  if (args.grep) {
    const needle = args.grep.toLowerCase();
    result = result.filter((l) => {
      if (l.body.toLowerCase().includes(needle)) return true;
      return Object.values(l.attributes).some((v) => String(v).toLowerCase().includes(needle));
    });
  }

  return result.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
}

// ── Output ────────────────────────────────────────────────────────────────────

function formatLog(l: FlatLog): string {
  const lines: string[] = [];
  const sev = l.severity.toUpperCase().padStart(5);
  lines.push(`[${fmtTimestamp(l.timestamp)}] [${sev}] [${l.resource}] ${l.source}`);
  if (l.body) lines.push(`  ${l.body.slice(0, 300)}`);

  // Show non-trivial attributes
  const skip = new Set(["CategoryName", "category", "EventId", "{OriginalFormat}"]);
  const attrParts = Object.entries(l.attributes)
    .filter(([k]) => !skip.has(k))
    .map(([k, v]) => `${k}=${v}`);
  if (attrParts.length) lines.push(`  ${attrParts.join("  ")}`);

  if (l.traceId && l.traceId !== "00000000000000000000000000000000") {
    lines.push(`  trace=${l.traceId}`);
  }
  return lines.join("\n");
}

// ── Main ──────────────────────────────────────────────────────────────────────

const filePath = process.env.ASPIRE_LOGS_FILE ?? DEFAULT_FILE;

if (args["list-resources"]) {
  const batches = readJsonlLines(filePath);
  const counts = new Map<string, number>();
  for (const b of batches) {
    for (const l of flattenBatch(b)) {
      counts.set(l.resource, (counts.get(l.resource) ?? 0) + 1);
    }
  }
  const sorted = [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));
  console.log(`Resources (${sorted.length}):\n`);
  for (const [name, count] of sorted) console.log(`  ${name.padEnd(40)} ${count} logs`);
  process.exit(0);
}

if (args.follow) {
  const ac = new AbortController();
  process.on("SIGINT", () => ac.abort());
  process.on("SIGTERM", () => ac.abort());

  // Print existing logs first
  try {
    const batches = readJsonlLines(filePath);
    const all = batches.flatMap(flattenBatch);
    for (const l of applyFilters(all)) console.log(formatLog(l));
  } catch { /* file may not exist yet */ }

  console.log("--- following (Ctrl+C to stop) ---");
  await followFile(filePath, (obj) => {
    for (const l of applyFilters(flattenBatch(obj))) console.log(formatLog(l));
  }, ac.signal);
  process.exit(0);
}

// Normal mode
const batches = readJsonlLines(filePath);
const all = batches.flatMap(flattenBatch);
const filtered = applyFilters(all);

const output = filtered.map(formatLog).join("\n\n");

if (args.output) {
  writeFileSync(args.output, output + "\n");
  console.log(`Written ${filtered.length} logs to ${args.output}`);
} else {
  if (filtered.length === 0) {
    console.log("No logs match the filters.");
  } else {
    console.log(output);
    console.log(`\n--- ${filtered.length} logs ---`);
  }
}
