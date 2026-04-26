#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const {
  GENERATED_MARKER,
  ROOT_DIR,
  getAssetEntries,
  loadManifest,
} = require('./lib/runtime-assets');

function readTemplate(name) {
  return fs.readFileSync(path.join(ROOT_DIR, 'templates/instructions', `${name}.md`), 'utf-8').trimEnd();
}

function splitRuntimeTemplate(name) {
  const template = readTemplate(name);
  const parts = template.split(/\n## Global Language Rules\n\n/);
  if (parts.length !== 2) {
    throw new Error(`Template ${name}.md must contain exactly one "## Global Language Rules" section`);
  }

  return {
    runtimeSection: parts[0],
    languageRoutingSection: parts[1],
  };
}

function renderInstruction(templateName, title) {
  const base = readTemplate('base');
  const { runtimeSection, languageRoutingSection } = splitRuntimeTemplate(templateName);

  return `${base
    .replace('{{GENERATED_MARKER}}', GENERATED_MARKER)
    .replace('{{TITLE}}', title)
    .replace('{{RUNTIME_SECTION}}', runtimeSection)
    .replace('{{LANGUAGE_ROUTING_SECTION}}', languageRoutingSection)}\n`;
}

function renderCopilotInstruction() {
  return `${GENERATED_MARKER}\n${readTemplate('copilot')}\n`;
}

function renderPathInstruction(templateName) {
  return `${GENERATED_MARKER}\n${readTemplate(templateName)}\n`;
}

function renderRuntimeSupportTable(manifest) {
  const assets = getAssetEntries(manifest);
  const byRuntime = {
    claude: new Set(),
    codex: new Set(),
    copilot: new Set(),
  };

  for (const asset of assets) {
    for (const runtime of asset.supported_runtimes || []) {
      byRuntime[runtime].add(asset.type);
    }
  }

  const describe = {
    claude: 'Commands, agents, skills, CLI wrappers',
    codex: 'Compatible skills, generated global AGENTS',
    copilot: 'Repo instructions, path instructions, compatible skills',
  };

  return [
    '## Runtime Support',
    '',
    '<!-- BEGIN GENERATED:runtime-support -->',
    '| Runtime | Supported Assets |',
    '|--------|-------------------|',
    `| ${manifest.runtimes.claude.display_name} | ${describe.claude} |`,
    `| ${manifest.runtimes.codex.display_name} | ${describe.codex} |`,
    `| ${manifest.runtimes.copilot.display_name} | ${describe.copilot} |`,
    '<!-- END GENERATED:runtime-support -->',
    '',
    'Runtime/asset mapping source of truth:',
    '- `metadata/runtime-asset-map.yaml`',
  ].join('\n');
}

function updateReadme(content, manifest) {
  const block = renderRuntimeSupportTable(manifest);
  return content.replace(
    /## Runtime Support[\s\S]*?Runtime\/asset mapping source of truth:\n- `metadata\/runtime-asset-map\.yaml`/,
    block,
  );
}

function copyDirectoryRecursive(sourceDir, targetDir, outputMap) {
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      copyDirectoryRecursive(sourcePath, targetPath, outputMap);
      continue;
    }

    outputMap.set(targetPath, fs.readFileSync(sourcePath, 'utf-8'));
  }
}

function buildOutputs() {
  const manifest = loadManifest();
  const outputs = new Map();

  outputs.set(
    path.join(ROOT_DIR, 'CLAUDE.md'),
    renderInstruction('claude', 'How I Work')
  );
  outputs.set(
    path.join(ROOT_DIR, 'AGENTS.md'),
    renderInstruction('repo-agents', 'How I Work')
  );
  outputs.set(
    path.join(ROOT_DIR, 'generated/instructions/codex-global.md'),
    renderInstruction('codex', 'How I Work')
  );
  outputs.set(
    path.join(ROOT_DIR, '.github/copilot-instructions.md'),
    renderCopilotInstruction()
  );
  outputs.set(
    path.join(ROOT_DIR, '.github/instructions/csharp.instructions.md'),
    renderPathInstruction('copilot-csharp')
  );
  outputs.set(
    path.join(ROOT_DIR, '.github/instructions/typescript.instructions.md'),
    renderPathInstruction('copilot-typescript')
  );

  const readmePath = path.join(ROOT_DIR, 'README.md');
  outputs.set(
    readmePath,
    updateReadme(fs.readFileSync(readmePath, 'utf-8'), manifest)
  );

  for (const asset of getAssetEntries(manifest)) {
    const copilotPublish = asset.publish?.copilot;
    if (copilotPublish?.kind !== 'repo_skill_copy') {
      continue;
    }

    const sourceDir = path.join(ROOT_DIR, path.dirname(asset.canonical_file));
    const targetDir = path.join(ROOT_DIR, copilotPublish.path);
    copyDirectoryRecursive(sourceDir, targetDir, outputs);
  }

  return outputs;
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeOutputs(outputs) {
  const copilotSkillsDir = path.join(ROOT_DIR, '.github/skills');
  if (fs.existsSync(copilotSkillsDir)) {
    fs.rmSync(copilotSkillsDir, { recursive: true, force: true });
  }

  for (const [filePath, content] of outputs) {
    ensureParentDir(filePath);
    fs.writeFileSync(filePath, content);
  }
}

function checkOutputs(outputs) {
  let hasDiff = false;

  for (const [filePath, content] of outputs) {
    if (!fs.existsSync(filePath)) {
      console.error(`ERROR: generated output missing: ${path.relative(ROOT_DIR, filePath)}`);
      hasDiff = true;
      continue;
    }

    const existing = fs.readFileSync(filePath, 'utf-8');
    if (existing !== content) {
      console.error(`ERROR: generated output drifted: ${path.relative(ROOT_DIR, filePath)}`);
      hasDiff = true;
    }
  }

  if (hasDiff) {
    process.exit(1);
  }

  console.log(`Validated ${outputs.size} generated runtime asset file(s)`);
}

function main() {
  const mode = process.argv[2];
  const outputs = buildOutputs();

  if (mode === '--write') {
    writeOutputs(outputs);
    console.log(`Wrote ${outputs.size} generated runtime asset file(s)`);
    return;
  }

  if (mode === '--check') {
    checkOutputs(outputs);
    return;
  }

  console.error('Usage: node scripts/generate-runtime-assets.js --write|--check');
  process.exit(1);
}

main();
