// format-changed runs a formatter over the one file a session just wrote. Its whole value depends on the
// edit staying small: a formatter applied to a repo that formats another way rewrites the entire file, and
// the real change arrives buried in reformatting. Observed live in ParagonAgent, which declares no CSharpier
// config and conforms to none — one 12-line change to a shared test fixture came back as ~40 hunks, and the
// Pair checkpoint it produced could not be reviewed. These tests pin when the hook must decline.

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const HOOK = path.resolve(__dirname, '..', 'format-changed.sh');

function scratchParent() {
  const scratch = process.env.CLAUDE_SCRATCH_DIR || path.join(os.homedir(), '.claude-scratch');
  const parent = path.join(scratch, 'my-claude-code', 'format-changed-tests');
  fs.mkdirSync(parent, { recursive: true });
  return parent;
}

function csharpierAvailable() {
  const result = childProcess.spawnSync('csharpier', ['--version'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${path.join(os.homedir(), '.dotnet', 'tools')}:${process.env.PATH}` },
  });
  return !result.error && result.status === 0;
}

// A parameter list well past printWidth 160 on one line: CSharpier splits it, so a repo that commits it is
// demonstrably not CSharpier-formatted. Nothing about the code is unusual — many repos wrap by hand.
const WIDE_SIGNATURE = 'string alpha, string beta, string gamma, string delta, string epsilon, string zeta, '
  + 'string eta, string theta, string iota, string kappa, string lambda, string mu, string nu, string xi';
const UNFORMATTED = `namespace Fixture;

public sealed class Widget
{
    public string Describe(string first, string second) => first + second;

    public string Combine(${WIDE_SIGNATURE})
    {
        return alpha + beta + gamma + delta;
    }
}
`;

function repoWith(t, { files, config = null }) {
  const root = fs.mkdtempSync(path.join(scratchParent(), 'repo-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  childProcess.execFileSync('git', ['init', '-q'], { cwd: root });
  childProcess.execFileSync('git', ['config', 'user.email', 'hook@test'], { cwd: root });
  childProcess.execFileSync('git', ['config', 'user.name', 'Hook Test'], { cwd: root });
  fs.writeFileSync(path.join(root, 'Fixture.csproj'), '<Project Sdk="Microsoft.NET.Sdk" />\n');
  if (config) fs.writeFileSync(path.join(root, config.name), config.body);
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(root, name), body);
  childProcess.execFileSync('git', ['add', '-A'], { cwd: root });
  childProcess.execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
  return root;
}

function runHook(filePath) {
  const result = childProcess.spawnSync('bash', [HOOK], {
    input: JSON.stringify({ tool_input: { file_path: filePath } }),
    encoding: 'utf8',
    env: { ...process.env, PATH: `${path.join(os.homedir(), '.dotnet', 'tools')}:${process.env.PATH}` },
  });
  assert.equal(result.status, 0, `the hook must never fail an edit: ${result.stderr}`);
  return fs.readFileSync(filePath, 'utf8');
}

// One appended member is the whole edit. Anything else the file gains is the formatter's, not the session's.
function withEdit(body) {
  return body.replace(/\}\n$/u, '\n    public int Added => 1;\n}\n');
}

// The reason a repo that formats another way used to be a problem was blast radius, and range formatting is
// the answer to that: the default config still applies, but the widest it can reach is the edit itself.
test('a repo that states no formatting preference keeps every line the session did not touch', { skip: !csharpierAvailable() }, t => {
  const root = repoWith(t, { files: { 'Widget.cs': UNFORMATTED } });
  const file = path.join(root, 'Widget.cs');
  fs.writeFileSync(file, withEdit(UNFORMATTED));

  const output = runHook(file);

  assert.ok(output.includes(`public string Combine(${WIDE_SIGNATURE})`),
    'the hand-wrapped member the session never touched is still byte-identical');
  assert.match(output, /public int Added => 1;/u, 'and the edit itself survived');
});

test('a repo already formatted with CSharpier keeps being formatted, config or not', { skip: !csharpierAvailable() }, t => {
  const formatted = childProcess.execFileSync('csharpier', ['format', '--config-path',
    path.resolve(__dirname, '..', 'csharpier-default.json')], {
    input: UNFORMATTED,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${path.join(os.homedir(), '.dotnet', 'tools')}:${process.env.PATH}` },
  });
  assert.notEqual(formatted, UNFORMATTED, 'the fixture must actually exceed the default printWidth');
  const root = repoWith(t, { files: { 'Widget.cs': formatted } });
  const file = path.join(root, 'Widget.cs');
  // An edit CSharpier would rewrap, so "was it formatted" is observable rather than vacuous.
  fs.writeFileSync(file, formatted.replace(/\}\n$/u, `\n    public string Wide(${WIDE_SIGNATURE}) => alpha;\n}\n`));

  assert.match(runHook(file), /public string Wide\(\n/u,
    'a de-facto CSharpier repo gets the formatting it has always had, without declaring a config');
});

// An added line ~132 characters wide: the repo's own max_line_length = 80 splits it, the fallback
// printWidth = 160 leaves it alone. So which config won is directly observable, rather than inferred.
const MEDIUM_SIGNATURE = 'string alpha, string beta, string gamma, string delta, string epsilon, string zeta, string eta';

function withMediumEdit(body) {
  return body.replace(/\}\n$/u, `\n    public string Medium(${MEDIUM_SIGNATURE}) => alpha;\n}\n`);
}

test('a repo that declares a preference is formatted on its own terms', { skip: !csharpierAvailable() }, t => {
  const root = repoWith(t, {
    files: { 'Widget.cs': UNFORMATTED },
    config: { name: '.editorconfig', body: 'root = true\n\n[*.cs]\nmax_line_length = 80\n' },
  });
  const file = path.join(root, 'Widget.cs');
  fs.writeFileSync(file, withMediumEdit(UNFORMATTED));

  assert.match(runHook(file), /public string Medium\(\n/u,
    'an .editorconfig is the repo saying how wide it wants to be, so 80 is what the hook applies');
});

test('the fallback width is used only where the repo declares nothing', { skip: !csharpierAvailable() }, t => {
  const root = repoWith(t, { files: { 'Widget.cs': UNFORMATTED } });
  const file = path.join(root, 'Widget.cs');
  fs.writeFileSync(file, withMediumEdit(UNFORMATTED));

  assert.ok(runHook(file).includes(`public string Medium(${MEDIUM_SIGNATURE}) => alpha;`),
    'the same edit fits inside printWidth 160, so the fallback leaves it on one line');
});

// A file with no committed version is entirely the session's work, so every line of it is in range.
test('a brand-new file is formatted in full, because all of it is the change', { skip: !csharpierAvailable() }, t => {
  const root = repoWith(t, { files: { 'Widget.cs': UNFORMATTED } });
  const file = path.join(root, 'Fresh.cs');
  fs.writeFileSync(file, UNFORMATTED);

  assert.match(runHook(file), /public string Combine\(\n/u);
});
