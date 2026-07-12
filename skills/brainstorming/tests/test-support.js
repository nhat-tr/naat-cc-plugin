const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function createScratchDirectory(t, purpose) {
  const scratchRoot = process.env.CLAUDE_SCRATCH_DIR
    || path.join(os.homedir(), '.claude-scratch');
  const parent = path.join(scratchRoot, 'my-claude-code', 'brainstorming-tests');
  fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, `${purpose}-`));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

module.exports = { createScratchDirectory };
