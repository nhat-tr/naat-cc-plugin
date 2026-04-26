#!/usr/bin/env node
/**
 * Validate runtime asset manifest integrity and repo-wide path portability.
 */

const fs = require('fs');
const path = require('path');
const {
  GENERATED_MARKER,
  ROOT_DIR,
  ensureFileExists,
  findAuthorHomeLeaks,
  getAssetEntries,
  loadManifest,
  walkFiles,
} = require('../lib/runtime-assets');

const KNOWN_RUNTIMES = new Set(['claude', 'codex', 'copilot']);
const POINTER_START = '<!-- BEGIN RUNTIME POINTERS -->';
const POINTER_END = '<!-- END RUNTIME POINTERS -->';
const POINTER_REGEX = /~\/\.(claude|codex|agents)\//g;
const BANNED_PORTABLE_TOKENS = [
  'Bash(',
  'Read(',
  '/clear',
  'subagent_type',
];

function removeRuntimePointerBlocks(content) {
  return content.replace(
    /<!-- BEGIN RUNTIME POINTERS -->[\s\S]*?<!-- END RUNTIME POINTERS -->/g,
    '',
  );
}

function validateCliWrapperTargets(asset, fullPath) {
  const content = fs.readFileSync(fullPath, 'utf-8');
  const matches = [...content.matchAll(/\.\.\/[A-Za-z0-9._/-]+/g)];
  const targets = [...new Set(matches.map((match) => match[0]))];
  const errors = [];

  for (const target of targets) {
    const resolved = path.resolve(path.dirname(fullPath), target);
    if (!fs.existsSync(resolved)) {
      errors.push(`ERROR: ${asset.id} references missing CLI target ${target}`);
    }
  }

  return errors;
}

function validateRuntimeAssets() {
  const manifest = loadManifest();
  const assets = getAssetEntries(manifest);
  let hasErrors = false;

  for (const generated of Object.values(manifest.generated_outputs || {})) {
    ensureFileExists(ROOT_DIR, generated.output);
  }

  for (const asset of assets) {
    try {
      ensureFileExists(ROOT_DIR, asset.canonical_file);
    } catch (error) {
      console.error(`ERROR: ${error.message} (${asset.id})`);
      hasErrors = true;
      continue;
    }

    if (!Array.isArray(asset.supported_runtimes) || asset.supported_runtimes.length === 0) {
      console.error(`ERROR: ${asset.id} missing supported_runtimes`);
      hasErrors = true;
    }

    if (!Array.isArray(asset.requires)) {
      console.error(`ERROR: ${asset.id} missing requires array`);
      hasErrors = true;
    }

    for (const runtime of asset.supported_runtimes || []) {
      if (!KNOWN_RUNTIMES.has(runtime)) {
        console.error(`ERROR: ${asset.id} declares unknown runtime ${runtime}`);
        hasErrors = true;
      }
    }

    if (asset.publish?.copilot?.path) {
      const targetPath = asset.publish.copilot.path;
      if (!targetPath.startsWith('.github/skills/')) {
        console.error(`ERROR: ${asset.id} has unsupported copilot publish path ${targetPath}`);
        hasErrors = true;
      }
    }

    const fullPath = path.join(ROOT_DIR, asset.canonical_file);
    const content = fs.readFileSync(fullPath, 'utf-8');
    const strippedContent = removeRuntimePointerBlocks(content);

    for (const token of BANNED_PORTABLE_TOKENS) {
      if ((asset.supported_runtimes || []).some((runtime) => runtime !== 'claude') && strippedContent.includes(token)) {
        console.error(`ERROR: ${asset.id} contains runtime-specific token outside allowed blocks: ${token}`);
        hasErrors = true;
      }
    }

    const pointerMatches = [...content.matchAll(POINTER_REGEX)];
    const isPortableBeyondClaude = (asset.supported_runtimes || []).some((runtime) => runtime !== 'claude');
    if (pointerMatches.length > 0 && isPortableBeyondClaude && !asset.allow_runtime_pointer_block) {
      console.error(`ERROR: ${asset.id} contains runtime pointers without allow_runtime_pointer_block`);
      hasErrors = true;
    }

    if (asset.allow_runtime_pointer_block) {
      if (!content.includes(POINTER_START) || !content.includes(POINTER_END)) {
        console.error(`ERROR: ${asset.id} must wrap runtime pointers in explicit markers`);
        hasErrors = true;
      }

      if ((removeRuntimePointerBlocks(content).match(/~\/\.(claude|codex|agents)\//g) || []).length > 0) {
        console.error(`ERROR: ${asset.id} has runtime pointers outside the explicit block`);
        hasErrors = true;
      }
    }

    if (asset.type === 'cli') {
      for (const error of validateCliWrapperTargets(asset, fullPath)) {
        console.error(error);
        hasErrors = true;
      }
    }
  }

  const checkedFiles = walkFiles(
    ROOT_DIR,
    (filePath) =>
      !filePath.includes(`${path.sep}.git${path.sep}`) &&
      !filePath.includes(`${path.sep}node_modules${path.sep}`) &&
      !filePath.endsWith('.png') &&
      !filePath.endsWith('.jpg') &&
      !filePath.endsWith('.jpeg') &&
      !filePath.endsWith('.webp')
  );

  for (const filePath of checkedFiles) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const leaks = findAuthorHomeLeaks(content);
    if (leaks.length > 0) {
      console.error(
        `ERROR: ${path.relative(ROOT_DIR, filePath)} contains author-home path leak(s): ${leaks.join(', ')}`
      );
      hasErrors = true;
    }
  }

  if (hasErrors) {
    process.exit(1);
  }

  console.log(`Validated ${assets.length} runtime asset entries and ${checkedFiles.length} checked-in file(s)`);
}

validateRuntimeAssets();
