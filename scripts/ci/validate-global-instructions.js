#!/usr/bin/env node
/**
 * Validate generated instruction outputs include the expected routing rules.
 */

const fs = require('fs');
const path = require('path');
const { GENERATED_MARKER, ROOT_DIR, loadManifest } = require('../lib/runtime-assets');

const manifest = loadManifest();
const checks = [
  {
    label: 'Repo AGENTS',
    file: path.join(ROOT_DIR, manifest.generated_outputs.repo_agents.output),
    requirements: ['skills/csharp-dotnet/SKILL.md', 'skills/typescript/SKILL.md', 'react-next.md'],
  },
  {
    label: 'Claude global instructions',
    file: path.join(ROOT_DIR, manifest.generated_outputs.claude_global.output),
    requirements: ['__PLUGIN_DIR__/skills/csharp-dotnet/SKILL.md', '__PLUGIN_DIR__/skills/typescript/SKILL.md', 'react-next.md'],
  },
  {
    label: 'Codex global instructions',
    file: path.join(ROOT_DIR, manifest.generated_outputs.codex_global.output),
    requirements: ['__PLUGIN_DIR__/skills/csharp-dotnet/SKILL.md', '__PLUGIN_DIR__/skills/typescript/SKILL.md', 'react-next.md'],
  },
  {
    label: 'Copilot repo instructions',
    file: path.join(ROOT_DIR, manifest.generated_outputs.copilot_repo.output),
    requirements: ['.github/instructions/', '.github/skills/'],
  },
];

function includesAny(content, tokens) {
  return tokens.some(token => content.includes(token));
}

function validateGlobalInstructionFiles() {
  let hasErrors = false;
  let validated = 0;

  for (const check of checks) {
    if (!fs.existsSync(check.file)) {
      console.error(`ERROR: ${check.label} not found: ${check.file}`);
      hasErrors = true;
      continue;
    }

    const content = fs.readFileSync(check.file, 'utf-8');

    if (!content.includes(GENERATED_MARKER)) {
      console.error(`ERROR: ${check.label} is missing the generated marker`);
      hasErrors = true;
    }

    for (const requirement of check.requirements) {
      if (!content.includes(requirement)) {
        console.error(
          `ERROR: ${check.label} (${check.file}) missing required token: ${requirement}`,
        );
        hasErrors = true;
      }
    }

    validated += 1;
  }

  if (hasErrors) process.exit(1);

  console.log(`Validated generated instruction routing in ${validated} file(s)`);
}

validateGlobalInstructionFiles();
