// Config resolution order:
//
// 1. Check for <projectRoot>/.observability/extractor.yaml (per-project override).
//    If present and it has `extends: <language>`, merge: per-project patterns are
//    appended after the base config's patterns; scalar fields (file_globs,
//    exclude_globs, include_submodules) from the per-project config take precedence.
//
// 2. Fall back to <toolkitRoot>/infra/observability-index/configs/<language>.yaml
//    (toolkit default). The language is inferred from the project (currently only
//    "dotnet" is shipped).
//
// 3. `extends` support: a per-project config that sets `extends: dotnet` inherits all
//    patterns from configs/dotnet.yaml and may add extra patterns on top. A per-project
//    config without `extends` replaces the default entirely.

import path from 'node:path';
import fs from 'node:fs';
import { parse as parseYaml } from 'yaml';
import type { ExtractorConfig } from './types.js';

const TOOLKIT_ROOT = path.resolve(import.meta.dirname, '../../..');
const CONFIGS_DIR = path.join(TOOLKIT_ROOT, 'infra/observability-index/configs');

function readYamlConfig(filePath: string): Partial<ExtractorConfig> {
  const raw = fs.readFileSync(filePath, 'utf-8');
  return parseYaml(raw) as Partial<ExtractorConfig>;
}

function validatePatterns(config: ExtractorConfig, configPath: string): void {
  for (const pattern of config.patterns) {
    try {
      new RegExp(pattern.regex);
    } catch (err) {
      throw new Error(
        `Invalid regex in pattern "${pattern.name}" in ${configPath}: ${(err as Error).message}`
      );
    }
  }
}

export interface LoadConfigResult {
  config: ExtractorConfig;
  resolvedConfigPath: string;
}

export function loadConfig(projectRoot: string, configOverride?: string): LoadConfigResult {
  const projectConfigPath = configOverride
    ? path.resolve(configOverride)
    : path.join(projectRoot, '.observability', 'extractor.yaml');

  const hasProjectConfig = fs.existsSync(projectConfigPath);

  if (!hasProjectConfig) {
    // No per-project config — load toolkit default (dotnet)
    const defaultConfigPath = path.join(CONFIGS_DIR, 'dotnet.yaml');
    const base = readYamlConfig(defaultConfigPath) as ExtractorConfig;
    validatePatterns(base, defaultConfigPath);
    return { config: base, resolvedConfigPath: defaultConfigPath };
  }

  const projectConfig = readYamlConfig(projectConfigPath);

  if (!projectConfig.extends) {
    // Per-project config with no `extends` — use it entirely
    const merged = projectConfig as ExtractorConfig;
    validatePatterns(merged, projectConfigPath);
    return { config: merged, resolvedConfigPath: projectConfigPath };
  }

  // Per-project config with `extends: <language>` — merge with base
  const baseConfigPath = path.join(CONFIGS_DIR, `${projectConfig.extends}.yaml`);
  if (!fs.existsSync(baseConfigPath)) {
    throw new Error(
      `Base config "${projectConfig.extends}" not found at ${baseConfigPath} (referenced by ${projectConfigPath})`
    );
  }

  const base = readYamlConfig(baseConfigPath) as ExtractorConfig;

  const merged: ExtractorConfig = {
    file_globs: projectConfig.file_globs ?? base.file_globs,
    exclude_globs: projectConfig.exclude_globs ?? base.exclude_globs,
    include_submodules: projectConfig.include_submodules ?? base.include_submodules,
    patterns: [...base.patterns, ...(projectConfig.patterns ?? [])],
    extends: projectConfig.extends,
  };

  validatePatterns(merged, `${projectConfigPath} + ${baseConfigPath}`);
  return { config: merged, resolvedConfigPath: `${projectConfigPath} + ${baseConfigPath}` };
}
