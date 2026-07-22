#!/usr/bin/env node
/**
 * Validate skill directories have non-empty SKILL.md files.
 */

const fs = require('fs');
const path = require('path');

const SKILLS_DIR = process.env.SKILLS_DIR || path.join(__dirname, '../../skills');
// Pair v3 is retained only as the Pair v4 runtime engine. Its SKILL.md was
// deliberately removed so agents cannot discover or invoke it as a skill.
const RUNTIME_ENGINE_DIRECTORIES = new Set(['pair-v3']);

function validateSkills() {
  if (!fs.existsSync(SKILLS_DIR)) {
    console.log('No skills directory found, skipping');
    process.exit(0);
  }

  const dirs = fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .filter(e => !RUNTIME_ENGINE_DIRECTORIES.has(e.name))
    .map(e => e.name);

  let hasErrors = false;
  let validCount = 0;

  for (const dir of dirs) {
    const skillMd = path.join(SKILLS_DIR, dir, 'SKILL.md');

    if (!fs.existsSync(skillMd)) {
      console.error(`ERROR: ${dir}/ - Missing SKILL.md`);
      hasErrors = true;
      continue;
    }

    const content = fs.readFileSync(skillMd, 'utf-8');
    if (content.trim().length === 0) {
      console.error(`ERROR: ${dir}/SKILL.md - Empty file`);
      hasErrors = true;
      continue;
    }

    validCount++;
  }

  if (hasErrors) process.exit(1);
  console.log(`Validated ${validCount} skill directories`);
}

validateSkills();
