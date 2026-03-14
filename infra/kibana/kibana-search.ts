#!/usr/bin/env tsx
/**
 * Elasticsearch log search via direct ES API (bypasses Kibana + App Gateway).
 * Credentials are read from K8s secret at runtime.
 *
 * Usage:
 *   tsx kibana-search.ts [env]   # env: oae (default), prod, qss
 *
 * Stdin: ES Query DSL JSON
 *   {"size": 50, "query": {"match_all": {}}}
 *   {"size": 50, "query": {"bool": {"must": [{"term": {"log.level": "error"}}], "filter": [{"range": {"@timestamp": {"gte": "now-1h"}}}]}}}
 */
import { kubectlJson, resolveContext } from "../kubectl-portforward.ts";
import { readStdinJson } from "../http.ts";

const ENV = process.argv[2] ?? "oae";
const INDEX = process.env.ELASTIC_INDEX ?? "logstash-*";

const ES_HOSTS: Record<string, string> = {
  oae:  "https://we-pos-oae.es.westeurope.azure.elastic-cloud.com",
  prod: "https://we-pos-prod.es.westeurope.azure.elastic-cloud.com",
  qss:  "https://we-pos-qss.es.westeurope.azure.elastic-cloud.com",
};

// ── Default exclusions ────────────────────────────────────────────────────────

const DEFAULT_EXCLUSIONS: Record<string, unknown>[] = [
  { terms: { class_name: [
    "Serilog.AspNetCore.RequestLoggingMiddleware",
    "Hoffmann.Regrinding.Common.Client.OAuth2Authenticator",
    "System.Net.Http.HttpClient.OtlpTraceExporter.ClientHandler",
  ]}},
  { wildcard: { class_name: { value: "*HealthCheck" }}},
];

// ── Credentials ───────────────────────────────────────────────────────────────

async function getEsAuth(): Promise<string> {
  const ctx = resolveContext(ENV);
  const secret = await kubectlJson([
    "get", "secret", "pos-elastic-password-akvs",
    "-n", "pos-logging",
    "--context", ctx,
  ]) as { data: Record<string, string> };

  const password = Buffer.from(secret.data["POS_ELASTIC_USER_PASSWORD"], "base64").toString("utf8");
  return Buffer.from(`elastic:${password}`).toString("base64");
}

// ── ES API ────────────────────────────────────────────────────────────────────

async function esSearch(query: Record<string, unknown>, auth: string): Promise<Record<string, unknown>> {
  const host = ES_HOSTS[ENV.toLowerCase()];
  if (!host) throw new Error(`Unknown env '${ENV}'. Use: oae, prod, qss`);

  const url = `${host}/${encodeURIComponent(INDEX)}/_search`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(query),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 400)}`);
  }
  return res.json() as Promise<Record<string, unknown>>;
}

// ── Query helpers ─────────────────────────────────────────────────────────────

function applyExclusions(query: Record<string, unknown>): void {
  const inner = (query.query ?? { match_all: {} }) as Record<string, unknown>;
  if ("bool" in inner) {
    const bool = inner.bool as Record<string, unknown[]>;
    bool.must_not = [...(bool.must_not ?? []), ...DEFAULT_EXCLUSIONS];
  } else {
    query.query = { bool: { must: [inner], must_not: DEFAULT_EXCLUSIONS } };
  }
}

// ── Output ────────────────────────────────────────────────────────────────────

interface EsHit {
  _source: Record<string, unknown>;
}

function nested(source: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = source;
  for (const p of parts) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function str(source: Record<string, unknown>, ...paths: string[]): string {
  for (const path of paths) {
    const val = nested(source, path);
    if (typeof val === "string" && val) return val;
  }
  return "-";
}

const LEVEL_SHORT: Record<string, string> = {
  Information: "INFO", Warning: "WARN", Error: "ERROR", Debug: "DEBUG", Verbose: "TRACE",
  info: "INFO", warn: "WARN", error: "ERROR", debug: "DEBUG",
};

function formatResults(data: Record<string, unknown>, outfile: string): void {
  const hitsObj = data.hits as { hits: EsHit[]; total: { value: number } } | undefined;
  if (!hitsObj) {
    console.log("No hits object in response.");
    return;
  }

  const hits = hitsObj.hits ?? [];
  const total = hitsObj.total?.value ?? 0;
  console.log(`Total: ${total}  (showing ${hits.length})`);
  console.log();

  for (const h of hits) {
    const s = h._source;
    const ts = ((s["@timestamp"] as string) ?? "").slice(0, 19).replace("T", " ");
    const rawLevel = str(s, "level", "log.level");
    const level = LEVEL_SHORT[rawLevel] ?? rawLevel;
    const svc = str(s, "kubernetes.labels.release", "service_implementation", "app_name");
    const release = String(nested(s, "kubernetes.labels.pos-dev.de/azure-devops-release-id") ?? "");
    const msg = ((s.message as string) ?? "").slice(0, 200);
    const errMsg = str(s, "error.message", "error_message");
    const releaseTag = release ? ` [rel:${release}]` : "";

    console.log(`[${ts}] [${level.padStart(5)}] [${svc}]${releaseTag} ${msg}`);
    if (errMsg !== "-") console.log(`         ERROR: ${errMsg.slice(0, 200)}`);
  }

  console.log();
  console.log(`Index: ${INDEX}  |  Saved: ${outfile}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`kibana-logs — Elasticsearch log search via direct ES API

Usage:
  echo '<json>' | kibana-logs [env]

Environments: oae (default), prod, qss

Stdin: ES Query DSL JSON. Default index: logstash-*

Common query patterns:
  {"size":50,"sort":[{"@timestamp":{"order":"desc"}}],"query":{"bool":{
    "must":[{"term":{"level.keyword":"Error"}}],
    "filter":[{"range":{"@timestamp":{"gte":"now-1h"}}}]
  }}}

Field reference:
  level.keyword                    Error, Warning, Information, Debug (Serilog)
  service_implementation.keyword   core-service, invoice-service, etc.
  class_name.keyword               Full logger category name
  message                          Log message (full-text searchable)
  @timestamp                       ISO timestamp, use range queries

Environment variables:
  ELASTIC_INDEX                    Override index pattern (default: logstash-*)

Examples:
  echo '{"size":10,"query":{"term":{"level.keyword":"Error"}}}' | kibana-logs qss
  ELASTIC_INDEX=logstash-orangehub-regrinding kibana-logs oae <<< '{"size":5,"query":{"range":{"@timestamp":{"gte":"now-1h"}}}}'`);
  process.exit(0);
}

const query = await readStdinJson();
applyExclusions(query);

try {
  const auth = await getEsAuth();
  const result = await esSearch(query, auth);

  const outfile = `/tmp/kibana-logs-${Math.floor(Date.now() / 1000)}.json`;
  const { writeFile } = await import("node:fs/promises");
  await writeFile(outfile, JSON.stringify(result, null, 2));

  formatResults(result, outfile);
} catch (e) {
  console.error(`ERROR: ${(e as Error).message}`);
  process.exit(1);
}