import fs from 'node:fs';
import path from 'node:path';

export interface CSharpContext {
  namespace: string;
  class: string;
  method: string;
}

// Matches file-scoped namespace: `namespace Foo.Bar;`
const FILE_SCOPED_NS = /^\s*namespace\s+([\w.]+)\s*;/;
// Matches block-scoped namespace: `namespace Foo.Bar {` or `namespace Foo.Bar`
const BLOCK_NS = /^\s*namespace\s+([\w.]+)\s*(?:\{|$)/;
// Matches class/record/struct declaration
const CLASS_DECL = /(?:^|\s)(?:public|private|protected|internal|sealed|abstract|static|partial)?\s*(?:class|record|struct)\s+(\w+)/;
// Matches method signature: accessibility modifier + return type + method name + `(`
// Handles: public async Task<T> MethodName(, private void Foo(, etc.
const METHOD_DECL = /(?:public|private|protected|internal|override|virtual|abstract|async|static|sealed)\s+(?:[\w<>\[\]?,.\s]+\s+)?(\w+)\s*(?:<[^>]*>)?\s*\(/;

const NON_METHOD_KEYWORDS = ['if', 'while', 'for', 'foreach', 'switch', 'catch', 'using', 'lock', 'return', 'await', 'new', 'typeof', 'nameof'];

// A file content cache to avoid re-reading the same file per match
const fileCache = new Map<string, string[]>();

export function getLines(absFilePath: string): string[] {
  const cached = fileCache.get(absFilePath);
  if (cached) return cached;

  let content: string;
  try {
    content = fs.readFileSync(absFilePath, 'utf-8');
  } catch {
    return [];
  }
  const lines = content.split('\n');
  fileCache.set(absFilePath, lines);
  return lines;
}

export function clearFileCache(): void {
  fileCache.clear();
}

export function parseContextFromLines(lines: string[], matchLine: number): CSharpContext {
  let namespace = '';
  let className = '';
  let method = '';

  const scanLimit = Math.min(lines.length, 200);
  for (let i = 0; i < scanLimit; i++) {
    const line = lines[i] ?? '';
    const fileScopedMatch = FILE_SCOPED_NS.exec(line);
    if (fileScopedMatch) {
      namespace = fileScopedMatch[1] ?? '';
      break;
    }
    const blockMatch = BLOCK_NS.exec(line);
    if (blockMatch) {
      namespace = blockMatch[1] ?? '';
      break;
    }
  }

  const targetLine = matchLine - 1;

  for (let i = targetLine; i >= 0; i--) {
    const line = lines[i] ?? '';
    const classMatch = CLASS_DECL.exec(line);
    if (classMatch && classMatch[1]) {
      className = classMatch[1];
      break;
    }
  }

  for (let i = targetLine; i >= 0; i--) {
    const line = lines[i] ?? '';
    if (CLASS_DECL.test(line) && i < targetLine) break;
    const methodMatch = METHOD_DECL.exec(line);
    if (methodMatch && methodMatch[1]) {
      const candidate = methodMatch[1];
      if (!NON_METHOD_KEYWORDS.includes(candidate)) {
        method = candidate;
        break;
      }
    }
  }

  return { namespace, class: className, method };
}

export function parseContext(absFilePath: string, matchLine: number): CSharpContext {
  return parseContextFromLines(getLines(absFilePath), matchLine);
}
