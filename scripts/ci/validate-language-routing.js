#!/usr/bin/env node
/**
 * Validate language routing references remain wired for Claude and Codex.
 *
 * Agents must reference a routing source (~/.claude/CLAUDE.md or .pair/context.md)
 * that contains absolute paths to skill files. They don't need to name skill files
 * directly — the routing source is the indirection layer.
 *
 * Infrastructure files (install scripts, runtime-asset-map) must still reference
 * skill file paths directly since they ARE the routing source.
 */

const fs = require('fs');
const path = require('path');

const ROOT_DIR = process.env.ROOT_DIR || path.join(__dirname, '../..');

const checks = [
  // Agents: must reference a routing source (CLAUDE.md or .pair/context.md)
  // and mention "Language Rule Routing" or "Global Language Rules"
  {
    file: 'agents/pair-implementer.md',
    mustInclude: ['.pair/context.md', 'Language Rule Routing'],
  },
  {
    file: 'agents/pair-reviewer.md',
    mustInclude: ['.pair/context.md', 'Language Rule Routing'],
  },
  {
    file: 'agents/code-reviewer.md',
    mustInclude: ['~/.claude/CLAUDE.md', 'Language Rule Routing'],
  },
  {
    file: 'agents/pair-programmer.md',
    mustInclude: ['~/.claude/CLAUDE.md', 'Language Rule Routing'],
  },

  // SKILL.md: must be the single source of truth with key rules
  {
    file: 'skills/csharp-dotnet/SKILL.md',
    mustInclude: [
      'Non-Negotiable Rules',
      'CancellationToken',
      'AsNoTracking',
      'async void',
      'IHttpClientFactory',
      'IDisposable',
      '[Action]_When[Scenario]_Then[Expectation]',
      'No FluentAssertions',
      'MIT / Apache-2.0',
      'captive dependencies',
    ],
  },

  // Infrastructure: must still reference skill paths (they ARE the routing)
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
      'GLOBAL_AGENTS_FILES=("$CODEX_DIR/AGENTS.md" "$AGENTS_DIR/AGENTS.md")',
      'install_agents_md()',
      'local source="$PLUGIN_DIR/AGENTS.md"',
      'AGENTS_MANAGED_MARKER="nhat-dev-toolkit managed global instructions template"',
      'Installed AGENTS.md:',
    ],
  },
  {
    file: 'AGENTS.md',
    mustInclude: [
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
