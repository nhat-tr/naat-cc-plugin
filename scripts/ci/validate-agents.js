#!/usr/bin/env node
/**
 * Validate agent markdown files have required frontmatter.
 */

const fs = require('fs');
const path = require('path');
const { getAssetEntries, loadManifest } = require('../lib/runtime-assets');

const AGENTS_DIR = process.env.AGENTS_DIR || path.join(__dirname, '../../agents');
const REQUIRED_FIELDS = ['model', 'tools'];
const VALID_MODELS = ['haiku', 'sonnet', 'opus'];

function extractFrontmatter(content) {
  const clean = content.replace(/^\uFEFF/, '');
  const match = clean.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;

  const frontmatter = {};
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx > 0) {
      frontmatter[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  return frontmatter;
}

function validateAgents() {
  if (!fs.existsSync(AGENTS_DIR)) {
    console.log('No agents directory found, skipping');
    process.exit(0);
  }

  const files = fs.readdirSync(AGENTS_DIR).filter(f => f.endsWith('.md'));
  let hasErrors = false;

  for (const file of files) {
    const content = fs.readFileSync(path.join(AGENTS_DIR, file), 'utf-8');
    const fm = extractFrontmatter(content);

    if (!fm) {
      console.error(`ERROR: ${file} - Missing frontmatter`);
      hasErrors = true;
      continue;
    }

    for (const field of REQUIRED_FIELDS) {
      if (!fm[field] || !fm[field].trim()) {
        console.error(`ERROR: ${file} - Missing required field: ${field}`);
        hasErrors = true;
      }
    }

    if (fm.model && !VALID_MODELS.includes(fm.model)) {
      console.error(`ERROR: ${file} - Invalid model '${fm.model}'. Must be one of: ${VALID_MODELS.join(', ')}`);
      hasErrors = true;
    }
  }

  const validAgents = new Set(files.map(f => f.replace(/\.md$/, '')));
  const manifest = loadManifest();
  const agentAssets = getAssetEntries(manifest).filter(asset => asset.type === 'agent');
  const manifestAgents = new Set(agentAssets.map(asset => path.basename(asset.canonical_file, '.md')));

  for (const agentName of validAgents) {
    if (!manifestAgents.has(agentName)) {
      console.error(`ERROR: agents/${agentName}.md missing from runtime asset manifest`);
      hasErrors = true;
    }
  }

  for (const agentName of manifestAgents) {
    if (!validAgents.has(agentName)) {
      console.error(`ERROR: manifest references missing agent agents/${agentName}.md`);
      hasErrors = true;
    }
  }

  if (hasErrors) process.exit(1);
  console.log(`Validated ${files.length} agent files and ${agentAssets.length} manifest agent entries`);
}

validateAgents();