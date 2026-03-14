import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFromFile } from '../src/extractor.js';
import type { PatternConfig } from '../src/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures');

const ILOGGER_PATTERN: PatternConfig = {
  name: 'ILogger structured',
  category: 'log',
  regex: '(?<receiver>_?[a-zA-Z][a-zA-Z0-9]*)\\.(?<method>Log(?<level>Information|Warning|Error|Debug|Critical|Trace))\\(\\s*\\$?"(?<template>[^"]+)"',
  structured: 'detect',
};

const SERILOG_PATTERN: PatternConfig = {
  name: 'Serilog static',
  category: 'log',
  regex: '(?:Serilog\\.)?Log\\.(?<level>Information|Warning|Error|Fatal|Debug|Verbose)\\(\\s*"(?<template>[^"]+)"',
  structured: 'detect',
};

const RUN_IN_ACTIVITY_PATTERN: PatternConfig = {
  name: 'RunInActivity',
  category: 'trace',
  regex: '\\.RunInActivity\\(\\s*"(?<spanName>[^"]+)"',
};

const RUN_IN_EVENT_HANDLING_SPAN_PATTERN: PatternConfig = {
  name: 'RunInEventHandlingSpan',
  category: 'trace',
  regex: '\\.RunInEventHandlingSpan\\([^,]+,\\s*(?:typeof\\((?<eventType>[^)]+)\\)\\.Name|"(?<spanName>[^"]+)")',
};

const START_ACTIVITY_PATTERN: PatternConfig = {
  name: 'StartActivity',
  category: 'trace',
  regex: '\\.StartActivity\\(\\s*"(?<spanName>[^"]+)"',
};

const RUN_IN_EVENT_PUBLISHING_SPAN_PATTERN: PatternConfig = {
  name: 'RunInEventPublishingSpan',
  category: 'trace',
  regex: '\\.RunInEventPublishingSpan\\(\\s*"(?<spanName>[^"]+)"',
};

const RUN_GRAPHQL_PATTERN: PatternConfig = {
  name: 'RunGraphQLRequestInActivity',
  category: 'trace',
  regex: '\\.RunGraphQLRequestInActivity\\(\\s*"(?<spanName>[^"]+)"',
};

describe('extractor - ILogger patterns', () => {
  it('extracts ILogger.LogInformation with structured template', () => {
    const file = path.join(FIXTURES, 'SampleService.cs');
    const matches = extractFromFile('SampleService.cs', file, [ILOGGER_PATTERN]);

    const infoMatch = matches.find((m) => m.groups['level'] === 'Information' && m.groups['template']?.includes('Processing'));
    expect(infoMatch).toBeDefined();
    expect(infoMatch!.groups['template']).toBe('Processing order {OrderId}');
    expect(infoMatch!.line).toBeGreaterThan(0);
  });

  it('extracts multiple log levels', () => {
    const file = path.join(FIXTURES, 'SampleService.cs');
    const matches = extractFromFile('SampleService.cs', file, [ILOGGER_PATTERN]);

    const levels = matches.map((m) => m.groups['level']).filter(Boolean);
    expect(levels).toContain('Information');
    expect(levels).toContain('Debug');
    expect(levels).toContain('Warning');
    expect(levels).toContain('Error');
  });

  it('captures interpolated log (unstructured)', () => {
    const file = path.join(FIXTURES, 'SampleService.cs');
    const matches = extractFromFile('SampleService.cs', file, [ILOGGER_PATTERN]);

    const interpolated = matches.find((m) => m.groups['template']?.includes('Interpolated'));
    expect(interpolated).toBeDefined();
    // rawMatch should include $"
    expect(interpolated!.rawMatch).toContain('$"');
  });
});

describe('extractor - Serilog patterns', () => {
  it('extracts Serilog.Log.Error structured', () => {
    const file = path.join(FIXTURES, 'SerilogService.cs');
    const matches = extractFromFile('SerilogService.cs', file, [SERILOG_PATTERN]);

    const errMatch = matches.find((m) => m.groups['level'] === 'Error' && m.groups['template']?.includes('{Key}'));
    expect(errMatch).toBeDefined();
    expect(errMatch!.groups['template']).toBe('Critical failure for {Key}: {Value}');
  });

  it('extracts Log.Information without Serilog prefix', () => {
    const file = path.join(FIXTURES, 'SerilogService.cs');
    const matches = extractFromFile('SerilogService.cs', file, [SERILOG_PATTERN]);

    const infoMatch = matches.find((m) => m.groups['level'] === 'Information');
    expect(infoMatch).toBeDefined();
    expect(infoMatch!.groups['template']).toBe('Starting work for {Key}');
  });
});

describe('extractor - trace patterns', () => {
  it('extracts RunInActivity span name', () => {
    const file = path.join(FIXTURES, 'TraceService.cs');
    const matches = extractFromFile('TraceService.cs', file, [RUN_IN_ACTIVITY_PATTERN]);

    expect(matches).toHaveLength(1);
    expect(matches[0]!.groups['spanName']).toBe('TraceService.RunTracedAsync');
  });

  it('extracts RunInEventHandlingSpan with typeof(TEvent).Name', () => {
    const file = path.join(FIXTURES, 'TraceService.cs');
    const matches = extractFromFile('TraceService.cs', file, [RUN_IN_EVENT_HANDLING_SPAN_PATTERN]);

    expect(matches).toHaveLength(1);
    expect(matches[0]!.groups['eventType']).toBe('SomeEvent');
    expect(matches[0]!.groups['spanName']).toBeUndefined();
  });

  it('extracts StartActivity span name', () => {
    const file = path.join(FIXTURES, 'TraceService.cs');
    const matches = extractFromFile('TraceService.cs', file, [START_ACTIVITY_PATTERN]);

    expect(matches).toHaveLength(1);
    expect(matches[0]!.groups['spanName']).toBe('TraceService.ManualSpan');
  });

  it('extracts RunInEventPublishingSpan', () => {
    const file = path.join(FIXTURES, 'TraceService.cs');
    const matches = extractFromFile('TraceService.cs', file, [RUN_IN_EVENT_PUBLISHING_SPAN_PATTERN]);

    expect(matches).toHaveLength(1);
    expect(matches[0]!.groups['spanName']).toBe('my.exchange');
  });

  it('extracts RunGraphQLRequestInActivity span name from literal string on same line', () => {
    const file = path.join(FIXTURES, 'TraceService.cs');
    const matches = extractFromFile('TraceService.cs', file, [RUN_GRAPHQL_PATTERN]);

    // Only the literal string call matches; the variable-arg call does not
    expect(matches).toHaveLength(1);
    expect(matches[0]!.groups['spanName']).toBe('TraceService.GetProduct');
  });
});
