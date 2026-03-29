/**
 * Shared Elasticsearch primitives for kibana-search and kibana-traffic.
 */

// ── Config ───────────────────────────────────────────────────────────────────

export const INDEX_ALIASES: Record<string, string> = {
  'digital-twin': 'logstash-orangehub-digital-twin-*',
  regrinding: 'logstash-orangehub-regrinding-*',
  calibration: 'logstash-orangehub-calibration-*',
  'order-data-hub': 'logstash-orangehub-order-data-hub-*',
};

export const ES_HOSTS: Record<string, string> = {
  oae: 'https://we-pos-oae.es.westeurope.azure.elastic-cloud.com',
  prod: 'https://we-pos-prod.es.westeurope.azure.elastic-cloud.com',
  qss: 'https://we-pos-qss.es.westeurope.azure.elastic-cloud.com',
};

export const SOURCE_FIELDS = [
  '@timestamp',
  'level',
  'log.level',
  'service_implementation',
  'kubernetes.labels.release',
  'app_name',
  'class_name',
  'TraceId',
  'trace-id',
  'jaeger-trace-id',
  'trace_id',
  'correlation-id',
  'x-correlation-id',
  'message',
  'log',
  'error.message',
  'error_message',
  'kubernetes.labels.pos-dev.de/azure-devops-release-id',
];

export const DEFAULT_EXCLUSIONS: Record<string, unknown>[] = [
  {
    terms: {
      class_name: [
        'Serilog.AspNetCore.RequestLoggingMiddleware',
        'Hoffmann.Regrinding.Common.Client.OAuth2Authenticator',
        'System.Net.Http.HttpClient.OtlpTraceExporter.ClientHandler',
      ],
    },
  },
  { wildcard: { class_name: { value: '*HealthCheck' } } },
];

export const LEVEL_SHORT: Record<string, string> = {
  Information: 'INFO',
  Warning: 'WARN',
  Error: 'ERROR',
  Debug: 'DEBUG',
  Verbose: 'TRACE',
  info: 'INFO',
  warn: 'WARN',
  error: 'ERROR',
  debug: 'DEBUG',
};

// ── Types ────────────────────────────────────────────────────────────────────

export interface EsHit {
  _id?: string;
  _index?: string;
  _source: Record<string, unknown>;
}

export interface EsResult {
  hits: { hits: EsHit[]; total: { value: number } };
}

// ── Credentials ──────────────────────────────────────────────────────────────

export function getEsAuth(env: string): string {
  const envVar = `${env.toUpperCase()}_POS_ELASTIC_USER_PASSWORD`;
  const password = process.env[envVar];
  if (!password) throw new Error(`Missing env var ${envVar}`);
  return Buffer.from(`elastic:${password}`).toString('base64');
}

// ── ES API ───────────────────────────────────────────────────────────────────

export async function esSearch(
  env: string,
  esIndex: string,
  query: Record<string, unknown>,
  auth: string,
): Promise<EsResult> {
  const host = ES_HOSTS[env.toLowerCase()];
  if (!host) throw new Error(`Unknown env '${env}'. Use: oae, prod, qss`);

  const url = `${host}/${encodeURIComponent(esIndex)}/_search?filter_path=hits.total.value,hits.hits._id,hits.hits._index,hits.hits._source`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(query),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 400)}`);
  }
  return res.json() as Promise<EsResult>;
}

/** Fetch a single document by _id across all indices matching the pattern. */
export async function esGetDoc(
  env: string,
  esIndex: string,
  docId: string,
  auth: string,
): Promise<Record<string, unknown> | null> {
  const host = ES_HOSTS[env.toLowerCase()];
  if (!host) throw new Error(`Unknown env '${env}'. Use: oae, prod, qss`);

  const url = `${host}/${encodeURIComponent(esIndex)}/_search`;
  const body = { size: 1, query: { ids: { values: [docId] } } };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
  const data = (await res.json()) as { hits?: { hits?: { _id: string; _index: string; _source: Record<string, unknown> }[] } };
  const hit = data.hits?.hits?.[0];
  return hit ? { _id: hit._id, _index: hit._index, ...hit._source } : null;
}

// ── Query helpers ────────────────────────────────────────────────────────────

export interface ApplyDefaultsOptions {
  /** When true, skip the `exists: message` filter so unstructured log-only entries are included. */
  raw?: boolean;
}

export function applyDefaults(query: Record<string, unknown>, opts: ApplyDefaultsOptions = {}): void {
  if (!('_source' in query)) query._source = SOURCE_FIELDS;
  if (!('sort' in query)) query.sort = [{ '@timestamp': { order: 'desc' } }];
  if (!('track_total_hits' in query)) query.track_total_hits = false;

  const inner = (query.query ?? { match_all: {} }) as Record<string, unknown>;
  const filters: Record<string, unknown>[] = [];
  if (!opts.raw) filters.push({ exists: { field: 'message' } });
  if ('bool' in inner) {
    const bool = inner.bool as Record<string, unknown[]>;
    if (!opts.raw) bool.must_not = [...(bool.must_not ?? []), ...DEFAULT_EXCLUSIONS];
    bool.filter = [...(bool.filter ?? []), ...filters];
  } else {
    query.query = {
      bool: {
        must: [inner],
        must_not: opts.raw ? [] : DEFAULT_EXCLUSIONS,
        filter: filters,
      },
    };
  }
}

export function resolveIndex(alias: string): string {
  const idx = INDEX_ALIASES[alias];
  if (!idx) {
    const aliases = Object.keys(INDEX_ALIASES).join(', ');
    throw new Error(`Unknown index '${alias}'. Use one of: ${aliases}`);
  }
  return idx;
}

// ── Field accessors ──────────────────────────────────────────────────────────

export function nested(source: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let cur: unknown = source;
  for (const p of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

export function str(source: Record<string, unknown>, ...paths: string[]): string {
  return strWithField(source, ...paths).value;
}

export function strWithField(
  source: Record<string, unknown>,
  ...paths: string[]
): { value: string; field: string } {
  for (const path of paths) {
    const val = nested(source, path);
    if (typeof val === 'string' && val) return { value: val, field: path };
  }
  return { value: '-', field: '' };
}

/** Normalized short level (INFO, WARN, ERROR, etc.) */
export function level(source: Record<string, unknown>): string {
  const raw = str(source, 'level', 'log.level');
  return LEVEL_SHORT[raw] ?? raw;
}

/** Service name from the best available field */
export function service(source: Record<string, unknown>): string {
  return str(source, 'service_implementation', 'kubernetes.labels.release', 'app_name');
}

/** Log message (picks the longer of message vs log) */
export function message(source: Record<string, unknown>): string {
  const msg = (source.message as string) ?? '';
  const log = (source.log as string) ?? '';
  return msg.length > log.length ? msg : log;
}

/** ISO timestamp trimmed to seconds */
export function timestamp(source: Record<string, unknown>): string {
  return ((source['@timestamp'] as string) ?? '').slice(0, 19);
}