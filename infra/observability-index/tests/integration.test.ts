import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import { loadConfig } from '../src/config.js';
import { scanFiles } from '../src/scanner.js';
import { extractAll } from '../src/extractor.js';
import { clearFileCache } from '../src/context-parser.js';
import { buildEntries } from '../src/index.js';
import type { LogEntry, TraceEntry } from '../src/types.js';

const CALIBRATION_CORE = process.env.OBSERVABILITY_INDEX_INTEGRATION_ROOT ?? '';

// Skip if Calibration Core doesn't exist (CI without the repo)
const shouldRun = fs.existsSync(CALIBRATION_CORE);

describe.skipIf(!shouldRun)('integration: Calibration Core extraction', () => {
  let logEntries: LogEntry[] = [];
  let traceEntries: TraceEntry[] = [];

  beforeAll(async () => {
    const { config } = loadConfig(CALIBRATION_CORE);
    const files = await scanFiles(CALIBRATION_CORE, config, false);
    const rawMatches = await extractAll(CALIBRATION_CORE, files, config, false);

    ({ logEntries, traceEntries } = buildEntries(rawMatches, CALIBRATION_CORE));

    clearFileCache();
  }, 30_000); // 30s timeout for ~2400 files

  it('produces log entries', () => {
    expect(logEntries.length).toBeGreaterThan(50);
  });

  it('produces trace entries', () => {
    expect(traceEntries.length).toBeGreaterThan(10);
  });

  it('logs.json contains entries from DigitalTwinService', () => {
    const digitalTwinEntries = logEntries.filter(
      (e) => e.class === 'DigitalTwinService' || e.file.includes('DigitalTwin')
    );
    expect(digitalTwinEntries.length).toBeGreaterThan(0);
  });

  it('traces.json contains RunInActivity spans with literal span names', () => {
    const runInActivityTraces = traceEntries.filter(
      (e) => e.pattern === 'RunInActivity' && e.spanName !== ''
    );
    expect(runInActivityTraces.length).toBeGreaterThan(0);
  });

  it('submodule entries are included (Hoffmann.Calibration.Common)', () => {
    const submoduleEntries = [...logEntries, ...traceEntries].filter(
      (e) => e.file.startsWith('Hoffmann.Calibration.Common/')
    );
    expect(submoduleEntries.length).toBeGreaterThan(0);
  });

  it('no entries from bin/ or obj/ directories', () => {
    const excluded = [...logEntries, ...traceEntries].filter(
      (e) => e.file.includes('/bin/') || e.file.includes('/obj/')
    );
    expect(excluded).toHaveLength(0);
  });

  it('no entries from *.Tests/ projects', () => {
    const testEntries = [...logEntries, ...traceEntries].filter(
      (e) => /\.Tests[\\/]/.test(e.file)
    );
    expect(testEntries).toHaveLength(0);
  });

  it('no entries from *.DummyData/ projects', () => {
    const dummyEntries = [...logEntries, ...traceEntries].filter(
      (e) => /\.DummyData[\\/]/.test(e.file)
    );
    expect(dummyEntries).toHaveLength(0);
  });

  it('ErrorHandlingMiddleware unstructured log is flagged as unstructured', () => {
    const unstructuredEntries = logEntries.filter(
      (e) => e.file.includes('ErrorHandlingMiddleware') && e.template.includes('Unexpected error')
    );
    expect(unstructuredEntries.length).toBeGreaterThan(0);
    expect(unstructuredEntries.every((e) => e.structured === false)).toBe(true);
  });

  it('traces.json contains RunInEventPublishingSpan entries', () => {
    const entries = traceEntries.filter((e) => e.pattern === 'RunInEventPublishingSpan');
    expect(entries.length).toBeGreaterThan(0);
  });

  it('traces.json contains RunGraphQLRequestInActivity entries', () => {
    const entries = traceEntries.filter((e) => e.pattern === 'RunGraphQLRequestInActivity');
    expect(entries.length).toBeGreaterThan(0);
  });

  it('log entries have namespace and class populated', () => {
    const withContext = logEntries.filter((e) => e.namespace !== '' && e.class !== '');
    expect(withContext.length / logEntries.length).toBeGreaterThan(0.8);
  });

  it('structured log entries have non-empty properties array', () => {
    const structured = logEntries.filter((e) => e.structured === true);
    expect(structured.length).toBeGreaterThan(0);
    const withProps = structured.filter((e) => e.properties.length > 0);
    expect(withProps.length).toBeGreaterThan(0);
  });
});
