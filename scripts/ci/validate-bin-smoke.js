#!/usr/bin/env node

// Smoke-test bin/ CLI wrappers: `--help` must exit 0.
// Cheap (no network, no credentials) but catches import errors, missing deps,
// and top-level type/syntax regressions in the day-to-day tools.
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '../..');
const WRAPPERS = ['aspire-logs', 'aspire-traces', 'kibana-logs', 'kibana-traffic'];

let hasErrors = false;

for (const name of WRAPPERS) {
  const bin = path.join(ROOT_DIR, 'bin', name);
  const res = spawnSync(bin, ['--help'], { encoding: 'utf-8', timeout: 30000 });

  if (res.status !== 0) {
    const stderrHead = (res.stderr || res.error?.message || '').split('\n').slice(0, 3).join(' ');
    console.error(`ERROR: bin/${name} --help exited ${res.status}: ${stderrHead}`);
    hasErrors = true;
  }
}

if (hasErrors) {
  process.exit(1);
}

console.log(`Validated ${WRAPPERS.length} bin wrapper(s) via --help smoke test`);
