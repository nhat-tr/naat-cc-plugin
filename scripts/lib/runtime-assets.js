#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '../..');
const MANIFEST_FILE = path.join(ROOT_DIR, 'metadata/runtime-asset-map.yaml');
const GENERATED_MARKER = '<!-- GENERATED: do not edit directly. Run `node scripts/generate-runtime-assets.js --write`. -->';
const AUTHOR_HOME_PATTERNS = [
  /\/Users\/[^/\s`'"]+/g,
  /\$HOME\/\.local\/share\/my-claude-code/g,
];

function loadManifest() {
  const raw = fs.readFileSync(MANIFEST_FILE, 'utf-8');
  const manifest = JSON.parse(raw);

  if (!manifest || typeof manifest !== 'object') {
    throw new Error(`Invalid manifest: ${MANIFEST_FILE}`);
  }

  return manifest;
}

function getAssetEntries(manifest = loadManifest()) {
  return Object.entries(manifest.assets || {}).map(([id, asset]) => ({
    id,
    ...asset,
  }));
}

function ensureFileExists(rootDir, relativePath) {
  const fullPath = path.join(rootDir, relativePath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Manifest path not found: ${relativePath}`);
  }
}

function walkFiles(dir, predicate = () => true, files = []) {
  if (!fs.existsSync(dir)) {
    return files;
  }

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);

    if (entry.name === '.git' || entry.name === 'node_modules') {
      continue;
    }

    if (entry.isDirectory()) {
      walkFiles(fullPath, predicate, files);
      continue;
    }

    if (predicate(fullPath)) {
      files.push(fullPath);
    }
  }

  return files;
}

function findAuthorHomeLeaks(content) {
  const matches = [];

  for (const pattern of AUTHOR_HOME_PATTERNS) {
    for (const match of content.matchAll(pattern)) {
      matches.push(match[0]);
    }
  }

  return [...new Set(matches)];
}

module.exports = {
  AUTHOR_HOME_PATTERNS,
  GENERATED_MARKER,
  MANIFEST_FILE,
  ROOT_DIR,
  ensureFileExists,
  findAuthorHomeLeaks,
  getAssetEntries,
  loadManifest,
  walkFiles,
};
