import { describe, it, expect } from 'vitest';
import { parseContextFromLines } from '../src/context-parser.js';

// Helper to split code string into lines
function lines(code: string): string[] {
  return code.split('\n');
}

describe('context-parser - block-scoped namespace', () => {
  it('extracts namespace from block-scoped declaration', () => {
    const code = `namespace Acme.Orders
{
    public class OrderService
    {
        public void Process()
        {
            _logger.LogInformation("test");
        }
    }
}`;
    const ctx = parseContextFromLines(lines(code), 7);
    expect(ctx.namespace).toBe('Acme.Orders');
    expect(ctx.class).toBe('OrderService');
    expect(ctx.method).toBe('Process');
  });
});

describe('context-parser - file-scoped namespace', () => {
  it('extracts namespace from file-scoped declaration', () => {
    const code = `namespace Acme.Services;

public class MyService
{
    public void Execute(string id)
    {
        _logger.LogInformation("Executing {Id}", id);
    }
}`;
    const ctx = parseContextFromLines(lines(code), 7);
    expect(ctx.namespace).toBe('Acme.Services');
    expect(ctx.class).toBe('MyService');
    expect(ctx.method).toBe('Execute');
  });
});

describe('context-parser - async method', () => {
  it('extracts async method name', () => {
    const code = `namespace Acme.Async
{
    public class AsyncService
    {
        public async Task ProcessAsync(int id, CancellationToken ct)
        {
            _logger.LogInformation("Processing {Id}", id);
        }
    }
}`;
    const ctx = parseContextFromLines(lines(code), 7);
    expect(ctx.class).toBe('AsyncService');
    expect(ctx.method).toBe('ProcessAsync');
  });
});

describe('context-parser - private method', () => {
  it('extracts private method name', () => {
    const code = `namespace Acme.Private
{
    public class PrivateService
    {
        private void HandleError(Exception ex)
        {
            _logger.LogError("Error {Message}", ex.Message);
        }
    }
}`;
    const ctx = parseContextFromLines(lines(code), 7);
    expect(ctx.method).toBe('HandleError');
  });
});

describe('context-parser - method with generic return type', () => {
  it('extracts method from generic return type signature', () => {
    const code = `namespace Acme.Generic
{
    public class GenericService
    {
        public async Task<IEnumerable<string>> GetAllAsync(string filter)
        {
            _logger.LogInformation("Getting all with {Filter}", filter);
            return [];
        }
    }
}`;
    const ctx = parseContextFromLines(lines(code), 7);
    expect(ctx.class).toBe('GenericService');
    expect(ctx.method).toBe('GetAllAsync');
  });
});

describe('context-parser - no match returns empty strings', () => {
  it('returns empty context when no namespace or class found', () => {
    const code = `// just a comment
// nothing here
_logger.LogInformation("bare call");`;
    const ctx = parseContextFromLines(lines(code), 3);
    expect(ctx.namespace).toBe('');
    expect(ctx.class).toBe('');
  });
});
