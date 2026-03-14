// Matches Serilog-style {PropertyName} placeholders (not C# string interpolation)
const STRUCTURED_PLACEHOLDER = /\{[A-Za-z@$][A-Za-z0-9_@$.]*\}/g;

// C# string interpolation prefix
const INTERPOLATION_PREFIX = /^\$"/;

// Trace context markers — scanned within the method body
const TRACE_CONTEXT_PATTERNS = [
  /RunInActivity\s*\(/,
  /StartActivity\s*\(/,
  /LogContext\.PushProperty\s*\([^,)]*[Tt]race[Ii]d/,
  /Activity\.Current/,
  /RunInEventHandlingSpan\s*\(/,
  /RunInEventPublishingSpan\s*\(/,
  /RunGraphQLRequestInActivity\s*\(/,
];

export interface StructuredAnalysis {
  structured: boolean;
  properties: string[];
}

export function analyzeStructured(template: string, rawMatch: string): StructuredAnalysis {
  // If the raw match starts with $" it's C# string interpolation → unstructured
  // We check the rawMatch context rather than just the template
  if (INTERPOLATION_PREFIX.test(rawMatch) || rawMatch.includes('$"')) {
    return { structured: false, properties: [] };
  }

  // Check if template contains string concatenation (i.e., template ends before a `+`)
  // The extractor captures up to the closing `"`, so if the raw source has `"text " + var`,
  // the template itself won't have `+`. But we can detect the concat pattern in rawMatch.
  if (rawMatch.includes('" +') || rawMatch.includes('"+')) {
    return { structured: false, properties: [] };
  }

  // Look for {Placeholder} tokens
  const matches = [...template.matchAll(STRUCTURED_PLACEHOLDER)];
  if (matches.length === 0) {
    return { structured: false, properties: [] };
  }

  const properties = matches.map((m) =>
    m[0]!.slice(1, -1).replace(/^[@$]/, '') // strip braces and leading @ or $ destructuring
  );

  return { structured: true, properties };
}

export function detectTraceContextFromLines(
  lines: string[],
  matchLine: number
): boolean {
  // Simplified heuristic: scan ±50 lines around the match for trace markers.
  const targetIdx = matchLine - 1;
  const scanStart = Math.max(0, targetIdx - 50);
  const scanEnd = Math.min(lines.length - 1, targetIdx + 50);

  for (let i = scanStart; i <= scanEnd; i++) {
    const line = lines[i] ?? '';
    for (const pattern of TRACE_CONTEXT_PATTERNS) {
      if (pattern.test(line)) return true;
    }
  }

  return false;
}
