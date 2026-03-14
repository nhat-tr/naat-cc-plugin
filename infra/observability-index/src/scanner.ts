import path from 'node:path';
import fs from 'node:fs';
import fg from 'fast-glob';
import type { ExtractorConfig } from './types.js';

function parseGitmodules(projectRoot: string): string[] {
  const gitmodulesPath = path.join(projectRoot, '.gitmodules');
  if (!fs.existsSync(gitmodulesPath)) return [];

  const content = fs.readFileSync(gitmodulesPath, 'utf-8');
  const submodulePaths: string[] = [];

  // Parse [submodule "name"] blocks and extract `path = <dir>`
  const pathRegex = /^\s*path\s*=\s*(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = pathRegex.exec(content)) !== null) {
    const subPath = match[1]?.trim();
    if (subPath) submodulePaths.push(subPath);
  }

  return submodulePaths;
}

export async function scanFiles(
  projectRoot: string,
  config: ExtractorConfig,
  verbose: boolean = false
): Promise<string[]> {
  const absRoot = path.resolve(projectRoot);

  // Scan the main project
  const mainFiles = await fg(config.file_globs, {
    cwd: absRoot,
    ignore: config.exclude_globs,
    dot: false,
    absolute: false,
  });

  if (!config.include_submodules) return mainFiles;

  const submodulePaths = parseGitmodules(absRoot);
  if (verbose && submodulePaths.length > 0) {
    process.stderr.write(`Found ${submodulePaths.length} submodule(s): ${submodulePaths.join(', ')}\n`);
  }

  const subResults = await Promise.all(
    submodulePaths
      .filter((subPath) => fs.existsSync(path.join(absRoot, subPath)))
      .map((subPath) =>
        fg(config.file_globs, {
          cwd: path.join(absRoot, subPath),
          ignore: config.exclude_globs,
          dot: false,
          absolute: false,
        }).then((files) => files.map((f) => path.join(subPath, f)))
      )
  );

  return [...mainFiles, ...subResults.flat()];
}
