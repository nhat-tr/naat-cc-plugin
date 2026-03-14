import { parseArgs } from 'node:util';
import path from 'node:path';
import { loadConfig } from './config.js';
import { scanFiles } from './scanner.js';
import { extractAll, type RawMatch } from './extractor.js';
import { parseContext, getLines, clearFileCache } from './context-parser.js';
import { analyzeStructured, detectTraceContextFromLines } from './analyzer.js';
import { writeOutput } from './output.js';
import type { LogEntry, TraceEntry } from './types.js';

export function buildEntries(
  rawMatches: RawMatch[],
  projectRoot: string,
): { logEntries: LogEntry[]; traceEntries: TraceEntry[] } {
  const logEntries: LogEntry[] = [];
  const traceEntries: TraceEntry[] = [];

  for (const match of rawMatches) {
    const absFilePath = path.join(projectRoot, match.file);
    const lines = getLines(absFilePath);
    const ctx = parseContext(absFilePath, match.line);
    const { pattern, groups, file, line } = match;

    if (pattern.category === 'log') {
      const template = groups['template'] ?? '';
      const level = groups['level'] ?? '';
      const rawMatchStr = match.rawMatch;

      const { structured, properties } = pattern.structured === 'detect'
        ? analyzeStructured(template, rawMatchStr)
        : { structured: pattern.structured === true, properties: [] };

      const hasTraceContext = detectTraceContextFromLines(lines, line);

      logEntries.push({
        file,
        line,
        namespace: ctx.namespace,
        class: ctx.class,
        method: ctx.method,
        level,
        template,
        structured,
        properties,
        hasTraceContext,
        pattern: pattern.name,
      });
    } else if (pattern.category === 'trace') {
      const spanName = groups['spanName'] ?? '';
      const eventType = groups['eventType'];

      const entry: TraceEntry = {
        file,
        line,
        namespace: ctx.namespace,
        class: ctx.class,
        method: ctx.method,
        spanName,
        pattern: pattern.name,
      };
      if (eventType) entry.eventType = eventType;
      traceEntries.push(entry);
    }
  }

  return { logEntries, traceEntries };
}

const { values: args } = parseArgs({
  options: {
    root: { type: 'string', default: process.cwd() },
    config: { type: 'string' },
    'output-dir': { type: 'string' },
    verbose: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
  strict: false,
});

if (args.help) {
  console.log(`
Usage: npx tsx src/index.ts [options]

Options:
  --root <path>        Project root to scan (default: cwd)
  --config <path>      Config file override (default: auto-detect)
  --output-dir <path>  Output directory (default: <root>/.observability)
  --verbose            Print progress to stderr
  --dry-run            Show what would be extracted, don't write files
  --help               Show this help
`);
  process.exit(0);
}

const projectRoot = path.resolve(args.root ?? process.cwd());
const verbose = args.verbose ?? false;
const dryRun = args['dry-run'] ?? false;
const outputDir = args['output-dir']
  ? path.resolve(args['output-dir'])
  : path.join(projectRoot, '.observability');

async function run(): Promise<void> {
  if (verbose) process.stderr.write(`Project root: ${projectRoot}\n`);

  // Step 1: Load config
  const { config, resolvedConfigPath } = loadConfig(projectRoot, args.config);
  if (verbose) {
    process.stderr.write(`Config: ${resolvedConfigPath}\n`);
    process.stderr.write(`Loaded ${config.patterns.length} patterns\n`);
  }

  // Step 2: Scan files
  if (verbose) process.stderr.write('Scanning files...\n');
  const files = await scanFiles(projectRoot, config, verbose);
  if (verbose) process.stderr.write(`Found ${files.length} files\n`);

  // Step 3: Extract raw matches
  if (verbose) process.stderr.write('Extracting matches...\n');
  const rawMatches = await extractAll(projectRoot, files, config, verbose);
  if (verbose) process.stderr.write(`Found ${rawMatches.length} raw matches\n`);

  // Step 4: Parse context + analyze
  const { logEntries, traceEntries } = buildEntries(rawMatches, projectRoot);

  clearFileCache();

  // Step 5: Write output
  writeOutput(projectRoot, outputDir, logEntries, traceEntries, resolvedConfigPath, dryRun, verbose);

  if (!dryRun) {
    console.log(`Done: ${logEntries.length} log entries, ${traceEntries.length} trace entries`);
  }
}

run().catch((err: unknown) => {
  console.error('Error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
