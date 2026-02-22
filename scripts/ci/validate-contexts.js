#!/usr/bin/env node
/**
 * Validate context markdown files have valid frontmatter with required fields.
 */

const fs = require('fs');
const path = require('path');

const CONTEXTS_DIR = process.env.CONTEXTS_DIR || path.join(__dirname, '../../contexts');
const REQUIRED_FIELDS = ['name', 'description'];

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

function validateContexts() {
  if (!fs.existsSync(CONTEXTS_DIR)) {
    console.log('No contexts directory found, skipping');
    process.exit(0);
  }

  const files = fs.readdirSync(CONTEXTS_DIR).filter(f => f.endsWith('.md'));
  let hasErrors = false;

  for (const file of files) {
    const content = fs.readFileSync(path.join(CONTEXTS_DIR, file), 'utf-8');
    const fm = extractFrontmatter(content);

    if (!fm) {
      console.error(`ERROR: ${file} - Missing or malformed frontmatter`);
      hasErrors = true;
      continue;
    }

    for (const field of REQUIRED_FIELDS) {
      if (!fm[field] || !fm[field].trim()) {
        console.error(`ERROR: ${file} - Missing required field: ${field}`);
        hasErrors = true;
      }
    }
  }

  if (hasErrors) process.exit(1);
  console.log(`Validated ${files.length} context files`);
}

validateContexts();
