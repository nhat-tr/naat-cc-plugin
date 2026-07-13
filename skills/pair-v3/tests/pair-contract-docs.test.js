const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../../..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('brainstorming uses adaptive approval and framework-native simplicity rules', () => {
  const skill = read('skills/brainstorming/SKILL.md');

  assert.match(skill, /batch up to three independent questions/i);
  assert.match(skill, /framework-native baseline/i);
  assert.match(skill, /deep modules/i);
  assert.doesNotMatch(skill, /Stream sketch.*user approves/i);
  assert.doesNotMatch(skill, /Generic mode.*Git-commit/i);
});

test('brainstorming and pair promotion preserve canonical Work lineage instead of raw workflow state', () => {
  const brainstorming = read('skills/brainstorming/SKILL.md');
  const promotion = read('skills/pair-promote/SKILL.md');
  const manifest = JSON.parse(read('metadata/runtime-asset-map.json'));

  assert.match(brainstorming, /docs\/work\/<work-id>\/spec\.md/i);
  assert.match(brainstorming, /work-lineage\.cjs create/i);
  assert.match(brainstorming, /generated active mirror/i);
  assert.match(brainstorming, /## Engineering Quality Contract/);
  assert.match(brainstorming, /\*\*Work ID:\*\* `<work-id>`/);
  assert.match(brainstorming, /do not commit.*(?:\.pair|raw workflow state)/i);

  assert.match(promotion, /Canonical SHA-256/i);
  assert.match(promotion, /work-lineage\.cjs validate/i);
  assert.match(promotion, /Work ID/i);
  assert.match(promotion, /canonical spec path/i);

  assert.deepEqual(manifest.assets['cli.work-lineage'], {
    type: 'cli',
    canonical_file: 'skills/brainstorming/scripts/work-lineage.cjs',
    supported_runtimes: ['claude', 'codex'],
  });
  assert.notEqual(fs.statSync(path.join(root, 'skills/brainstorming/scripts/work-lineage.cjs')).mode & 0o111, 0);
});

test('Claude command and portable skill share the capability-first plan contract', () => {
  const command = read('commands/pair-promote.md');
  const skill = read('skills/pair-promote/SKILL.md');
  const required = [
    'Intent Contract',
    'Capability Evidence',
    'Simplicity Contract',
    'framework-native baseline',
    'blocking',
    'skills/pair-v3/scripts/validate-plan',
  ];

  for (const phrase of required) {
    assert.match(command, new RegExp(phrase, 'i'), `command missing ${phrase}`);
    assert.match(skill, new RegExp(phrase, 'i'), `skill missing ${phrase}`);
  }
});

test('pair promotion distinguishes pinned dependencies from repository capabilities', () => {
  const skill = read('skills/pair-promote/SKILL.md');

  assert.match(skill, /\*\*Dependency:\*\* `?<name>@<pinned-version>`?/i);
  assert.match(skill, /\*\*Repository capability:\*\*/i);
  assert.match(skill, /Do not label repository-owned behavior as a dependency/i);
});

test('pair-v3 owns validation while pair-v2 remains a compatibility wrapper', () => {
  const pairTask = read('skills/pair-v3/scripts/pair-task');
  const legacyWrapper = read('skills/pair-v2/scripts/validate-plan.sh');

  assert.match(pairTask, /path\.join\(SCRIPT_DIR, 'validate-plan'\)/);
  assert.doesNotMatch(pairTask, /pair-v2/);
  assert.match(legacyWrapper, /pair-v3\/scripts\/validate-plan/);
});

test('the independent plan reviewer checks both evidence record types', () => {
  const pairReview = read('skills/pair-v2/scripts/pair-review');

  assert.match(pairReview, /Dependency.*name@version/i);
  assert.match(pairReview, /Repository capability/i);
  assert.match(pairReview, /model memory/i);
});

test('legacy pair review keeps scratch artifacts under the configured scratch root', () => {
  const pairReview = read('skills/pair-v2/scripts/pair-review');

  assert.match(pairReview, /CLAUDE_SCRATCH_DIR/);
  assert.match(pairReview, /\.claude-scratch/);
  assert.doesNotMatch(pairReview, /TMPDIR|\/tmp/);
});

test('visual brainstorming is explicit, authenticated, and uses the configured scratch root', () => {
  const guide = read('skills/brainstorming/visual-companion.md');
  const startServer = read('skills/brainstorming/scripts/start-server.sh');
  const visualSession = read('skills/brainstorming/scripts/visual-session.cjs');
  const shell = read('skills/brainstorming/assets/visual-shell/app.js');

  assert.match(guide, /explicitly requests a visual interview/i);
  assert.match(guide, /architecture canvases/i);
  assert.match(startServer, /visual-session\.cjs/);
  assert.match(visualSession, /CLAUDE_SCRATCH_DIR/);
  assert.match(visualSession, /randomBytes/);
  assert.doesNotMatch(startServer, /SESSION_DIR="\/tmp/);
  assert.match(shell, /api\/feedback/);
  assert.match(shell, /clientTurnId/);
});
