#!/usr/bin/env tsx
/**
 * Grafana diagnostics via kubectl port-forward.
 *
 * Usage:
 *   tsx grafana-query.ts [env]   # env: qss (default), oae, prod
 *
 * Stdin JSON examples:
 *   {"action": "health", "namespace": "regrinding"}
 *   {"action": "health", "namespace": "regrinding", "service": "regrinding-core-service", "window": "10m"}
 *   {"action": "pods", "namespace": "regrinding"}
 *   {"action": "dashboards", "query": "regrinding"}
 *   {"action": "query", "expr": "sum(rate(istio_requests_total{...}[5m])) by (destination_service_name)"}
 */
import { withPortForward, kubectlJson, resolveContext } from "../kubectl-portforward.ts";
import { apiGet, parseInlineJsonArg, readJsonInput } from "../http.ts";

const inlineJson = parseInlineJsonArg();
const ENV = process.argv[2] ?? "qss";
const NS = "pos-monitoring";
const SVC = "pos-monitoring-grafana";
const REMOTE_PORT = 80;
// ── Credentials ───────────────────────────────────────────────────────────────

async function getCredentials(): Promise<{ user: string; password: string }> {
  const ctx = resolveContext(ENV);
  const secret = await kubectlJson([
    "get", "secret", "pos-monitoring-grafana",
    "-n", NS,
    "--context", ctx,
  ]) as { data: Record<string, string> };

  const decode = (b64: string) => Buffer.from(b64, "base64").toString("utf8");
  return {
    user: decode(secret.data["admin-user"]),
    password: decode(secret.data["admin-password"]),
  };
}

// ── Prometheus ────────────────────────────────────────────────────────────────

let promUid: string | undefined;

async function getPromUid(baseUrl: string, auth: string): Promise<string> {
  if (promUid) return promUid;
  const datasources = await apiGet(baseUrl, "/api/datasources", {}, { Authorization: `Basic ${auth}` }) as { uid: string; type: string; name: string }[];
  const prom = datasources.find((d) => d.type === "prometheus" && d.name === "prometheus");
  if (!prom) throw new Error(`No prometheus datasource found. Available: ${datasources.map((d) => `${d.name}(${d.type})`).join(", ")}`);
  promUid = prom.uid;
  return promUid;
}

async function promQuery(
  baseUrl: string,
  expr: string,
  auth: string,
): Promise<{ metric: Record<string, string>; value: [number, string] }[]> {
  const uid = await getPromUid(baseUrl, auth);
  const result = await apiGet(
    baseUrl,
    `/api/datasources/proxy/uid/${uid}/api/v1/query`,
    { query: expr },
    { Authorization: `Basic ${auth}` },
  ) as { data: { result: { metric: Record<string, string>; value: [number, string] }[] } };
  return result.data?.result ?? [];
}

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtBytes(b: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let val = b;
  for (const unit of units) {
    if (val < 1024) return `${val.toFixed(1)}${unit}`;
    val /= 1024;
  }
  return `${val.toFixed(1)}TB`;
}

function fmtCpu(cores: number): string {
  if (cores < 0.001) return "~0";
  if (cores < 1) return `${(cores * 1000).toFixed(0)}m`;
  return cores.toFixed(2);
}

async function printHealth(
  baseUrl: string, auth: string,
  namespace: string, service: string | undefined, window: string,
) {
  const svcFilter = service ? `, destination_service_name="${service}"` : "";
  const nsFilter = `destination_service_namespace="${namespace}"${svcFilter}`;

  const [reqRate, err5xx, err4xx, p99] = await Promise.all([
    promQuery(baseUrl, `sum by (destination_service_name) (rate(istio_requests_total{${nsFilter}}[${window}]))`, auth),
    promQuery(baseUrl, `sum by (destination_service_name) (rate(istio_requests_total{${nsFilter}, response_code=~"5.."}[${window}]))`, auth),
    promQuery(baseUrl, `sum by (destination_service_name) (rate(istio_requests_total{${nsFilter}, response_code=~"4.."}[${window}]))`, auth),
    promQuery(baseUrl, `histogram_quantile(0.99, sum by (le, destination_service_name) (rate(istio_request_duration_milliseconds_bucket{${nsFilter}}[${window}])))`, auth),
  ]);

  const e5Map = new Map(err5xx.map((r) => [r.metric.destination_service_name, parseFloat(r.value[1])]));
  const e4Map = new Map(err4xx.map((r) => [r.metric.destination_service_name, parseFloat(r.value[1])]));
  const p99Map = new Map(p99.map((r) => [r.metric.destination_service_name, parseFloat(r.value[1])]));

  const title = `namespace=${namespace}${service ? `, service=${service}` : ""}`;
  console.log(`Service Health — ${title}  (window=${window})\n`);
  console.log(`${"Service".padEnd(45)} ${"Req/s".padStart(7)}  ${"5xx/s".padStart(7)}  ${"4xx/s".padStart(7)}  ${"p99(ms)".padStart(8)}`);
  console.log("-".repeat(85));

  const sorted = [...reqRate].sort((a, b) => parseFloat(b.value[1]) - parseFloat(a.value[1]));
  for (const r of sorted) {
    const svc = r.metric.destination_service_name ?? "?";
    const rps = parseFloat(r.value[1]);
    const e5 = e5Map.get(svc) ?? 0;
    const e4 = e4Map.get(svc) ?? 0;
    const p = p99Map.get(svc);
    const p99Str = p !== undefined && !isNaN(p) ? p.toFixed(1) : "n/a";
    const errMark = e5 > 0 ? " ✗" : "";
    console.log(`${svc.padEnd(45)} ${rps.toFixed(3).padStart(7)}  ${e5.toFixed(4).padStart(7)}  ${e4.toFixed(4).padStart(7)}  ${p99Str.padStart(8)}${errMark}`);
  }

  if (!reqRate.length) {
    console.log(`  No traffic found for namespace '${namespace}'${service ? ` service ${service}` : ""} in last ${window}.`);
  }
}

async function printPods(baseUrl: string, auth: string, namespace: string) {
  const [cpuResults, memResults] = await Promise.all([
    promQuery(baseUrl, `sum by (pod, container) (rate(container_cpu_usage_seconds_total{namespace="${namespace}", container!="", container!="POD"}[5m]))`, auth),
    promQuery(baseUrl, `sum by (pod, container) (container_memory_working_set_bytes{namespace="${namespace}", container!="", container!="POD"})`, auth),
  ]);

  const cpuMap = new Map(cpuResults.map((r) => [`${r.metric.pod}/${r.metric.container}`, parseFloat(r.value[1])]));
  const memMap = new Map(memResults.map((r) => [`${r.metric.pod}/${r.metric.container}`, parseFloat(r.value[1])]));
  const keys = [...new Set([...cpuMap.keys(), ...memMap.keys()])].sort();

  console.log(`Pod Resource Usage — namespace=${namespace}  (CPU=5m avg)\n`);
  console.log(`${"Pod/Container".padEnd(65)} ${"CPU".padStart(8)}  ${"Memory".padStart(10)}`);
  console.log("-".repeat(88));

  let currentPod = "";
  for (const key of keys) {
    const [pod, container] = key.split("/");
    if (pod !== currentPod) {
      if (currentPod) console.log();
      currentPod = pod;
      console.log(`  ${pod}`);
    }
    const cpu = cpuMap.get(key) ?? 0;
    const mem = memMap.get(key) ?? 0;
    const cpuFlag = cpu > 0.5 ? " ⚠" : "";
    const memFlag = mem > 500 * 1024 * 1024 ? " ⚠" : "";
    console.log(`    ${container.padEnd(61)} ${fmtCpu(cpu).padStart(8)}${cpuFlag}  ${fmtBytes(mem).padStart(10)}${memFlag}`);
  }

  if (!keys.length) console.log(`  No pods found in namespace '${namespace}'.`);
}

async function printDashboards(baseUrl: string, auth: string, query: string) {
  const items = await apiGet(baseUrl, "/api/search", { query, limit: 30, type: "dash-db" }, { Authorization: `Basic ${auth}` }) as { title: string; url: string }[];
  console.log(`Dashboards matching '${query}'  (${items.length} found)\n`);
  for (const item of items) {
    console.log(`  ${item.title}`);
    console.log(`    ${baseUrl.replace("http://localhost", "grafana-local")}${item.url}`);
  }
}

async function printQuery(baseUrl: string, auth: string, expr: string) {
  const results = await promQuery(baseUrl, expr, auth);
  console.log(`PromQL: ${expr}\n`);
  for (const r of results) {
    const labels = Object.fromEntries(Object.entries(r.metric).filter(([k]) => k !== "__name__"));
    console.log(`  ${JSON.stringify(labels)}  →  ${parseFloat(r.value[1]).toFixed(4)}`);
  }
  if (!results.length) console.log("  No results.");
}

// ── Main ──────────────────────────────────────────────────────────────────────

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`grafana — Grafana diagnostics via kubectl port-forward

Usage:
  grafana [env] -j '<json>'
  echo '<json>' | grafana [env]

Environments: qss (default), oae, prod

Actions (JSON stdin):
  {"action":"health","namespace":"<ns>"}                    Service health (req rate, errors, p99)
  {"action":"health","namespace":"<ns>","service":"<svc>","window":"10m"}
  {"action":"pods","namespace":"<ns>"}                      Pod CPU and memory usage
  {"action":"dashboards","query":"<keyword>"}               Search dashboards
  {"action":"query","expr":"<promql>"}                      Raw PromQL query

Options:
  namespace    K8s namespace (required for health/pods)
  service      Filter to a specific service (optional)
  window       Prometheus rate window: 1m, 5m, 10m, 30m, 1h (default: 5m)

Examples:
  echo '{"action":"health","namespace":"regrinding"}' | grafana qss
  echo '{"action":"pods","namespace":"tlm"}' | grafana oae
  echo '{"action":"dashboards","query":"ingress"}' | grafana prod`);
  process.exit(0);
}

const q = await readJsonInput(inlineJson);
const action = (q.action as string) ?? "health";

// Start credential fetch early — it runs in parallel with port-forward setup
const credsPromise = getCredentials();

try {
  await withPortForward(ENV, NS, SVC, REMOTE_PORT, async (port) => {
    const creds = await credsPromise;
    const auth = Buffer.from(`${creds.user}:${creds.password}`).toString("base64");
    const base = `http://localhost:${port}`;

    if (action === "health") {
      const ns = q.namespace as string;
      if (!ns) throw new Error("'namespace' required");
      await printHealth(base, auth, ns, q.service as string | undefined, (q.window as string) ?? "5m");

    } else if (action === "pods") {
      const ns = q.namespace as string;
      if (!ns) throw new Error("'namespace' required");
      await printPods(base, auth, ns);

    } else if (action === "dashboards") {
      await printDashboards(base, auth, (q.query as string) ?? "");

    } else if (action === "query") {
      const expr = q.expr as string;
      if (!expr) throw new Error("'expr' required");
      await printQuery(base, auth, expr);

    } else {
      throw new Error(`Unknown action '${action}'. Use: health, pods, dashboards, query`);
    }
  });
} catch (e) {
  console.error(`ERROR: ${(e as Error).message}`);
  process.exit(1);
}