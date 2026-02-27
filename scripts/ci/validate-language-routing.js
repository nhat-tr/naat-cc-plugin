#!/usr/bin/env node
/**
 * Validate C#/.NET + TypeScript React routing references remain wired for Claude and Codex.
 */

const fs = require('fs');
const path = require('path');

const ROOT_DIR = process.env.ROOT_DIR || path.join(__dirname, '../..');

const checks = [
  {
    file: 'agents/pair-implementer.md',
    mustInclude: [
      'csharp-dotnet/SKILL.md',
      'typescript/SKILL.md',
      '[Action]_When[Scenario]_Then[Expectation]',
      '~/.claude/CLAUDE.md',
    ],
  },
  {
    file: 'agents/pair-reviewer.md',
    mustInclude: [
      'csharp-dotnet/SKILL.md',
      'typescript/SKILL.md',
      '~/.claude/CLAUDE.md',
    ],
  },
  {
    file: 'agents/sonar-analyst.md',
    mustInclude: [
      'csharp-dotnet/SKILL.md',
      'typescript/SKILL.md',
      '~/.claude/CLAUDE.md',
    ],
  },
  {
    file: 'agents/code-reviewer.md',
    mustInclude: [
      'csharp-dotnet/SKILL.md',
      'typescript/SKILL.md',
      '[Action]_When[Scenario]_Then[Expectation]',
      'typescript/references/react-next.md',
      '~/.claude/CLAUDE.md',
    ],
  },
  {
    file: 'agents/pair-programmer.md',
    mustInclude: [
      'csharp-dotnet/SKILL.md',
      'typescript/SKILL.md',
      '[Action]_When[Scenario]_Then[Expectation]',
      'typescript/references/react-next.md',
      '~/.claude/CLAUDE.md',
    ],
  },
  {
    file: 'metadata/runtime-asset-map.yaml',
    mustInclude: [
      'language_rule_routing:',
      'csharp_dotnet:',
      'typescript_react:',
      'required_test_method_naming: "[Action]_When[Scenario]_Then[Expectation]"',
    ],
  },
  {
    file: 'install-codex.sh',
    mustInclude: [
      'GLOBAL_AGENTS_FILE="$CODEX_DIR/AGENTS.md"',
      'ROUTING_BLOCK_START="<!-- BEGIN nhat-dev-toolkit:language-routing -->"',
      'csharp-dotnet/SKILL.md',
      'typescript/SKILL.md',
      'react-next.md',
      '[Action]_When[Scenario]_Then[Expectation]',
    ],
  },
  {
    file: 'install.sh',
    mustInclude: [
      'GLOBAL_CLAUDE_FILE="$CLAUDE_DIR/CLAUDE.md"',
      'ROUTING_BLOCK_START="<!-- BEGIN nhat-dev-toolkit:language-routing -->"',
      'csharp-dotnet/SKILL.md',
      'typescript/SKILL.md',
      'react-next.md',
      '[Action]_When[Scenario]_Then[Expectation]',
    ],
  },
];

function validateLanguageRouting() {
  let hasErrors = false;

  for (const check of checks) {
    const fullPath = path.join(ROOT_DIR, check.file);

    if (!fs.existsSync(fullPath)) {
      console.error(`ERROR: Missing file: ${check.file}`);
      hasErrors = true;
      continue;
    }

    const content = fs.readFileSync(fullPath, 'utf-8');
    for (const token of check.mustInclude) {
      if (!content.includes(token)) {
        console.error(`ERROR: ${check.file} missing required token: ${token}`);
        hasErrors = true;
      }
    }
  }

  if (hasErrors) process.exit(1);
  console.log(`Validated language routing across ${checks.length} files`);
}

validateLanguageRouting();
