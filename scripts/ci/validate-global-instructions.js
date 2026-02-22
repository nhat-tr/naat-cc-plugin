#!/usr/bin/env node
/**
 * Validate global Codex/Claude instruction files include language routing rules.
 *
 * By default, missing files are skipped to keep CI portable.
 * Set REQUIRE_GLOBAL_INSTRUCTION_FILES=true to fail when files are missing.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const homeDir = os.homedir();
const codexHome = process.env.CODEX_HOME || path.join(homeDir, '.codex');
const claudeHome = process.env.CLAUDE_HOME || path.join(homeDir, '.claude');
const requireGlobalFiles = ['1', 'true', 'yes'].includes(
  String(process.env.REQUIRE_GLOBAL_INSTRUCTION_FILES || '').toLowerCase(),
);

const checks = [
  {
    label: 'Codex global instructions',
    file: process.env.CODEX_GLOBAL_AGENTS_PATH || path.join(codexHome, 'AGENTS.md'),
    requirements: [
      { name: 'C# skill routing', anyOf: ['csharp-dotnet/SKILL.md'] },
      { name: 'TypeScript skill routing', anyOf: ['typescript/SKILL.md'] },
      { name: 'React guidance routing', anyOf: ['react-next.md'] },
      { name: 'NUnit naming convention', anyOf: ['[Action]_When[Scenario]_Then[Expectation]'] },
    ],
  },
  {
    label: 'Claude global instructions',
    file: process.env.CLAUDE_GLOBAL_CLAUDE_PATH || path.join(claudeHome, 'CLAUDE.md'),
    requirements: [
      { name: 'C# skill routing', anyOf: ['csharp-dotnet/SKILL.md'] },
      { name: 'TypeScript skill routing', anyOf: ['typescript/SKILL.md'] },
      { name: 'React guidance routing', anyOf: ['react-next.md'] },
      { name: 'NUnit naming convention', anyOf: ['[Action]_When[Scenario]_Then[Expectation]'] },
    ],
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
      const message = `${check.label} not found: ${check.file}`;
      if (requireGlobalFiles) {
        console.error(`ERROR: ${message}`);
        hasErrors = true;
      } else {
        console.log(`Skipping: ${message}`);
      }
      continue;
    }

    const content = fs.readFileSync(check.file, 'utf-8');

    for (const requirement of check.requirements) {
      if (!includesAny(content, requirement.anyOf)) {
        console.error(
          `ERROR: ${check.label} (${check.file}) missing ${requirement.name}; expected one of: ${requirement.anyOf.join(', ')}`,
        );
        hasErrors = true;
      }
    }

    validated += 1;
  }

  if (hasErrors) process.exit(1);

  console.log(`Validated global instruction routing in ${validated} file(s)`);
}

validateGlobalInstructionFiles();
