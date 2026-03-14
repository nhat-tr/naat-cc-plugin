import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import type { LogEntry, TraceEntry, IndexFile, IndexMetadata } from './types.js';

function getGitCommit(projectRoot: string): string {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: projectRoot, stdio: ['pipe', 'pipe', 'pipe'] })
      .toString()
      .trim();
  } catch {
    return 'unknown';
  }
}

export function buildMetadata(
  projectRoot: string,
  configPath: string
): IndexMetadata {
  return {
    generated: new Date().toISOString(),
    commit: getGitCommit(projectRoot),
    config: configPath,
    tier: 1,
  };
}

export function writeOutput(
  projectRoot: string,
  outputDir: string,
  logEntries: LogEntry[],
  traceEntries: TraceEntry[],
  configPath: string,
  dryRun: boolean,
  verbose: boolean
): void {
  const metadata = buildMetadata(projectRoot, configPath);

  const logsFile: IndexFile<LogEntry> = { metadata, entries: logEntries };
  const tracesFile: IndexFile<TraceEntry> = { metadata, entries: traceEntries };

  if (verbose) {
    process.stderr.write(`Logs:   ${logEntries.length} entries\n`);
    process.stderr.write(`Traces: ${traceEntries.length} entries\n`);
  }

  if (dryRun) {
    process.stderr.write('[dry-run] Would write:\n');
    process.stderr.write(`  ${path.join(outputDir, 'logs.json')}\n`);
    process.stderr.write(`  ${path.join(outputDir, 'traces.json')}\n`);
    return;
  }

  fs.mkdirSync(outputDir, { recursive: true });

  const logsPath = path.join(outputDir, 'logs.json');
  const tracesPath = path.join(outputDir, 'traces.json');

  fs.writeFileSync(logsPath, JSON.stringify(logsFile, null, 2), 'utf-8');
  fs.writeFileSync(tracesPath, JSON.stringify(tracesFile, null, 2), 'utf-8');

  if (verbose) {
    process.stderr.write(`Wrote ${logsPath}\n`);
    process.stderr.write(`Wrote ${tracesPath}\n`);
  }
}
