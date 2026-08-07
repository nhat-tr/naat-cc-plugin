// A repository declares how to start its program, and says so precisely enough to be corrected.
//
// AC-2: `.pair/runtime.json` carries `up`, `ready`, `down` and `env`; an invalid declaration is rejected
//       with a message naming the offending field.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { loadRuntimeDeclaration, validateRuntimeDeclaration } = require('../scripts/lib/runtime-declaration');

const VALID = {
  up: 'docker compose up -d',
  ready: 'curl -fsS http://localhost:5080/health',
  down: 'docker compose down',
  env: { ASPNETCORE_ENVIRONMENT: 'Development' },
};

function scratchRoot(t) {
  const scratch = process.env.CLAUDE_SCRATCH_DIR || path.join(os.homedir(), '.claude-scratch');
  const parent = path.join(scratch, 'my-claude-code', 'pair-runtime-tests');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'root-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('a runtime declaration states how to start, check and stop the program', () => {
  const declaration = validateRuntimeDeclaration(VALID);

  assert.equal(declaration.up, 'docker compose up -d');
  assert.equal(declaration.ready, 'curl -fsS http://localhost:5080/health');
  assert.equal(declaration.down, 'docker compose down');
  assert.deepEqual(declaration.env, { ASPNETCORE_ENVIRONMENT: 'Development' });
});

// The author of a declaration is a human editing JSON by hand under time pressure. A rejection that does
// not say which field is wrong costs them a bisect, so every message names one.
for (const [label, invalid, field] of [
  ['a missing up', { ...VALID, up: undefined }, 'up'],
  ['a missing ready', { ...VALID, ready: undefined }, 'ready'],
  ['a non-string down', { ...VALID, down: 7 }, 'down'],
  ['a missing env map', { ...VALID, env: undefined }, 'env'],
  ['a non-string env value', { ...VALID, env: { PORT: 5080 } }, 'env.PORT'],
]) {
  test(`${label} is rejected by name`, () => {
    assert.throws(() => validateRuntimeDeclaration(invalid), error => {
      assert.match(error.message, new RegExp(`\\b${field.replace('.', '\\.')}\\b`, 'u'));
      return true;
    });
  });
}

test('an unsupported field is rejected rather than silently ignored', () => {
  assert.throws(() => validateRuntimeDeclaration({ ...VALID, restart: 'docker compose restart' }), /restart/u);
});

test('a repository with no declaration answers absent, not invalid', t => {
  assert.equal(loadRuntimeDeclaration(scratchRoot(t)), null);
});

test('a declaration on disk is loaded and validated', t => {
  const root = scratchRoot(t);
  fs.mkdirSync(path.join(root, '.pair'), { recursive: true });
  fs.writeFileSync(path.join(root, '.pair', 'runtime.json'), JSON.stringify(VALID));

  assert.equal(loadRuntimeDeclaration(root).ready, VALID.ready);

  fs.writeFileSync(path.join(root, '.pair', 'runtime.json'), JSON.stringify({ ...VALID, ready: '' }));
  assert.throws(() => loadRuntimeDeclaration(root), /ready/u);
});
