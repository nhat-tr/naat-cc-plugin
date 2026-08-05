const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The machine verification lease is deliberately global: one lock per user per machine, so suites of
// different Works cannot collide on this machine's Testcontainers databases and ports. That is correct in
// production and hostile in a test suite, where node --test runs several files at once and each would
// refuse the others' verifications — a real race, not a flake. Every test file that verifies requires this
// first, so each test PROCESS gets its own machine scope. Keyed by pid because node --test gives each file
// its own process; requiring it twice in one process is a no-op, which keeps it safe to add anywhere.
if (!process.env.PAIR_MACHINE_LEASE_DIR) {
  const scratch = process.env.CLAUDE_SCRATCH_DIR || path.join(os.homedir(), '.claude-scratch');
  const directory = path.join(scratch, 'my-claude-code', 'pair-test-machine-leases', `pid-${process.pid}`);
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  process.env.PAIR_MACHINE_LEASE_DIR = directory;
  process.on('exit', () => {
    try { fs.rmSync(directory, { recursive: true, force: true }); } catch { /* the suite is already over */ }
  });
}

module.exports = { machineLeaseDirectory: () => process.env.PAIR_MACHINE_LEASE_DIR };
