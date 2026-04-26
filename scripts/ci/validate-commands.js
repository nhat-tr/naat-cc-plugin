#!/usr/bin/env node
/**
 * Validate command markdown files are non-empty and stay aligned with the runtime asset manifest.
 */

const fs = require('fs');
const path = require('path');
const { getAssetEntries, loadManifest } = require('../lib/runtime-assets');

const ROOT_DIR = process.env.ROOT_DIR || path.join(__dirname, '../..');
const COMMANDS_DIR = path.join(ROOT_DIR, 'commands');
const AGENTS_DIR = path.join(ROOT_DIR, 'agents');
const SKILLS_DIR = path.join(ROOT_DIR, 'skills');

function validateCommands() {
  if (!fs.existsSync(COMMANDS_DIR)) {
    console.log('No commands directory found, skipping');
    process.exit(0);
  }

  const files = fs.readdirSync(COMMANDS_DIR).filter(f => f.endsWith('.md'));
  let hasErrors = false;

  const validCommands = new Set(files.map(f => f.replace(/\.md$/, '')));
  const manifest = loadManifest();
  const commandAssets = getAssetEntries(manifest).filter(asset => asset.type === 'command');
  const manifestCommands = new Set(
    commandAssets.map(asset => path.basename(asset.canonical_file, '.md'))
  );

  const validAgents = new Set();
  if (fs.existsSync(AGENTS_DIR)) {
    for (const f of fs.readdirSync(AGENTS_DIR).filter(f => f.endsWith('.md'))) {
      validAgents.add(f.replace(/\.md$/, ''));
    }
  }

  const validSkills = new Set();
  if (fs.existsSync(SKILLS_DIR)) {
    for (const f of fs.readdirSync(SKILLS_DIR)) {
      try {
        if (fs.statSync(path.join(SKILLS_DIR, f)).isDirectory()) validSkills.add(f);
      } catch {}
    }
  }

  for (const file of files) {
    const content = fs.readFileSync(path.join(COMMANDS_DIR, file), 'utf-8');

    if (content.trim().length === 0) {
      console.error(`ERROR: ${file} - Empty command file`);
      hasErrors = true;
      continue;
    }

    // Strip code blocks before checking references
    const stripped = content.replace(/```[\s\S]*?```/g, '');

    // Check cross-references to other commands
    for (const line of stripped.split('\n')) {
      if (/creates:|would create:/i.test(line)) continue;
      for (const match of line.matchAll(/`\/([a-z][-a-z0-9]*)`/g)) {
        if (!validCommands.has(match[1])) {
          console.error(`ERROR: ${file} - references non-existent command /${match[1]}`);
          hasErrors = true;
        }
      }
    }

    // Check agent path references
    for (const match of stripped.matchAll(/agents\/([a-z][-a-z0-9]*)\.md/g)) {
      if (!validAgents.has(match[1])) {
        console.error(`ERROR: ${file} - references non-existent agent agents/${match[1]}.md`);
        hasErrors = true;
      }
    }

    // Check skill directory references
    for (const match of stripped.matchAll(/skills\/([a-z][-a-z0-9]*)\//g)) {
      if (!validSkills.has(match[1])) {
        console.warn(`WARN: ${file} - references skill directory skills/${match[1]}/ (not found)`);
      }
    }
  }

  for (const commandName of validCommands) {
    if (!manifestCommands.has(commandName)) {
      console.error(`ERROR: commands/${commandName}.md missing from runtime asset manifest`);
      hasErrors = true;
    }
  }

  for (const commandName of manifestCommands) {
    if (!validCommands.has(commandName)) {
      console.error(`ERROR: manifest references missing command commands/${commandName}.md`);
      hasErrors = true;
    }
  }

  if (hasErrors) process.exit(1);
  console.log(`Validated ${files.length} command files and ${commandAssets.length} manifest command entries`);
}

validateCommands();
