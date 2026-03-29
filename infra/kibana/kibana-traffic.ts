#!/usr/bin/env tsx
/**
 * Traffic health report for Elasticsearch-backed services.
 * Runs two queries in parallel (broad + errors/warnings), analyzes the results,
 * and outputs a structured markdown report.
 *
 * Usage:
 *   kibana-traffic <env> <index> [--from time] [--to time]
 *
 * Examples:
 *   kibana-traffic prod regrinding
 *   kibana-traffic prod calibration --from now-6h
 */
import {
  type EsHit,
  getEsAuth,
  esSearch,
  applyDefaults,
  resolveIndex,
  str,
  level,
  service,
  message,
  timestamp,
} from './kibana-shared.ts';

// ── Arg parsing ──────────────────────────────────────────────────────────────

interface ParsedArgs {
  env: string;
  index: string;
  from: string;
  to?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  let env = 'oae';
  let index = 'regrinding';
  let from = 'now-3h';
  let to: string | undefined;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--from' && i + 1 < args.length) {
      from = args[++i];
    } else if (args[i] === '--to' && i + 1 < args.length) {
      to = args[++i];
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`kibana-traffic — Traffic health report from Elasticsearch

Usage:
  kibana-traffic <env> <index> [--from time] [--to time]

Environments: oae (default), prod, qss
Indices:      regrinding (default), digital-twin, calibration, order-data-hub

Options:
  --from <time>  Start of time range (default: now-3h)
  --to <time>    End of time range (default: now)

Examples:
  kibana-traffic prod regrinding
  kibana-traffic prod calibration --from now-6h
  kibana-traffic oae digital-twin --from 2026-03-18T00:00:00 --to 2026-03-18T12:00:00`);
      process.exit(0);
    } else {
      positional.push(args[i]);
    }
  }

  if (positional[0]) env = positional[0];
  if (positional[1]) index = positional[1];
  return { env, index, from, to };
}

// ── Analysis ─────────────────────────────────────────────────────────────────

interface ServiceStats {
  count: number;
  uniquePatterns: number;
  levels: Map<string, number>;
}

interface ErrorGroup {
  type: string;
  message: string;
  service: string;
  count: number;
  traceIds: string[];
  entities: string[];
}

interface WarningGroup {
  category: string;
  message: string;
  service: string;
  count: number;
}

interface TrafficReport {
  env: string;
  index: string;
  from: string;
  to: string;
  broadHitCount: number;
  broadTimeSpanMinutes: number;
  earliestTs: string;
  latestTs: string;
  serviceStats: Map<string, ServiceStats>;
  levelTotals: Map<string, number>;
  traceCount: number;
  uniquePatterns: number;
  errorHitCount: number;
  warnHitCount: number;
  errorGroups: ErrorGroup[];
  warningGroups: WarningGroup[];
}

/** Strip variable parts (GUIDs, long numbers, durations) to get a stable pattern key */
function normalizeMessage(msg: string): string {
  return msg
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<GUID>')
    .replace(/\b\d{10,}\b/g, '<ID>')
    .replace(/\b\d+\.\d{2,}\s*ms\b/g, '<DUR>')
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[^\s]*/g, '<TS>')
    .slice(0, 120);
}

function extractExceptionType(msg: string, className: string): string {
  const match = msg.match(/(\w+(?:\.\w+)*Exception)\b/);
  if (match) return match[1].split('.').pop()!;
  if (className !== '-') return className.split('.').pop()!;
  return msg.trim().slice(0, 60) || 'Unknown';
}

function extractEntities(msg: string): string[] {
  const entities: string[] = [];
  const guids = msg.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi);
  if (guids) entities.push(...guids.slice(0, 3));
  const nums = msg.match(/\b\d{10,}\b/g);
  if (nums) entities.push(...nums.slice(0, 3));
  return [...new Set(entities)];
}

function analyzeHits(hits: EsHit[]) {
  const serviceStats = new Map<string, ServiceStats>();
  const levelTotals = new Map<string, number>();
  const traceIds = new Set<string>();
  const globalPatterns = new Set<string>();
  const svcPatterns = new Map<string, Set<string>>();
  let earliestTs = '';
  let latestTs = '';

  for (const h of hits) {
    const s = h._source;
    const lvl = level(s);
    const svc = service(s);
    const ts = timestamp(s);
    const msg = message(s);
    const pattern = `${svc}::${lvl}::${normalizeMessage(msg)}`;

    globalPatterns.add(pattern);
    levelTotals.set(lvl, (levelTotals.get(lvl) ?? 0) + 1);

    if (svc !== '-') {
      const stats = serviceStats.get(svc) ?? { count: 0, uniquePatterns: 0, levels: new Map() };
      stats.count++;
      stats.levels.set(lvl, (stats.levels.get(lvl) ?? 0) + 1);
      serviceStats.set(svc, stats);

      if (!svcPatterns.has(svc)) svcPatterns.set(svc, new Set());
      svcPatterns.get(svc)!.add(pattern);
    }

    const tid = str(s, 'trace-id', 'jaeger-trace-id', 'trace_id', 'TraceId');
    if (tid !== '-') traceIds.add(tid);

    if (ts && (!earliestTs || ts < earliestTs)) earliestTs = ts;
    if (ts && (!latestTs || ts > latestTs)) latestTs = ts;
  }

  for (const [svc, stats] of serviceStats) {
    stats.uniquePatterns = svcPatterns.get(svc)?.size ?? 0;
  }

  return { serviceStats, levelTotals, traceIds, globalPatterns, earliestTs, latestTs };
}

function groupErrors(hits: EsHit[]): ErrorGroup[] {
  const groups = new Map<string, ErrorGroup>();

  for (const h of hits) {
    const s = h._source;
    if (level(s) !== 'ERROR') continue;

    const msg = message(s);
    const svc = service(s);
    const className = str(s, 'class_name');
    const tid = str(s, 'trace-id', 'jaeger-trace-id', 'trace_id', 'TraceId');

    const exType = extractExceptionType(msg, className);
    const key = `${svc}::${exType}`;

    const group = groups.get(key) ?? {
      type: exType,
      message: msg.slice(0, 200),
      service: svc,
      count: 0,
      traceIds: [],
      entities: [],
    };
    group.count++;
    if (tid !== '-' && !group.traceIds.includes(tid)) group.traceIds.push(tid);
    for (const e of extractEntities(msg)) {
      if (!group.entities.includes(e)) group.entities.push(e);
    }
    groups.set(key, group);
  }

  return [...groups.values()].sort((a, b) => b.count - a.count);
}

function groupWarnings(hits: EsHit[]): WarningGroup[] {
  const groups = new Map<string, WarningGroup>();

  for (const h of hits) {
    const s = h._source;
    if (level(s) !== 'WARN') continue;

    const msg = message(s);
    const svc = service(s);
    const className = str(s, 'class_name');

    let category = className !== '-' ? className.split('.').pop()! : 'Unknown';
    const bracketMatch = msg.match(/\[(\w+)\]/);
    if (bracketMatch && className === '-') category = bracketMatch[1];

    const key = `${svc}::${category}`;
    const group = groups.get(key) ?? { category, message: msg.slice(0, 200), service: svc, count: 0 };
    group.count++;
    groups.set(key, group);
  }

  return [...groups.values()].sort((a, b) => b.count - a.count);
}

// ── Report formatting ────────────────────────────────────────────────────────

function formatReport(report: TrafficReport): string {
  const lines: string[] = [];
  const w = (s: string) => lines.push(s);

  const envUpper = report.env.toUpperCase();
  const idxTitle = report.index.charAt(0).toUpperCase() + report.index.slice(1);
  w(`## ${envUpper} ${idxTitle} Traffic Report`);
  w(`**Window:** ${report.earliestTs || report.from} → ${report.latestTs || report.to}`);
  w('');

  w('### Overall Health');
  w('');
  w('| Metric | Value |');
  w('|--------|-------|');

  let volumeStr: string;
  if (report.broadTimeSpanMinutes > 1) {
    const rate = Math.round(report.broadHitCount / report.broadTimeSpanMinutes);
    volumeStr = `${report.broadHitCount} hits in ${report.broadTimeSpanMinutes} min (~${rate}/min)`;
  } else if (report.broadHitCount > 50) {
    volumeStr = `${report.broadHitCount} hits in <1 min (high burst)`;
  } else {
    volumeStr = `${report.broadHitCount} hits`;
  }
  w(`| **Log volume** | ${volumeStr} |`);
  w(`| **Unique patterns** | ${report.uniquePatterns} |`);

  const lvlParts = [...report.levelTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`);
  w(`| **Level distribution** | ${lvlParts.join(', ')} |`);
  const timeLabel = report.from.replace('now-', '');
  w(`| **Errors (last ${timeLabel})** | ${report.errorHitCount} total, ${report.errorGroups.length} unique |`);
  w(`| **Warnings (last ${timeLabel})** | ${report.warnHitCount} total, ${report.warningGroups.length} unique |`);
  w(`| **Active services** | ${report.serviceStats.size} |`);
  w(`| **Distinct traces** | ${report.traceCount} |`);
  w('');

  w('### Service Breakdown');
  w('');
  // Pre-compute per-service unique error/warning counts from the groups
  const svcErrorTypes = new Map<string, number>();
  for (const eg of report.errorGroups) svcErrorTypes.set(eg.service, (svcErrorTypes.get(eg.service) ?? 0) + 1);
  const svcWarnTypes = new Map<string, number>();
  for (const wg of report.warningGroups) svcWarnTypes.set(wg.service, (svcWarnTypes.get(wg.service) ?? 0) + 1);

  w('| Service | Logs (unique) | Errors (unique) | Warnings (unique) |');
  w('|---------|---------------|-----------------|-------------------|');
  for (const [svc, stats] of [...report.serviceStats.entries()].sort((a, b) => b[1].count - a[1].count)) {
    const errs = stats.levels.get('ERROR') ?? 0;
    const warns = stats.levels.get('WARN') ?? 0;
    const uErrs = svcErrorTypes.get(svc) ?? 0;
    const uWarns = svcWarnTypes.get(svc) ?? 0;
    const errCell = errs ? `${errs} (${uErrs})` : '-';
    const warnCell = warns ? `${warns} (${uWarns})` : '-';
    w(`| ${svc} | ${stats.count} (${stats.uniquePatterns}) | ${errCell} | ${warnCell} |`);
  }
  w('');

  if (report.errorGroups.length > 0) {
    w('### Errors');
    w('');
    w('| # | Service | Exception | Count | Affected Entities |');
    w('|---|---------|-----------|-------|-------------------|');
    report.errorGroups.forEach((eg, i) => {
      const entities = eg.entities.length > 0 ? eg.entities.slice(0, 5).join(', ') : '-';
      w(`| ${i + 1} | ${eg.service} | \`${eg.type}\` | ${eg.count} | ${entities} |`);
    });
    w('');
    for (let i = 0; i < report.errorGroups.length; i++) {
      const eg = report.errorGroups[i];
      w(`**Error ${i + 1}: \`${eg.type}\`** in ${eg.service}`);
      w(`> ${eg.message.split('\n')[0].trim()}`);
      if (eg.traceIds.length > 0) {
        w(`> Traces: ${eg.traceIds.slice(0, 3).map((t) => `\`${t.slice(0, 16)}…\``).join(', ')}`);
      }
      w('');
    }
  } else {
    w('### Errors');
    w('');
    w('No errors in the time window.');
    w('');
  }

  if (report.warningGroups.length > 0) {
    w('### Warnings');
    w('');
    w('| Category | Service | Count | Sample Message |');
    w('|----------|---------|-------|----------------|');
    for (const wg of report.warningGroups) {
      const sample = wg.message.split('\n')[0].trim().slice(0, 100);
      w(`| ${wg.category} | ${wg.service} | ${wg.count} | ${sample}${wg.message.length > 100 ? '…' : ''} |`);
    }
    w('');
  } else {
    w('### Warnings');
    w('');
    w('No warnings in the time window.');
    w('');
  }

  return lines.join('\n');
}

// ── Main ─────────────────────────────────────────────────────────────────────

const parsed = parseArgs(process.argv);
const esIndex = resolveIndex(parsed.index);
const auth = getEsAuth(parsed.env);
const timeFilter = { range: { '@timestamp': { gte: parsed.from, ...(parsed.to ? { lte: parsed.to } : {}) } } };

const broadQuery: Record<string, unknown> = {
  size: 200,
  query: { bool: { filter: [timeFilter] } },
};
const errWarnQuery: Record<string, unknown> = {
  size: 100,
  query: {
    bool: {
      must: [{ terms: { 'level.keyword': ['Error', 'ERROR', 'Warning', 'WARN'] } }],
      filter: [timeFilter],
    },
  },
};
applyDefaults(broadQuery);
applyDefaults(errWarnQuery);

const [broadResult, errWarnResult] = await Promise.all([
  esSearch(parsed.env, esIndex, broadQuery, auth),
  esSearch(parsed.env, esIndex, errWarnQuery, auth),
]);

const broadHits = broadResult.hits?.hits ?? [];
const errWarnHits = errWarnResult.hits?.hits ?? [];

const broadAnalysis = analyzeHits(broadHits);
const errWarnAnalysis = analyzeHits(errWarnHits);

// Merge error/warning service stats
for (const [svc, stats] of errWarnAnalysis.serviceStats) {
  if (!broadAnalysis.serviceStats.has(svc)) {
    broadAnalysis.serviceStats.set(svc, stats);
  } else {
    const existing = broadAnalysis.serviceStats.get(svc)!;
    for (const [lvl, count] of stats.levels) {
      if (lvl === 'ERROR' || lvl === 'WARN') existing.levels.set(lvl, count);
    }
  }
}
// Merge only ERROR/WARN counts from the focused query into the broad distribution.
// Other levels (INFO, DEBUG) keep the broad query's counts to avoid mixing result sets.
for (const [lvl, count] of errWarnAnalysis.levelTotals) {
  if (lvl === 'ERROR' || lvl === 'WARN') broadAnalysis.levelTotals.set(lvl, count);
}

let timeSpanMin = 0;
if (broadAnalysis.earliestTs && broadAnalysis.latestTs) {
  timeSpanMin = Math.round(
    (new Date(broadAnalysis.latestTs).getTime() - new Date(broadAnalysis.earliestTs).getTime()) / 60000,
  );
}

const report: TrafficReport = {
  env: parsed.env,
  index: parsed.index,
  from: parsed.from,
  to: parsed.to ?? 'now',
  broadHitCount: broadHits.length,
  broadTimeSpanMinutes: timeSpanMin,
  earliestTs: broadAnalysis.earliestTs,
  latestTs: broadAnalysis.latestTs,
  serviceStats: broadAnalysis.serviceStats,
  levelTotals: broadAnalysis.levelTotals,
  traceCount: broadAnalysis.traceIds.size,
  uniquePatterns: broadAnalysis.globalPatterns.size,
  errorHitCount: errWarnAnalysis.levelTotals.get('ERROR') ?? 0,
  warnHitCount: errWarnAnalysis.levelTotals.get('WARN') ?? 0,
  errorGroups: groupErrors(errWarnHits),
  warningGroups: groupWarnings(errWarnHits),
};

console.log(formatReport(report));