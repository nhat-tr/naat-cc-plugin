import fs from 'node:fs';
import path from 'node:path';
import type { ExtractorConfig, PatternConfig } from './types.js';

export interface RawMatch {
  file: string;
  line: number;
  rawMatch: string;
  groups: Record<string, string>;
  pattern: PatternConfig;
}

interface CompiledPattern {
  pattern: PatternConfig;
  re: RegExp;
}

function compilePatterns(patterns: PatternConfig[]): CompiledPattern[] {
  return patterns.map((p) => ({ pattern: p, re: new RegExp(p.regex) }));
}

function matchFile(
  filePath: string,
  absFilePath: string,
  compiled: CompiledPattern[]
): RawMatch[] {
  let content: string;
  try {
    content = fs.readFileSync(absFilePath, 'utf-8');
  } catch {
    return [];
  }

  const lines = content.split('\n');
  const results: RawMatch[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    for (const { pattern, re } of compiled) {
      const m = re.exec(line);
      if (!m) continue;

      const groups: Record<string, string> = {};
      if (m.groups) {
        for (const [k, v] of Object.entries(m.groups)) {
          if (v !== undefined) groups[k] = v;
        }
      }

      results.push({
        file: filePath,
        line: i + 1, // 1-based
        rawMatch: m[0],
        groups,
        pattern,
      });
    }
  }

  return results;
}

/** Extract matches from a single file. Compiles patterns on each call — use extractAll for bulk. */
export function extractFromFile(
  filePath: string,
  absFilePath: string,
  patterns: PatternConfig[]
): RawMatch[] {
  return matchFile(filePath, absFilePath, compilePatterns(patterns));
}

export async function extractAll(
  projectRoot: string,
  files: string[],
  config: ExtractorConfig,
  verbose: boolean = false
): Promise<RawMatch[]> {
  const absRoot = path.resolve(projectRoot);
  const results: RawMatch[] = [];

  // Compile patterns once for the entire run
  const compiled = compilePatterns(config.patterns);

  for (let i = 0; i < files.length; i++) {
    const file = files[i] ?? '';
    if (verbose && i % 200 === 0) {
      process.stderr.write(`  Extracting [${i}/${files.length}] ${file}\n`);
    }
    const absPath = path.join(absRoot, file);
    const matches = matchFile(file, absPath, compiled);
    results.push(...matches);
  }

  return results;
}
