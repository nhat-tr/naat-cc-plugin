const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../../..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('runtime installer help is read-only and unknown options fail closed', () => {
  const installer = path.join(root, 'scripts', 'install-runtime.js');
  const help = childProcess.spawnSync(process.execPath, [installer, '--help', '--dry-run'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(help.status, 0, help.stdout + help.stderr);
  assert.match(help.stdout, /Usage:.*install-runtime/i);
  assert.doesNotMatch(help.stdout, /Prepared .*operation/i);

  const unknown = childProcess.spawnSync(process.execPath, [installer, '--definitely-unknown', '--dry-run'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.notEqual(unknown.status, 0, unknown.stdout + unknown.stderr);
  assert.match(unknown.stderr, /unknown option/i);
});

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
  assert.match(promotion, /canonical path/i);

  assert.deepEqual(manifest.assets['cli.work-lineage'], {
    type: 'cli',
    canonical_file: 'skills/brainstorming/scripts/work-lineage.cjs',
    supported_runtimes: ['claude', 'codex'],
  });
  assert.notEqual(fs.statSync(path.join(root, 'skills/brainstorming/scripts/work-lineage.cjs')).mode & 0o111, 0);
});

test('Claude command and portable skill share the compact Pair v4 plan contract', () => {
  const command = read('commands/pair-promote.md');
  const skill = read('skills/pair-promote/SKILL.md');
  const required = [
    'Intent Contract',
    'Pair mode',
    'Repository evidence',
    'tests-first',
    'integration/e2e',
    'Acceptance Criteria',
    'challenge-plan',
    'human-override',
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
  assert.match(skill, /Do not label repository behavior as a dependency/i);
});

test('pair promotion writes one tests-first Review Slice instead of RED/GREEN mini-epics', () => {
  const skill = read('skills/pair-promote/SKILL.md');

  assert.match(skill, /one complete behavior-sized Review Slice handled by the visible coordinator/i);
  assert.match(skill, /write the smallest failing test first/i);
  assert.match(skill, /not a tooling\/environment failure/i);
  assert.match(skill, /do not create separate RED, GREEN.*review tasks/i);
  assert.match(skill, /at least one integration\/e2e slice must cross a real acceptance boundary/i);
  assert.match(skill, /no-blockers:<digest>:<runtime>\/<model>/i);
  assert.match(skill, /human-override:<digest>:user:<reason-hash>/i);
  assert.doesNotMatch(skill, /red-expect:/i);
});

test('the compatibility engine owns validation while pair-v2 remains a wrapper', () => {
  const pairTask = read('skills/pair-v3/scripts/pair-task');
  const legacyWrapper = read('skills/pair-v2/scripts/validate-plan.sh');

  assert.match(pairTask, /path\.join\(SCRIPT_DIR, ["']validate-plan["']\)/);
  assert.doesNotMatch(pairTask, /pair-v2/);
  assert.match(legacyWrapper, /pair-v3\/scripts\/validate-plan/);
});

test('Pair v4 runbook is visible, resumable, repository-local, and portable across Claude and Codex', () => {
  const skill = read('skills/pair-v4/SKILL.md');
  const compatibility = read('skills/pair-v3/SKILL.md');
  const manifest = JSON.parse(read('metadata/runtime-asset-map.json'));
  const hooks = read('hooks/hooks.json');
  const ownerAdapter = read('skills/pair-v3/scripts/pair-owner-adapter');

  assert.deepEqual(manifest.assets['skill.pair-v4'].supported_runtimes, ['claude', 'codex']);
  assert.deepEqual(manifest.assets['skill.pair-v3'].supported_runtimes, ['claude', 'codex']);
  assert.deepEqual(manifest.assets['cli.pair-v4'].supported_runtimes, ['claude', 'codex']);
  assert.match(skill, /exactly three tmux panes/i);
  assert.match(skill, /visible Codex or Claude coordinator/i);
  assert.match(skill, /Review Session command itself runs in the reviewer pane/i);
  assert.match(skill, /authority lives under `\.pair\/runs\/<work-id>\/`/i);
  assert.match(skill, /`events\.jsonl` — append-only authoritative events/i);
  assert.match(skill, /One attempt ID survives CLI exits/i);
  assert.match(skill, /Additional in-repository files stay in the patch/i);
  assert.match(skill, /never silently restores visible coordinator work/i);
  assert.match(skill, /--discard-attempt <ATTEMPT> --confirm-discard/i);
  assert.match(skill, /--resume.*same invocation/i);
  assert.match(skill, /terminates only the journaled in-flight process group/i);
  assert.match(skill, /continue only the owning chat/i);
  assert.match(skill, /Claude captures the guaranteed hook `session_id`/i);
  assert.match(hooks, /pair-owner\.sh/);
  assert.match(ownerAdapter, /native-post-tool-owner-capture/);
  assert.match(skill, /Resume Checkpoint capped at 8,192 UTF-8 bytes/i);
  assert.match(skill, /no default two-interruption, two-attempt, two-plan-review, or two-final-review stops/i);
  assert.match(skill, /omit raw prompts, transcripts, private reasoning/i);
  assert.match(skill, /--legacy-v3/);
  assert.match(compatibility, /Pair v4 supersedes this workflow/i);
  assert.doesNotMatch(skill, /AskUserQuestion/);
});

test('digest-bound plan challenge is a portable Codex and Claude CLI', () => {
  const manifest = JSON.parse(read('metadata/runtime-asset-map.json'));
  const challenge = read('skills/pair-v3/scripts/pair-plan-challenge');
  const reviewSession = read('skills/pair-v3/scripts/lib/review-session.js');
  const pairLoop = read('bin/pair-loop');

  assert.deepEqual(manifest.assets['cli.pair-plan-challenge'].supported_runtimes, ['claude', 'codex']);
  assert.match(pairLoop, /--challenge-plan/);
  assert.match(challenge, /buildReviewRuntimeCommand/);
  assert.match(reviewSession, /'--sandbox', 'read-only'/);
  assert.match(reviewSession, /'exec', 'resume'/);
  assert.match(reviewSession, /'--resume', reviewerSessionId/);
  assert.doesNotMatch(reviewSession, /--ephemeral|--no-session-persistence/);
  assert.match(challenge, /resolveRuntimeCandidates/);
  assert.match(challenge, /PAIR_PLAN_REVIEW_HEARTBEAT_MS/);
  assert.match(challenge, /PAIR_PLAN_REVIEW_STALL_TIMEOUT_MS/);
  assert.match(challenge, /attempt-\$\{index \+ 1\}-\$\{runtime\}/);
  assert.match(challenge, /no-blockers:\$\{digest\}:\$\{reviewer\}/);
  assert.match(challenge, /PAIR_MAX_PLAN_REVIEWS/);
  assert.match(pairLoop, /--approve-plan/);

  const schema = JSON.parse(read('skills/pair-v3/schemas/plan-review-result.json'));
  assert.ok(schema.properties.findings.items.required.includes('origin'));
  assert.deepEqual(schema.properties.findings.items.properties.origin.enum, ['plan', 'environment']);
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
