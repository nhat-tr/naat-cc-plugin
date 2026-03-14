import { describe, it, expect } from 'vitest';
import { analyzeStructured, detectTraceContextFromLines } from '../src/analyzer.js';

describe('analyzeStructured - structured templates', () => {
  it('detects structured template with single placeholder', () => {
    const result = analyzeStructured('Processing order {OrderId}', '_logger.LogInformation("Processing order {OrderId}"');
    expect(result.structured).toBe(true);
    expect(result.properties).toContain('OrderId');
  });

  it('detects structured template with multiple placeholders', () => {
    const result = analyzeStructured(
      'SAP Sync for order {CustomerOrderId} with SAP {SapOrderId}',
      '_logger.LogInformation("SAP Sync for order {CustomerOrderId} with SAP {SapOrderId}"'
    );
    expect(result.structured).toBe(true);
    expect(result.properties).toContain('CustomerOrderId');
    expect(result.properties).toContain('SapOrderId');
  });

  it('strips @ prefix from destructured property names', () => {
    const result = analyzeStructured(
      'Event {@EventData} received',
      '_logger.LogInformation("Event {@EventData} received"'
    );
    expect(result.structured).toBe(true);
    expect(result.properties).toContain('EventData');
  });
});

describe('analyzeStructured - unstructured templates', () => {
  it('detects C# string interpolation as unstructured', () => {
    const result = analyzeStructured(
      'Interpolated message',
      '_logger.LogInformation($"Interpolated {value} message"'
    );
    expect(result.structured).toBe(false);
    expect(result.properties).toHaveLength(0);
  });

  it('detects string concatenation as unstructured', () => {
    const result = analyzeStructured(
      'Unexpected error: ',
      'Log.Error("Unexpected error: " + exception'
    );
    expect(result.structured).toBe(false);
  });

  it('detects plain message without placeholders as unstructured', () => {
    const result = analyzeStructured(
      'Operation completed successfully',
      '_logger.LogInformation("Operation completed successfully"'
    );
    expect(result.structured).toBe(false);
    expect(result.properties).toHaveLength(0);
  });
});

describe('detectTraceContextFromLines', () => {
  it('detects RunInActivity in same method', () => {
    const codeLines = [
      'public async Task<string> RunTracedAsync(string input)',
      '{',
      '    return await source.RunInActivity("MySpan", async () =>',
      '    {',
      '        _logger.LogInformation("Running {Input}", input);',  // line 5
      '        return input;',
      '    });',
      '}',
    ];
    // Match is on line 5
    expect(detectTraceContextFromLines(codeLines, 5)).toBe(true);
  });

  it('detects Activity.Current in nearby scope', () => {
    const codeLines = [
      'public void DoWork()',
      '{',
      '    var span = Activity.Current;',
      '    _logger.LogInformation("Current activity {Id}", span?.Id);', // line 4
      '}',
    ];
    expect(detectTraceContextFromLines(codeLines, 4)).toBe(true);
  });

  it('returns false when no trace context nearby', () => {
    const codeLines = [
      'public void SimpleMethod()',
      '{',
      '    _logger.LogInformation("No trace here");', // line 3
      '}',
    ];
    expect(detectTraceContextFromLines(codeLines, 3)).toBe(false);
  });

  it('detects LogContext.PushProperty with TraceId', () => {
    const codeLines = [
      'public void WithContext()',
      '{',
      '    using var _ = LogContext.PushProperty("TraceId", traceId);',
      '    _logger.LogInformation("With context {Key}", key)', // line 4
      '}',
    ];
    expect(detectTraceContextFromLines(codeLines, 4)).toBe(true);
  });
});
