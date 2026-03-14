/**
 * Shared OTLP proto-as-JSON parsing utilities for aspire-logs and aspire-traces.
 */
import { readFileSync, statSync, createReadStream } from "node:fs";
import { createInterface } from "node:readline";

// ── OTLP Types ────────────────────────────────────────────────────────────────

export interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}

export interface OtlpAnyValue {
  stringValue?: string;
  intValue?: string;
  boolValue?: boolean;
  doubleValue?: number;
  arrayValue?: { values: OtlpAnyValue[] };
  bytesValue?: string;
}

export interface OtlpResource {
  attributes: OtlpKeyValue[];
}

// ── Attribute Parsing ─────────────────────────────────────────────────────────

export function extractValue(v: OtlpAnyValue): string | number | boolean {
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.intValue !== undefined) return Number(v.intValue);
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.bytesValue !== undefined) return v.bytesValue;
  if (v.arrayValue) return v.arrayValue.values.map(extractValue).join(", ");
  return "";
}

export function attrsToMap(attrs: OtlpKeyValue[] | undefined): Record<string, string | number | boolean> {
  const map: Record<string, string | number | boolean> = {};
  if (!attrs) return map;
  for (const a of attrs) map[a.key] = extractValue(a.value);
  return map;
}

export function getResourceName(resource: OtlpResource | undefined): string {
  if (!resource?.attributes) return "unknown";
  const svcName = resource.attributes.find((a) => a.key === "service.name");
  return svcName ? String(extractValue(svcName.value)) : "unknown";
}

// ── Time ──────────────────────────────────────────────────────────────────────

export function nanosToDate(nanos: string): Date {
  // OTLP nanosecond timestamps exceed Number.MAX_SAFE_INTEGER
  return new Date(Number(BigInt(nanos) / 1_000_000n));
}

export function fmtTimestamp(d: Date): string {
  return d.toISOString().replace("T", " ").slice(0, 19);
}

export function fmtDuration(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function parseDuration(input: string): number {
  const m = input.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/);
  if (!m) throw new Error(`Invalid duration: ${input}`);
  const val = parseFloat(m[1]);
  const unit = m[2];
  const multipliers: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return val * multipliers[unit];
}

// ── File Reading ──────────────────────────────────────────────────────────────

export function readJsonlLines(filePath: string): unknown[] {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      console.error(`File not found: ${filePath}`);
      console.error("Is the OTel collector file exporter configured?");
      process.exit(1);
    }
    throw e;
  }

  const results: unknown[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      results.push(JSON.parse(trimmed));
    } catch {
      // Skip malformed lines (partial writes on crash)
    }
  }
  return results;
}

export async function followFile(
  filePath: string,
  onLine: (obj: unknown) => void,
  signal: AbortSignal,
): Promise<void> {
  let offset = 0;
  try {
    offset = statSync(filePath).size;
  } catch { /* file may not exist yet */ }

  while (!signal.aborted) {
    await new Promise((r) => setTimeout(r, 500));
    let size: number;
    try {
      size = statSync(filePath).size;
    } catch {
      continue;
    }
    if (size <= offset) continue;

    const stream = createReadStream(filePath, { start: offset, encoding: "utf8" });
    const rl = createInterface({ input: stream });
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        onLine(JSON.parse(trimmed));
      } catch { /* skip */ }
    }
    offset = size;
  }
}

// ── Pattern Matching ──────────────────────────────────────────────────────────

export function matchesGlob(value: string, pattern: string): boolean {
  // Simple glob: * matches any sequence
  const regex = new RegExp("^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$", "i");
  return regex.test(value);
}

export function matchesAnyGlob(value: string, patterns: string[]): boolean {
  return patterns.some((p) => matchesGlob(value, p));
}
