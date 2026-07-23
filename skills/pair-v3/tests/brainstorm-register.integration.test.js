const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const adapter = path.resolve(__dirname, '../scripts/pair-brainstorm-register-adapter');
const gateAdapter = path.resolve(__dirname, '../scripts/pair-handover-adapter');
const pairTask = path.resolve(__dirname, '../scripts/pair-task');
const handover = require('../scripts/lib/handover-state');

const FRESHNESS_WINDOW_MS = 60 * 60 * 1000;
const VISUAL_COMMAND =
  'cd /repo && node /home/u/.local/share/my-claude-code/skills/brainstorming/scripts/visual-session.cjs present --draft /scratch/draft.json';

function fixture(t) {
  const scratchBase = process.env.CLAUDE_SCRATCH_DIR || path.join(os.homedir(), '.claude-scratch');
  const root = fs.mkdtempSync(path.join(scratchBase, 'my-claude-code-brainstorm-register-'));
  childProcess.spawnSync('git', ['init', '-q'], { cwd: root });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function runAdapter(root, input, runtime = 'claude') {
  const result = childProcess.spawnSync(process.execPath, [adapter], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PAIR_HOOK_RUNTIME: runtime },
    input: `${JSON.stringify({ cwd: root, ...input })}\n`,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

function runGate(root, sessionId, now) {
  const result = childProcess.spawnSync(process.execPath, [gateAdapter], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PAIR_HOOK_RUNTIME: 'claude' },
    input: `${JSON.stringify({ cwd: root, hook_event_name: 'UserPromptSubmit', session_id: sessionId, now })}\n`,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

function postToolUse(command, sessionId = 'claude-brainstorm-agent', now = 1_000) {
  return { hook_event_name: 'PostToolUse', tool_name: 'Bash', session_id: sessionId, tool_input: { command }, now };
}

test('auto-registers a brainstorming conversation when the visual companion runs', t => {
  const root = fixture(t);
  runAdapter(root, postToolUse(VISUAL_COMMAND));

  const conversations = Object.values(handover.readAgentConversationRegistry(root).conversations);
  assert.equal(conversations.length, 1);
  assert.equal(conversations[0].kind, 'brainstorming');
  assert.equal(conversations[0].runtime, 'claude');
  assert.ok(
    conversations[0].checkpoint,
    'a non-null bootstrap checkpoint must be seeded so the cold conversation can later seal',
  );
  assert.equal(
    handover.hasAgentConversationRegistration(root, {
      runtime: 'claude',
      agentConversationId: 'claude-brainstorm-agent',
    }),
    true,
  );
});

test('auto-registers a Codex brainstorming conversation from the native CODEX_THREAD_ID identity', t => {
  const root = fixture(t);
  runAdapter(root, postToolUse(VISUAL_COMMAND, 'codex-brainstorm-agent', 5_000), 'codex');

  const conversations = Object.values(handover.readAgentConversationRegistry(root).conversations);
  assert.equal(conversations.length, 1);
  assert.equal(conversations[0].runtime, 'codex');
  assert.equal(conversations[0].kind, 'brainstorming');
  assert.ok(conversations[0].checkpoint, 'the Codex bootstrap checkpoint must be seeded so the conversation can seal');
});

test('remains inert for an unrelated Bash command so unregistered conversations stay untouched', t => {
  const root = fixture(t);
  runAdapter(root, postToolUse('npm run build && node dist/index.js'));
  assert.equal(fs.existsSync(path.join(root, '.pair', 'handovers')), false);
});

test('a cold auto-registered brainstorming conversation is sealed and blocked by the Freshness Gate', t => {
  const root = fixture(t);
  const t0 = 1_000_000;
  runAdapter(root, postToolUse(VISUAL_COMMAND, 'claude-cold-agent', t0));

  const belowBoundary = runGate(root, 'claude-cold-agent', t0 + FRESHNESS_WINDOW_MS - 1);
  assert.equal(belowBoundary, null, 'a prompt below sixty minutes must proceed');

  const atBoundary = runGate(root, 'claude-cold-agent', t0 + FRESHNESS_WINDOW_MS);
  assert.equal(atBoundary.decision, 'block', 'a prompt at sixty minutes must be blocked before model processing');
  assert.match(atBoundary.reason, /handover-[a-f0-9-]{36}/u, 'the block must reference a sealed handover id');
});

test('auto-registration is idempotent across repeated visual companion invocations', t => {
  const root = fixture(t);
  runAdapter(root, postToolUse(VISUAL_COMMAND, 'claude-idempotent', 1_000));
  runAdapter(root, postToolUse(VISUAL_COMMAND, 'claude-idempotent', 2_000));

  const conversations = Object.values(handover.readAgentConversationRegistry(root).conversations);
  assert.equal(conversations.length, 1, 'a repeated visual invocation must not create a second conversation');
  assert.equal(conversations[0].checkpoint_revision, 1, 'a repeated visual invocation must not clobber the checkpoint');
});

test('malformed hook input never throws and never registers', t => {
  const root = fixture(t);
  const result = childProcess.spawnSync(process.execPath, [adapter], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PAIR_HOOK_RUNTIME: 'claude' },
    input: 'not json at all',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(root, '.pair', 'handovers')), false);
});

test('--register-brainstorming seeds a bootstrap without stdin and composes with a later semantic checkpoint', t => {
  const root = fixture(t);
  const env = { ...process.env, CLAUDE_CODE_SESSION_ID: 'claude-bootstrap' };
  delete env.CODEX_THREAD_ID;
  delete env.CLAUDE_SESSION_ID;
  delete env.CLAUDE_SESSION_ID_OVERRIDE;

  const boot = childProcess.spawnSync(process.execPath, [pairTask, '--register-brainstorming', '--runtime', 'claude'], {
    cwd: root,
    encoding: 'utf8',
    env,
  });
  assert.equal(boot.status, 0, boot.stderr);

  let conversations = Object.values(handover.readAgentConversationRegistry(root).conversations);
  assert.equal(conversations.length, 1);
  assert.equal(conversations[0].kind, 'brainstorming');
  assert.ok(conversations[0].checkpoint);
  const bootstrapRevision = conversations[0].checkpoint_revision;

  const enrich = childProcess.spawnSync(process.execPath, [pairTask, '--brainstorm-checkpoint', '--runtime', 'claude'], {
    cwd: root,
    encoding: 'utf8',
    env,
    input: `${JSON.stringify({
      coreAnchor: 'Deterministic brainstorming registration closes the cold-handover gap.',
      nextAction: 'Confirm the anchor with the user.',
    })}\n`,
  });
  assert.equal(enrich.status, 0, enrich.stderr);

  conversations = Object.values(handover.readAgentConversationRegistry(root).conversations);
  assert.equal(conversations.length, 1, 'semantic enrichment must reuse the same conversation, not create a second');
  assert.equal(conversations[0].checkpoint.core_anchor, 'Deterministic brainstorming registration closes the cold-handover gap.');
  assert.ok(conversations[0].checkpoint_revision > bootstrapRevision, 'enrichment must advance the checkpoint revision');
});
