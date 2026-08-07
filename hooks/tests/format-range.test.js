// A formatter applied to a whole file rewrites lines the session never touched, and the real change arrives
// buried in reformatting. CSharpier has no range mode, so format-range.mjs supplies one: format the whole
// file, then keep only the hunks overlapping the lines this session actually changed. Everything else stays
// byte-identical, which is what keeps a review diff about the change.

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const SCRIPT = path.resolve(__dirname, '..', 'format-range.mjs');
const DEFAULT_CONFIG = path.resolve(__dirname, '..', 'csharpier-default.json');
const TOOLS_PATH = `${path.join(os.homedir(), '.dotnet', 'tools')}:${process.env.PATH}`;

function csharpierAvailable() {
  const result = childProcess.spawnSync('csharpier', ['--version'], { encoding: 'utf8', env: { ...process.env, PATH: TOOLS_PATH } });
  return !result.error && result.status === 0;
}

function scratchParent() {
  const scratch = process.env.CLAUDE_SCRATCH_DIR || path.join(os.homedir(), '.claude-scratch');
  const parent = path.join(scratch, 'my-claude-code', 'format-range-tests');
  fs.mkdirSync(parent, { recursive: true });
  return parent;
}

// Two members whose parameter lists both exceed printWidth 160, so CSharpier splits either one. Committed
// unsplit, they stand for a repo that wraps by hand — the case where whole-file formatting does its damage.
const WIDE = 'string alpha, string beta, string gamma, string delta, string epsilon, string zeta, '
  + 'string eta, string theta, string iota, string kappa, string lambda, string mu, string nu, string xi';

const COMMITTED = `namespace Fixture;

public sealed class Widget
{
    public string Untouched(${WIDE}) => alpha;

    public string AlsoUntouched(${WIDE}) => beta;
}
`;

function repo(t) {
  const root = fs.mkdtempSync(path.join(scratchParent(), 'repo-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  childProcess.execFileSync('git', ['init', '-q'], { cwd: root });
  childProcess.execFileSync('git', ['config', 'user.email', 'hook@test'], { cwd: root });
  childProcess.execFileSync('git', ['config', 'user.name', 'Hook Test'], { cwd: root });
  fs.writeFileSync(path.join(root, 'Fixture.csproj'), '<Project Sdk="Microsoft.NET.Sdk" />\n');
  fs.writeFileSync(path.join(root, 'Widget.cs'), COMMITTED);
  childProcess.execFileSync('git', ['add', '-A'], { cwd: root });
  childProcess.execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
  return root;
}

function formatRange(file) {
  const result = childProcess.spawnSync('node', [SCRIPT, file, DEFAULT_CONFIG], {
    encoding: 'utf8',
    env: { ...process.env, PATH: TOOLS_PATH },
  });
  assert.equal(result.status, 0, `format-range must never fail an edit: ${result.stderr}`);
  return fs.readFileSync(file, 'utf8');
}

test('Range format rewraps the changed member and leaves every other line byte-identical', { skip: !csharpierAvailable() }, t => {
  const root = repo(t);
  const file = path.join(root, 'Widget.cs');
  fs.writeFileSync(file, COMMITTED.replace('public string AlsoUntouched(', 'public string Changed('));

  const output = formatRange(file);

  assert.match(output, /public string Changed\(\n/u, 'the member this session touched is formatted');
  assert.match(output, new RegExp(`public string Untouched\\(${WIDE.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\) => alpha;`, 'u'),
    'a member the session never touched keeps the exact bytes it was committed with');
});

test('Range format leaves a file it did not change completely alone', { skip: !csharpierAvailable() }, t => {
  const root = repo(t);
  const file = path.join(root, 'Widget.cs');

  assert.equal(formatRange(file), COMMITTED, 'no edit means nothing to format, however unformatted the file is');
});

// An added member is entirely the session's, so all of it is in range.
test('Range format formats an added member in full', { skip: !csharpierAvailable() }, t => {
  const root = repo(t);
  const file = path.join(root, 'Widget.cs');
  fs.writeFileSync(file, COMMITTED.replace(/\}\n$/u, `\n    public string Added(${WIDE}) => alpha;\n}\n`));

  const output = formatRange(file);

  assert.match(output, /public string Added\(\n/u);
  assert.match(output, new RegExp(`public string Untouched\\(${WIDE.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\)`, 'u'),
    'and still nothing else');
});

// The whole file is the change when there is nothing to compare against.
test('Range format formats a brand-new file entirely', { skip: !csharpierAvailable() }, t => {
  const root = repo(t);
  const file = path.join(root, 'Fresh.cs');
  fs.writeFileSync(file, COMMITTED);

  const output = formatRange(file);

  assert.match(output, /public string Untouched\(\n/u, 'a file with no committed version is all new lines');
});

test('Range format is idempotent, so a second edit cannot churn the file', { skip: !csharpierAvailable() }, t => {
  const root = repo(t);
  const file = path.join(root, 'Widget.cs');
  fs.writeFileSync(file, COMMITTED.replace('public string AlsoUntouched(', 'public string Changed('));

  const once = formatRange(file);
  const twice = formatRange(file);

  assert.equal(twice, once, 'running the hook again with no further edit changes nothing');
});

test('Range format writes nothing when the formatter is unavailable', t => {
  const root = repo(t);
  const file = path.join(root, 'Widget.cs');
  const edited = COMMITTED.replace('public string AlsoUntouched(', 'public string Changed(');
  fs.writeFileSync(file, edited);

  // Absolute node, empty PATH: the script itself still runs, and nothing it shells out to is findable.
  const result = childProcess.spawnSync(process.execPath, [SCRIPT, file, DEFAULT_CONFIG], {
    encoding: 'utf8',
    env: { ...process.env, PATH: '/nonexistent' },
  });

  assert.equal(result.status, 0, 'a missing formatter is a silent no-op, never a failed edit');
  assert.equal(fs.readFileSync(file, 'utf8'), edited);
});
