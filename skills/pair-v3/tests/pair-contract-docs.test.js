const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
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
    'validate-plan \\.pair/plan\\.md',
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

test('Pair promotion compiles a provider-neutral design contract into cheap-ready execution packets', () => {
  const glossary = read('UBIQUITOUS_LANGUAGE.md');
  const promotion = read('skills/pair-promote/SKILL.md');
  const pair = read('skills/pair-v4/SKILL.md');
  const command = read('commands/pair-promote.md');
  const designSchema = JSON.parse(read('skills/pair-v3/schemas/implementation-design.schema.json'));
  const packetSchema = JSON.parse(read('skills/pair-v3/schemas/review-slice-execution-packet.schema.json'));

  for (const term of ['Implementation Design Contract', 'Review Slice Execution Packet']) {
    assert.match(glossary, new RegExp(`\\*\\*${term}\\*\\*`));
  }
  for (const document of [promotion, command]) {
    assert.match(document, /Pair mode:\*\* compiled/i);
    assert.match(document, /Implementation Design Contract/i);
    assert.match(document, /record-evidence/i);
    assert.match(document, /cheap-ready/i);
  }
  assert.match(promotion, /Codex and Claude/i);
  assert.match(promotion, /work-lineage\.cjs record-evidence/i);
  assert.match(promotion, /next unused.*EVD-NNN/i);
  assert.match(promotion, /"work_id"/i);
  assert.match(promotion, /visible coordinator.*cannot.*switch/i);
  assert.match(promotion, /strength 2.*standard code/i);
  assert.match(promotion, /S or M.*low uncertainty/i);
  assert.match(promotion, /8,192|8192/);
  assert.match(pair, /every cheap-ready M/i);
  assert.match(pair, /deterministic.*sample.*cheap-ready S/i);
  assert.match(pair, /provider transcript.*model.*token/i);
  assert.match(pair, /tokens per accepted Review Slice/i);
  assert.equal(designSchema.additionalProperties, false);
  assert.equal(packetSchema.additionalProperties, false);
  assert.deepEqual(packetSchema.properties.routing.required, [
    'cheap_ready', 'recommended_strength', 'reasons', 'packet_bytes',
  ]);
  assert.deepEqual(JSON.parse(read('metadata/runtime-asset-map.json')).assets['cli.validate-implementation-design'], {
    type: 'cli',
    canonical_file: 'bin/validate-implementation-design',
    supported_runtimes: ['claude', 'codex'],
  });
  const help = childProcess.spawnSync(path.join(root, 'bin', 'validate-implementation-design'), ['--help'], {
    cwd: root, encoding: 'utf8',
  });
  assert.equal(help.status, 0, help.stdout + help.stderr);
  assert.match(help.stdout, /Usage: validate-implementation-design FILE/);
  assert.deepEqual(JSON.parse(read('metadata/runtime-asset-map.json')).assets['cli.validate-plan'], {
    type: 'cli',
    canonical_file: 'bin/validate-plan',
    supported_runtimes: ['claude', 'codex'],
  });
  const planHelp = childProcess.spawnSync(path.join(root, 'bin', 'validate-plan'), ['--help'], {
    cwd: root, encoding: 'utf8',
  });
  assert.equal(planHelp.status, 0, planHelp.stdout + planHelp.stderr);
  assert.match(planHelp.stdout, /Usage: validate-plan \[FILE\]/);
  assert.match(promotion, /\nvalidate-plan \.pair\/plan\.md\n/);
});

test('the pair-v4 runtime engine owns plan validation', () => {
  const pairTask = read('skills/pair-v3/scripts/pair-task');

  assert.match(pairTask, /path\.join\(SCRIPT_DIR, ["']validate-plan["']\)/);
  assert.doesNotMatch(pairTask, /pair-v2/);
});

test('pair-v1, pair-v2, and pair-v3 are offboarded as discoverable skills', () => {
  const manifest = JSON.parse(read('metadata/runtime-asset-map.json'));
  // The agent must never pick these up: no SKILL.md and no manifest skill asset.
  assert.equal(manifest.assets['skill.pair-v2'], undefined);
  assert.equal(manifest.assets['skill.pair-v3'], undefined);
  assert.equal(manifest.assets['agent.pair-reviewer'], undefined);
  assert.equal(fs.existsSync(path.join(root, 'skills/pair-v2')), false);
  assert.equal(fs.existsSync(path.join(root, 'skills/pair-v3/SKILL.md')), false);
  assert.equal(fs.existsSync(path.join(root, 'agents/pair-reviewer.md')), false);
  // The pair-v3 tree remains as the pair-v4 runtime engine — scripts, not a skill.
  assert.equal(fs.existsSync(path.join(root, 'skills/pair-v3/scripts/pair-loop')), true);
  assert.notEqual(manifest.assets['skill.pair-v4'], undefined);
});

test('Pair v4 runbook is visible, resumable, repository-local, and portable across Claude and Codex', () => {
  const skill = read('skills/pair-v4/SKILL.md');
  const manifest = JSON.parse(read('metadata/runtime-asset-map.json'));
  const hooks = read('hooks/hooks.json');
  const ownerAdapter = read('skills/pair-v3/scripts/pair-owner-adapter');

  assert.deepEqual(manifest.assets['skill.pair-v4'].supported_runtimes, ['claude', 'codex']);
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
  assert.match(skill, /challenges a plan at most twice across plan digests by default/i);
  assert.match(skill, /retains the reviewer findings.*visible coordinator/i);
  assert.match(skill, /omit raw prompts, transcripts, private reasoning/i);
  assert.match(skill, /--legacy-v3/);
  assert.doesNotMatch(skill, /AskUserQuestion/);
});

test('cold agent conversation vocabulary and commands stay aligned without mutating DR-003', () => {
  const glossary = read('UBIQUITOUS_LANGUAGE.md');
  const pair = read('skills/pair-v4/SKILL.md');
  const brainstorming = read('skills/brainstorming/SKILL.md');
  const readme = read('README.md');

  for (const term of ['Cold Agent Conversation', 'Agent Conversation Checkpoint', 'Agent Conversation Handover', 'Freshness Gate', 'Retired Agent Conversation']) {
    assert.match(glossary, new RegExp(`\\*\\*${term}\\*\\*`));
  }
  for (const document of [pair, brainstorming, readme]) {
    assert.match(document, /--fresh-from <handover-id>/i);
    assert.match(document, /--allow-cold-resume <handover-id> --once --confirm-cost-risk/i);
    assert.match(document, /refreshed handover|refreshed Agent Conversation Handover/i);
    assert.match(document, /direct adoption|adoption is the other retirement route/i);
  }
  assert.match(glossary, /successful handover adoption or successful one-shot checkpoint refresh/i);
});

test('Pair CLI help exposes the exact handover launch adoption and one-shot recovery commands', () => {
  const result = childProcess.spawnSync(process.execPath, [
    path.join(root, 'skills', 'pair-v3', 'scripts', 'pair-task'),
    '--help',
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--fresh-from HANDOVER_ID/iu);
  assert.match(result.stdout, /--adopt-handover HANDOVER_ID/iu);
  assert.match(result.stdout, /--allow-cold-resume HANDOVER_ID --once --confirm-cost-risk/iu);
  assert.match(result.stdout, /--brainstorm-checkpoint/iu);
  assert.match(result.stdout, /--handover-help/iu);
});

test('dedicated handover help teaches the automatic path and optional manual quality upgrade', () => {
  const result = childProcess.spawnSync(process.execPath, [
    path.join(root, 'skills', 'pair-v3', 'scripts', 'pair-task'),
    '--handover-help',
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Automatic path \(recommended\)/iu);
  assert.match(result.stdout, /pair-loop --enable-general-handover/iu);
  assert.match(result.stdout, /exactly 60 minutes idle/iu);
  assert.match(result.stdout, /pair-loop --freshness-status/iu);
  assert.match(result.stdout, /pair-loop --fresh-from <handover-id> --runtime auto/iu);
  assert.match(result.stdout, /pair-loop --adopt-handover <handover-id> --runtime codex\|claude/iu);
  assert.match(result.stdout, /Manual quality upgrade \(optional\)/iu);
  assert.match(result.stdout, /"coreAnchor"/u);
  assert.match(result.stdout, /pair-loop --conversation-checkpoint < checkpoint\.json/iu);
  assert.match(result.stdout, /reject interactive TTY stdin/iu);
  assert.match(result.stdout, /here-document/iu);
  assert.match(result.stdout, /pair-loop --handover-now/iu);
  assert.match(result.stdout, /pair-loop --disable-general-handover/iu);
});

test('README provides a copyable Agent Conversation Handover quick start', () => {
  const readme = read('README.md');
  assert.match(readme, /Agent Conversation Handover quick start/iu);
  assert.match(readme, /pair-loop --handover-help/iu);
  assert.match(readme, /pair-loop --enable-general-handover/iu);
  assert.match(readme, /exactly 60 minutes idle/iu);
  assert.match(readme, /pair-loop --freshness-status/iu);
  assert.match(readme, /pair-loop --conversation-checkpoint < checkpoint\.json/iu);
  assert.match(readme, /reject interactive TTY stdin/iu);
});

test('new Decision Record supersedes DR-003 without mutation', () => {
  const predecessorPath = 'docs/work/work-20260722-cold-agent-conversation-handover/decisions/DR-001-cold-agent-conversation-handover.md';
  const successorPath = 'docs/work/work-20260722-cold-agent-conversation-handover/decisions/DR-002-coordinated-stop-and-freshness-gate.md';
  const predecessor = read(predecessorPath);
  const successor = read(successorPath);
  const priorDecision = read('docs/work/work-20260719-pair-loop-observable-control/decisions/DR-003-bounded-resume-token-strategy.md');
  const work = JSON.parse(read('docs/work/work-20260722-cold-agent-conversation-handover/work.json'));

  assert.equal(crypto.createHash('sha256').update(predecessor).digest('hex'), '15454be533b19435ecc4ae3783127629333bf4f0e155530f525c5b3e688794eb');
  assert.match(successor, /\*\*Supersedes:\*\* `DR-001-cold-agent-conversation-handover`/u);
  assert.match(successor, /supersedes only.*DR-003.*stale same-agent-conversation default/isu);
  assert.match(successor, /does not supersede.*bounded Resume Checkpoint|preserves.*bounded Resume Checkpoint/isu);
  assert.match(priorDecision, /\*\*Superseded By:\*\* none/i);
  assert.ok(work.decision_records.includes(successorPath));
  assert.deepEqual(work.decision_supersessions, [{
    predecessor: 'DR-001-cold-agent-conversation-handover',
    successor: 'DR-002-coordinated-stop-and-freshness-gate',
  }]);
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

test('the Canonical Lifecycle diagram names verifying/reviewing as the blocked row predecessors and keeps "any active phase" on the pause row only', () => {
  const skill = read('skills/pair-v4/SKILL.md');
  const diagram = skill.match(/## Canonical Lifecycle\n\n```text\n([\s\S]*?)```/)[1];
  const lines = diagram.split('\n');

  const blockedLine = lines.find(line => line.includes('blocked (files preserved)'));
  assert.ok(blockedLine, 'diagram must contain a blocked row');
  assert.match(blockedLine, /verifying\/reviewing/, 'blocked must name verifying/reviewing as its source phases');
  assert.doesNotMatch(blockedLine, /any active phase/, 'blocked must not be reachable from any active phase');

  const pauseLine = lines.find(line => line.includes('pause boundary'));
  assert.ok(pauseLine, 'diagram must contain the pause row');
  assert.match(pauseLine, /any active phase/, 'pause remains reachable from any active phase');
  assert.doesNotMatch(pauseLine, /blocked/, 'pause row must not mention blocked');

  const activeActivePhaseLines = lines.filter(line => line.includes('any active phase'));
  assert.equal(activeActivePhaseLines.length, 1, '"any active phase" must appear on exactly one row (pause)');
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

test('pair promotion delegates the grounding sweep instead of reading the repository into the coordinator', () => {
  const skill = read('skills/pair-promote/SKILL.md');

  assert.match(skill, /delegate the grounding sweep/i);
  assert.match(skill, /re-charged on each later turn/i);
  assert.match(skill, /read-only subagents/i);
  assert.match(skill, /conclusions with locations/i);
  assert.match(skill, /forbid pasting file bodies back/i);
});

test('pair promotion converges the design in scratch before minting an evidence record', () => {
  const skill = read('skills/pair-promote/SKILL.md');

  assert.match(skill, /converge in scratch before recording anything/i);
  assert.match(skill, /promote-preflight/);
  assert.match(skill, /mints a throwaway `EVD-NNN`/i);
  assert.match(skill, /not the gate of record/i);
  assert.match(skill, /re-slice in scratch until every slice is within budget/i);
});
