#!/usr/bin/env tsx
/**
 * Elasticsearch log search via direct ES API (bypasses Kibana + App Gateway).
 * Credentials are read from environment variables at runtime.
 *
 * Usage:
 *   tsx kibana-search.ts [env] [index] [-q term] [--from time] [--to time] [-n size]
 *   echo '<json>' | tsx kibana-search.ts [env] [index]
 */
import { readStdinJson } from '../http.ts';
import {
  LEVEL_SHORT,
  type EsHit,
  type EsResult,
  esGetDoc,
  getEsAuth,
  esSearch,
  applyDefaults,
  resolveIndex,
  nested,
  str,
  strWithField,
} from './kibana-shared.ts';

// ── Arg parsing ──────────────────────────────────────────────────────────────

interface ParsedArgs {
  env: string;
  index: string;
  query?: string;
  dsl?: string;
  size: number;
  from?: string;
  to?: string;
  raw?: boolean;
  getDocId?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  let env = 'oae';
  let index = 'regrinding';
  let query: string | undefined;
  let dsl: string | undefined;
  let size = 50;
  let from: string | undefined;
  let to: string | undefined;
  let raw = false;
  let getDocId: string | undefined;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-q' && i + 1 < args.length) {
      query = args[++i];
    } else if (args[i] === '-j' && i + 1 < args.length) {
      dsl = args[++i];
    } else if (args[i] === '-n' && i + 1 < args.length) {
      size = parseInt(args[++i], 10);
    } else if (args[i] === '--from' && i + 1 < args.length) {
      from = args[++i];
    } else if (args[i] === '--to' && i + 1 < args.length) {
      to = args[++i];
    } else if (args[i] === '--raw') {
      raw = true;
    } else if (args[i] === '--get' && i + 1 < args.length) {
      getDocId = args[++i];
    } else {
      positional.push(args[i]);
    }
  }

  if (positional[0]) env = positional[0];
  if (positional[1]) index = positional[1];
  if (query && !from) from = 'now-1h';
  return { env, index, query, dsl, size, from, to, raw, getDocId };
}

const parsed = parseArgs(process.argv);
const ENV = (parsed.env as string).toUpperCase();

let INDEX: string;
try {
  INDEX = resolveIndex(parsed.index);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}

// ── Get single document by _id ───────────────────────────────────────────────

if (parsed.getDocId) {
  try {
    const auth = await getEsAuth(ENV);
    const doc = await esGetDoc(ENV, INDEX, parsed.getDocId, auth);
    if (!doc) {
      console.error(`Document ${parsed.getDocId} not found in ${INDEX}`);
      process.exit(1);
    }
    console.log(JSON.stringify(doc, null, 2));
  } catch (e) {
    console.error(`ERROR: ${(e as Error).message}`);
    process.exit(1);
  }
  process.exit(0);
}

// ── Output ────────────────────────────────────────────────────────────────────

/**
 * Format a long log message by separating the error message from the stack trace.
 * Shows the full error message (including response bodies, validation errors),
 * then a condensed stack trace with only application frames.
 */
function formatLongMessage(raw: string): string {
  const trimmed = raw.trim();

  // Split on stack trace boundary: "   at " preceded by content
  const atPattern = /\s{2,}at /;
  const firstAt = trimmed.search(atPattern);
  if (firstAt <= 0) return trimmed; // no stack trace, show as-is

  const message = trimmed.slice(0, firstAt).trim();
  const stackPart = trimmed.slice(firstAt);

  // Extract stack frames
  const frames = stackPart
    .split(/\s{2,}at /)
    .map((f) => f.trim())
    .filter(Boolean);

  // Middleware entry-point frames (noise at bottom of every stack trace)
  const entryPointNoise = [
    'LogHttpRequestMiddleware',
    'ExceptionHandlerMiddlewareImpl',
    'RequestLoggingMiddleware',
    'SwaggerMiddleware',
    'SwaggerUIMiddleware',
  ];

  // Keep application frames, inner exceptions, and DB error metadata
  const appFrames: string[] = [];
  let lastFrame = '';
  for (const frame of frames) {
    const isInnerException =
      frame.includes('--->') ||
      frame.includes('Exception data:') ||
      frame.includes('Severity:') ||
      frame.includes('SqlState:') ||
      frame.includes('MessageText:');

    const isAppFrame =
      frame.startsWith('Hoffmann.') && !entryPointNoise.some((n) => frame.includes(n));

    // Deduplicate: skip if same method as previous (e.g. repeated DocumentExecuter frames)
    const methodSig = frame.split(' in ')[0];
    if (!isInnerException && methodSig === lastFrame) continue;
    lastFrame = methodSig;

    if (isAppFrame) {
      appFrames.push(`at ${frame}`);
    } else if (isInnerException) {
      appFrames.push(frame);
    }
  }

  const totalFrames = frames.length;
  const omitted = totalFrames - appFrames.length;

  let result = message;
  if (appFrames.length > 0) {
    result += '\n    ' + appFrames.join('\n    ');
  }
  if (omitted > 0) {
    result += `\n    ... ${omitted} framework frames omitted`;
  }
  return result;
}

function formatResults(data: EsResult, outfile: string): void {
  const hits = data.hits?.hits ?? [];
  const total = data.hits?.total?.value;
  console.log(`${total != null ? total : '?'} hits (${hits.length} shown)`);

  // Check if results contain multiple releases (worth showing release IDs)
  const releases = new Set(
    hits
      .map((h) =>
        String(nested(h._source, 'kubernetes.labels.pos-dev.de/azure-devops-release-id') ?? '')
      )
      .filter(Boolean)
  );
  const multiRelease = releases.size > 1;

  // Summary counters
  const levelCounts = new Map<string, number>();
  const dateCounts = new Map<string, number>();
  const svcCounts = new Map<string, number>();
  const traceIds = new Set<string>();
  let traceField = '';

  // Pre-scan for summary
  for (const h of hits) {
    const s = h._source;
    const rawLevel = str(s, 'level', 'log.level');
    const level = LEVEL_SHORT[rawLevel] ?? rawLevel;
    levelCounts.set(level, (levelCounts.get(level) ?? 0) + 1);

    const ts = (s['@timestamp'] as string) ?? '';
    if (ts.length >= 10) {
      const date = ts.slice(5, 10); // MM-DD
      dateCounts.set(date, (dateCounts.get(date) ?? 0) + 1);
    }

    const svc = str(s, 'service_implementation', 'kubernetes.labels.release', 'app_name');
    if (svc !== '-') svcCounts.set(svc, (svcCounts.get(svc) ?? 0) + 1);

    const { value: tid, field } = strWithField(
      s,
      'trace-id',
      'jaeger-trace-id',
      'trace_id',
      'TraceId'
    );
    if (tid !== '-') {
      traceIds.add(tid);
      if (!traceField) traceField = field;
    }
  }

  // Print summary block
  if (hits.length > 0) {
    console.log('--- summary ---');
    if (traceField) console.log(`trace-field: ${traceField}`);
    if (levelCounts.size > 0) {
      const parts = [...levelCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}=${v}`);
      console.log(`levels: ${parts.join(' ')}`);
    }
    if (dateCounts.size > 0) {
      const parts = [...dateCounts.entries()].sort().map(([k, v]) => `${k}=${v}`);
      console.log(`dates: ${parts.join(' ')}`);
    }
    if (svcCounts.size > 0) {
      const parts = [...svcCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}=${v}`);
      console.log(`services: ${parts.join(' ')}`);
    }
    if (traceIds.size > 0) console.log(`traces: ${traceIds.size}`);
    console.log('---');
  }

  // Build the --get hint command prefix for copy-paste
  const getCmd = `tsx ${process.argv[1]} ${ENV} ${parsed.index} --get`;

  for (const h of hits) {
    const s = h._source;
    const docId = h._id ?? '';
    const ts = ((s['@timestamp'] as string) ?? '').slice(5, 19).replace('T', ' ');
    const rawLevel = str(s, 'level', 'log.level');
    const level = LEVEL_SHORT[rawLevel] ?? rawLevel;
    const svc = str(s, 'service_implementation', 'kubernetes.labels.release', 'app_name');
    const className = str(s, 'class_name');
    const traceId = str(s, 'trace-id', 'jaeger-trace-id');
    const correlationId = str(s, 'correlation-id', 'x-correlation-id');
    const msg = (s.message as string) ?? '';
    const log = (s.log as string) ?? '';
    const logMsg = msg.length > log.length ? msg : log;
    const errMsg = str(s, 'error.message', 'error_message');

    if (logMsg?.trim() === '-') {
      continue;
    }

    const tags: string[] = [];
    if (multiRelease) {
      const rel = String(nested(s, 'kubernetes.labels.pos-dev.de/azure-devops-release-id') ?? '');
      if (rel) tags.push(`r:${rel}`);
    }
    if (className !== '-' && className.startsWith('Hoffmann')) {
      tags.push(className.split('.').pop()!);
    }
    if (traceId !== '-') tags.push(`t:${traceId}`);
    if (correlationId !== '-' && correlationId !== 'null')
      tags.push(`c:${correlationId.slice(0, 8)}`);
    if (docId) tags.push(`id:${docId}`);
    const tagStr = tags.length ? ` [${tags.join('|')}]` : '';

    const isLong = logMsg.length > 120 || logMsg.includes('\n');
    const errSuffix = errMsg !== '-' ? `\n  ERR: ${errMsg}` : '';
    if (isLong) {
      console.log(
        `${ts} ${level.padStart(5)} ${svc}${tagStr}\n  ${formatLongMessage(logMsg)}${errSuffix}`
      );
    } else {
      const inlineErr = errMsg !== '-' ? ` ERR: ${errMsg}` : '';
      console.log(`${ts} ${level.padStart(5)} ${svc}${tagStr} ${logMsg}${inlineErr}`);
    }
  }

  console.log(`idx:${INDEX} saved:${outfile}`);
  console.log(`get: ${getCmd} <id>`);
}

// ── Detail subcommand ───────────────────────────────────────────────────────
// Reads a saved JSON file and prints expanded detail for filtered hits.

if (process.argv.includes('--detail')) {
  const detailIdx = process.argv.indexOf('--detail');
  const filePath = process.argv[detailIdx + 1];
  if (!filePath) {
    console.error(
      'Usage: kibana-search --detail <saved-json-file> [--level Error] [--grep <pattern>] [--fields]'
    );
    process.exit(1);
  }

  const { readFile } = await import('node:fs/promises');
  let data: { hits: { hits: EsHit[] } };
  try {
    data = JSON.parse(await readFile(filePath, 'utf8'));
  } catch (e) {
    console.error(`Cannot read ${filePath}: ${(e as Error).message}`);
    process.exit(1);
  }

  const hits = data.hits?.hits ?? [];

  // --fields: just print available field names
  if (process.argv.includes('--fields')) {
    if (hits.length === 0) {
      console.log('No hits.');
      process.exit(0);
    }
    const keys = new Set<string>();
    for (const h of hits.slice(0, 5)) {
      for (const k of Object.keys(h._source)) keys.add(k);
    }
    console.log([...keys].sort().join('\n'));
    process.exit(0);
  }

  // Filter hits
  let filtered = hits;
  const levelFilter = process.argv.includes('--level')
    ? process.argv[process.argv.indexOf('--level') + 1]
    : null;
  const grepFilter = process.argv.includes('--grep')
    ? process.argv[process.argv.indexOf('--grep') + 1]
    : null;

  if (levelFilter) {
    filtered = filtered.filter((h) => {
      const lvl = str(h._source, 'level', 'log.level');
      return (
        lvl.toLowerCase() === levelFilter.toLowerCase() ||
        (LEVEL_SHORT[lvl] ?? '').toLowerCase() === levelFilter.toLowerCase()
      );
    });
  }
  if (grepFilter) {
    const pat = grepFilter.toLowerCase();
    filtered = filtered.filter((h) => {
      const s = h._source;
      const text = [
        s.message,
        s.log,
        (s as Record<string, unknown>)['error.message'],
        (s as Record<string, unknown>)['error_message'],
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return text.includes(pat);
    });
  }

  console.log(`${filtered.length} of ${hits.length} hits`);
  const seen = new Set<string>();
  for (const h of filtered) {
    const s = h._source;
    const ts = (s['@timestamp'] as string) ?? '';
    const rawLevel = str(s, 'level', 'log.level');
    const level = LEVEL_SHORT[rawLevel] ?? rawLevel;
    const svc = str(s, 'service_implementation', 'kubernetes.labels.release', 'app_name');
    const traceId = str(s, 'trace-id', 'jaeger-trace-id');
    const msg = (s.message as string) ?? (s.log as string) ?? '';
    const errMsg = str(s, 'error.message', 'error_message');

    // Deduplicate by message prefix
    const dedup = `${level}:${msg.slice(0, 80)}`;
    if (seen.has(dedup)) continue;
    seen.add(dedup);

    console.log('---');
    console.log(`time: ${ts}`);
    console.log(`level: ${level}  service: ${svc}`);
    if (traceId !== '-') console.log(`trace: ${traceId}`);
    console.log(`message: ${msg}`);
    if (errMsg !== '-') console.log(`error: ${errMsg}`);
  }
  process.exit(0);
}

// ── Main ──────────────────────────────────────────────────────────────────────

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`kibana-logs — Elasticsearch log search via direct ES API

Usage:
  kibana-logs [env] [index] [-q term] [--from time] [--to time] [-n size]
  kibana-logs [env] [index] -j '<query-json>'
  echo '<json>' | kibana-logs [env] [index]

Detail mode (inspect saved results):
  kibana-logs --detail <saved-json> [--level Error] [--grep <pattern>] [--fields]

Environments: oae (default), prod, qss
Indices:      regrinding (default), digital-twin, order-data-hub

Options:
  -q <term>      Quick search: wildcard on message+log fields (e.g. -q '*serial*')
  --from <time>  Start of time range (ES date math: now-1h, now-7d, 2026-03-18T10:00:00)
  --to <time>    End of time range (default: now)
  -n <size>      Number of results (default: 50)
  -j '<json>'    ES Query DSL as argument (alternative to stdin)
  --raw          Skip message-existence filter and default exclusions (for unstructured log-only entries)
  --get <id>     Fetch a single document by ES _id and print full raw JSON

Detail options:
  --detail <file>   Read saved JSON and print expanded hit detail
  --level <level>   Filter by log level (Error, Warning, Info, etc.)
  --grep <pattern>  Filter by substring in message/error fields
  --fields          Print available field names and exit

Field reference:
  level.keyword                    Error, Warning, Information, Debug (Serilog)
  service_implementation.keyword   core-service, invoice-service, etc.
  class_name.keyword               Full logger category name
  message                          Log message (full-text searchable)
  @timestamp                       ISO timestamp, use range queries

Examples:
  kibana-logs oae regrinding -q '*serial*'
  kibana-logs oae regrinding -q '*error*' --from now-1h
  kibana-logs prod digital-twin -q '*migration*' --from now-24h --to now-1h -n 20
  echo '{"size":10,"query":{"term":{"level.keyword":"Error"}}}' | kibana-logs qss digital-twin
  kibana-logs --detail /tmp/kibana-logs-123.json --level Error
  kibana-logs --detail /tmp/kibana-logs-123.json --grep "BadRequest"
  kibana-logs --detail /tmp/kibana-logs-123.json --fields`);
  process.exit(0);
}

let query: Record<string, unknown>;
if (parsed.query) {
  const must: Record<string, unknown>[] = [
    { query_string: { query: parsed.query, fields: ['message', 'log'] } },
  ];
  const filter: Record<string, unknown>[] = [];
  const range: Record<string, string> = {};
  if (parsed.from) range.gte = parsed.from;
  if (parsed.to) range.lte = parsed.to;
  if (Object.keys(range).length) filter.push({ range: { '@timestamp': range } });

  query = {
    size: parsed.size,
    query: { bool: { must, filter } },
  };
} else if (parsed.dsl) {
  try {
    query = JSON.parse(parsed.dsl);
  } catch {
    console.error('ERROR: Invalid JSON in -j argument');
    process.exit(1);
  }
} else {
  if (process.stdin.isTTY) {
    console.error(
      'No query provided. Use -q for quick search, -j for JSON, or pipe JSON to stdin.\nRun with --help for usage.'
    );
    process.exit(1);
  }
  query = await readStdinJson();
}
applyDefaults(query, { raw: parsed.raw });

try {
  const auth = await getEsAuth(ENV);
  const result = await esSearch(ENV, INDEX, query, auth);

  const outfile = `/tmp/kibana-logs-${Math.floor(Date.now() / 1000)}.json`;
  const { writeFile } = await import('node:fs/promises');
  await writeFile(outfile, JSON.stringify(result));

  formatResults(result, outfile);
} catch (e) {
  console.error(`ERROR: ${(e as Error).message}`);
  process.exit(1);
}
