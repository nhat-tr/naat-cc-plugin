const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
  NESTED_SESSION_ENV_KEYS,
  runtimeDiagnostic,
  runtimeEnv,
} = require('../scripts/pair-task');

// runtimeEnv reads process.env at call time. Snapshot and restore the keys each
// test mutates so cases stay independent of the real environment.
function withEnv(t, overrides) {
  const touched = new Set([
    ...Object.keys(overrides),
    ...NESTED_SESSION_ENV_KEYS,
    'PATH',
    'PAIR_STOP_GATE',
    'CLAUDE_STOP_GATE',
  ]);
  const saved = new Map([...touched].map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const key of touched) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test('runtimeEnv strips cmux-cli-shims entries but keeps real PATH dirs', t => {
  const realDir = path.join('/usr', 'local', 'bin');
  const shimDir = path.join('/home', 'me', '.cmux-cli-shims');
  withEnv(t, { PATH: [shimDir, realDir].join(path.delimiter) });

  const env = runtimeEnv();
  const entries = env.PATH.split(path.delimiter);
  assert.ok(!entries.some(entry => entry.includes('cmux-cli-shims')), 'shim dir must be removed');
  assert.ok(entries.includes(realDir), 'real PATH dir must survive');
});

test('runtimeEnv clears every nested-session identity variable', t => {
  const overrides = Object.fromEntries(NESTED_SESSION_ENV_KEYS.map(key => [key, 'set']));
  withEnv(t, overrides);

  const env = runtimeEnv();
  for (const key of NESTED_SESSION_ENV_KEYS) {
    assert.equal(env[key], undefined, `${key} must be cleared for the spawned runtime`);
  }
});

test('runtimeEnv forces the stop gate off for the spawned runtime', t => {
  withEnv(t, { PAIR_STOP_GATE: 'on', CLAUDE_STOP_GATE: 'on' });

  const env = runtimeEnv();
  assert.equal(env.PAIR_STOP_GATE, 'off');
  assert.equal(env.CLAUDE_STOP_GATE, 'off');
});

test('runtimeDiagnostic reports a spawn error first', () => {
  assert.equal(
    runtimeDiagnostic({ error: { message: 'ENOENT claude' } }),
    'spawn error: ENOENT claude',
  );
});

test('runtimeDiagnostic surfaces stderr when the runtime wrote one', () => {
  assert.equal(
    runtimeDiagnostic({ status: 1, stderr: '  invalid --session-id  ', stdout: '' }),
    'invalid --session-id',
  );
});

test('runtimeDiagnostic explains a silent non-zero exit', () => {
  assert.equal(
    runtimeDiagnostic({ status: 2, stderr: '', stdout: '   ' }),
    'runtime exited 2 with no output',
  );
});

test('runtimeDiagnostic stays quiet when the runtime produced output', () => {
  assert.equal(
    runtimeDiagnostic({ status: 0, stderr: '', stdout: '{"status":"completed"}' }),
    '',
  );
});
