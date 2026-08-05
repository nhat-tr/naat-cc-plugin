const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  recoverAgentConversationCheckpoint,
} = require('../scripts/lib/conversation-checkpoint-recovery');

function fixture(t) {
  const scratchBase = process.env.CLAUDE_SCRATCH_DIR || path.join(os.homedir(), '.claude-scratch');
  const root = fs.mkdtempSync(path.join(scratchBase, 'my-claude-code-checkpoint-recovery-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'adapter.js'), 'module.exports = {};\n');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeJsonl(file, entries) {
  fs.writeFileSync(file, `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`);
}

test('recovers a bounded Codex checkpoint from observed event shapes without private or tool output', t => {
  const root = fixture(t);
  const transcriptPath = path.join(root, 'codex-session.jsonl');
  writeJsonl(transcriptPath, [
    {
      timestamp: '2026-07-26T20:00:00.000Z',
      type: 'session_meta',
      payload: { id: 'codex-general-session', cwd: root },
    },
    {
      timestamp: '2026-07-26T20:00:01.000Z',
      type: 'response_item',
      payload: {
        type: 'message', role: 'developer',
        content: [{ type: 'input_text', text: 'CODEX_SYSTEM_CANARY' }],
      },
    },
    {
      timestamp: '2026-07-26T20:00:02.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'Build automatic handover for ordinary conversations.' },
    },
    {
      timestamp: '2026-07-26T20:00:03.000Z',
      type: 'response_item',
      payload: { type: 'reasoning', summary: [{ text: 'CODEX_REASONING_CANARY' }] },
    },
    {
      timestamp: '2026-07-26T20:00:04.000Z',
      type: 'response_item',
      payload: {
        type: 'custom_tool_call', name: 'exec', call_id: 'call-1',
        input: 'const patch = "*** Begin Patch\\n*** Update File: src/adapter.js\\n*** End Patch";',
      },
    },
    {
      timestamp: '2026-07-26T20:00:05.000Z',
      type: 'response_item',
      payload: { type: 'custom_tool_call_output', call_id: 'call-1', output: 'CODEX_TOOL_OUTPUT_CANARY token=fixture-secret' },
    },
    {
      timestamp: '2026-07-26T20:00:06.000Z',
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'The provider-neutral adapter is implemented and still needs integration coverage.' },
    },
    {
      timestamp: '2026-07-26T20:00:07.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'Keep the sixty-minute Freshness Gate mandatory. token=fixture-user-secret' },
    },
    {
      timestamp: '2026-07-26T20:00:08.000Z',
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'The next action is to exercise the exact boundary through the hook.' },
    },
  ]);

  const recovered = recoverAgentConversationCheckpoint({
    root,
    runtime: 'codex',
    agentConversationId: 'codex-general-session',
    transcriptPath,
  });

  const serialized = JSON.stringify(recovered.checkpoint);
  assert.match(recovered.checkpoint.coreAnchor, /Build automatic handover/u);
  assert.match(recovered.checkpoint.coreAnchor, /sixty-minute Freshness Gate mandatory/u);
  assert.match(serialized, /provider-neutral adapter is implemented/u);
  assert.match(serialized, /\[REDACTED\]/u);
  assert.doesNotMatch(serialized, /CODEX_SYSTEM_CANARY|CODEX_REASONING_CANARY|CODEX_TOOL_OUTPUT_CANARY|fixture-secret|fixture-user-secret/u);
  assert.deepEqual(recovered.checkpoint.artifacts, [{
    path: 'src/adapter.js',
    sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'src', 'adapter.js'))).digest('hex'),
  }]);
  assert.match(recovered.sourceDigest, /^[a-f0-9]{64}$/u);
  assert.equal(recovered.messageCount, 4);
});

test('recovers Claude text chunks while excluding thinking, meta messages, and tool results', t => {
  const root = fixture(t);
  const transcriptPath = path.join(root, 'claude-session.jsonl');
  writeJsonl(transcriptPath, [
    {
      type: 'user', sessionId: 'claude-general-session', timestamp: '2026-07-26T20:00:00.000Z',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: '<system-reminder>CLAUDE_SYSTEM_REMINDER_CANARY</system-reminder>' },
          { type: 'text', text: 'Preserve the original user intent across handover.' },
        ],
      },
    },
    {
      type: 'assistant', sessionId: 'claude-general-session', timestamp: '2026-07-26T20:00:01.000Z',
      message: {
        id: 'msg-1', role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'CLAUDE_THINKING_CANARY' },
          { type: 'text', text: 'The parser can provide a safe recovery source.' },
          { type: 'tool_use', name: 'Write', input: { file_path: path.join(root, 'src', 'adapter.js') } },
        ],
      },
    },
    {
      type: 'assistant', sessionId: 'claude-general-session', timestamp: '2026-07-26T20:00:02.000Z',
      message: {
        id: 'msg-1', role: 'assistant',
        content: [{ type: 'text', text: 'A human-reviewed semantic checkpoint remains authoritative.' }],
      },
    },
    {
      type: 'user', sessionId: 'claude-general-session', timestamp: '2026-07-26T20:00:03.000Z',
      message: { role: 'user', content: [{ type: 'tool_result', content: 'CLAUDE_TOOL_RESULT_CANARY password=fixture-secret' }] },
    },
    {
      type: 'user', sessionId: 'claude-general-session', timestamp: '2026-07-26T20:00:04.000Z',
      isMeta: true,
      message: { role: 'user', content: 'CLAUDE_META_CANARY' },
    },
    {
      type: 'user', sessionId: 'claude-general-session', timestamp: '2026-07-26T20:00:05.000Z',
      message: { role: 'user', content: 'Use transcript recovery only as the fallback.' },
    },
    {
      type: 'user', sessionId: 'claude-general-session', timestamp: '2026-07-26T20:00:06.000Z',
      message: { role: 'user', content: 'Review AGENTS.md instructions without losing this legitimate direction.' },
    },
  ]);

  const recovered = recoverAgentConversationCheckpoint({
    root,
    runtime: 'claude',
    agentConversationId: 'claude-general-session',
    transcriptPath,
  });

  const serialized = JSON.stringify(recovered.checkpoint);
  assert.match(recovered.checkpoint.coreAnchor, /Preserve the original user intent/u);
  assert.match(recovered.checkpoint.coreAnchor, /transcript recovery only as the fallback/u);
  assert.match(recovered.checkpoint.coreAnchor, /Review AGENTS\.md instructions/u);
  assert.match(serialized, /safe recovery source/u);
  assert.match(serialized, /human-reviewed semantic checkpoint/u);
  assert.doesNotMatch(serialized, /CLAUDE_SYSTEM_REMINDER_CANARY|CLAUDE_THINKING_CANARY|CLAUDE_TOOL_RESULT_CANARY|CLAUDE_META_CANARY|fixture-secret/u);
  assert.deepEqual(recovered.checkpoint.artifacts.map(artifact => artifact.path), ['src/adapter.js']);
  assert.equal(recovered.messageCount, 4);
});

test('rejects a transcript whose native identity does not match the active conversation', t => {
  const root = fixture(t);
  const transcriptPath = path.join(root, 'wrong-session.jsonl');
  writeJsonl(transcriptPath, [{
    type: 'session_meta',
    payload: { id: 'different-codex-session', cwd: root },
  }]);

  assert.throws(() => recoverAgentConversationCheckpoint({
    root,
    runtime: 'codex',
    agentConversationId: 'active-codex-session',
    transcriptPath,
  }), /does not match the active Agent Conversation/u);
});

test('rejects a transcript containing more than one native conversation identity', t => {
  const root = fixture(t);
  const transcriptPath = path.join(root, 'mixed-session.jsonl');
  writeJsonl(transcriptPath, [
    { type: 'session_meta', payload: { id: 'active-codex-session', cwd: root } },
    { type: 'session_meta', payload: { id: 'different-codex-session', cwd: root } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'This mixed transcript must be rejected.' } },
  ]);

  assert.throws(() => recoverAgentConversationCheckpoint({
    root,
    runtime: 'codex',
    agentConversationId: 'active-codex-session',
    transcriptPath,
  }), /does not match the active Agent Conversation/u);
});

test('retains the latest user direction when earlier prompts exhaust the Core Anchor budget', t => {
  const root = fixture(t);
  const transcriptPath = path.join(root, 'long-codex-session.jsonl');
  writeJsonl(transcriptPath, [
    { type: 'session_meta', payload: { id: 'long-codex-session', cwd: root } },
    {
      type: 'event_msg',
      payload: { type: 'user_message', message: `INITIAL_ANCHOR ${'a'.repeat(5_000)}` },
    },
    {
      type: 'event_msg',
      payload: { type: 'user_message', message: `INTERMEDIATE_DIRECTION ${'b'.repeat(5_000)}` },
    },
    {
      type: 'event_msg',
      payload: { type: 'user_message', message: 'LATEST_DIRECTION_MUST_SURVIVE' },
    },
  ]);

  const recovered = recoverAgentConversationCheckpoint({
    root,
    runtime: 'codex',
    agentConversationId: 'long-codex-session',
    transcriptPath,
  });

  assert.match(recovered.checkpoint.coreAnchor, /INITIAL_ANCHOR/u);
  assert.match(recovered.checkpoint.coreAnchor, /LATEST_DIRECTION_MUST_SURVIVE/u);
  assert.ok(Buffer.byteLength(recovered.checkpoint.coreAnchor, 'utf8') <= 4_096);
});

test('prefers the latest explicit brainstorming Core Anchor and retains later user corrections', t => {
  const root = fixture(t);
  const transcriptPath = path.join(root, 'explicit-core-anchor.jsonl');
  writeJsonl(transcriptPath, [
    { type: 'session_meta', payload: { id: 'explicit-core-anchor', cwd: root } },
    {
      type: 'event_msg',
      payload: { type: 'user_message', message: 'I have a vague idea for session continuity.' },
    },
    {
      type: 'event_msg',
      payload: {
        type: 'agent_message',
        message: [
          '## Core Anchor',
          '### Purpose',
          'Preserve approved product direction across a fresh Agent Conversation.',
          '### Rejection Criteria',
          '- The adopter must not repeat discovery to reconstruct the anchor.',
          '### Contrasts',
          '- Not a raw transcript because the handover is bounded semantic state.',
        ].join('\n'),
      },
    },
    ...Array.from({ length: 5 }, (_, index) => ({
      type: 'event_msg',
      payload: { type: 'agent_message', message: `Later implementation conclusion ${index + 1}.` },
    })),
    {
      type: 'event_msg',
      payload: { type: 'user_message', message: 'Correction: the sixty-minute gate is mandatory.' },
    },
  ]);

  const recovered = recoverAgentConversationCheckpoint({
    root,
    runtime: 'codex',
    agentConversationId: 'explicit-core-anchor',
    transcriptPath,
  });

  assert.match(recovered.checkpoint.coreAnchor, /Preserve approved product direction/u);
  assert.match(recovered.checkpoint.coreAnchor, /must not repeat discovery/u);
  assert.match(recovered.checkpoint.coreAnchor, /sixty-minute gate is mandatory/u);
  assert.doesNotMatch(JSON.stringify(recovered.checkpoint.findings), /Preserve approved product direction/u);
  assert.ok(Buffer.byteLength(recovered.checkpoint.coreAnchor, 'utf8') <= 4_096);
});

test('recognizes the observed Goal-style Core Anchor after an artifact-path preamble', t => {
  const root = fixture(t);
  const transcriptPath = path.join(root, 'observed-core-anchor.jsonl');
  writeJsonl(transcriptPath, [
    { type: 'session_meta', payload: { id: 'observed-core-anchor', cwd: root } },
    {
      type: 'event_msg',
      payload: { type: 'user_message', message: '.artifacts/' },
    },
    {
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: '.artifacts/brainstorm/lens-review this is the Lens visual; review both repositories.',
      },
    },
    {
      type: 'event_msg',
      payload: {
        type: 'agent_message',
        message: [
          'Core Anchor for the verification design:',
          '- Goal: make Lens acceptance a machine-checkable claim over the real App to Agent path.',
          '- Success: thirty deterministic stub trials produce visible terminal outcomes.',
          '- Constraints: no real OpenAI request and no decisive boundary mocks.',
          '- Non-goals: backward compatibility for the unreleased contract.',
          '- Evidence rule: one later live counterexample invalidates acceptance.',
        ].join('\n'),
      },
    },
    {
      type: 'event_msg',
      payload: { type: 'user_message', message: 'Gate plus all confirmed remediation is required.' },
    },
  ]);

  const recovered = recoverAgentConversationCheckpoint({
    root,
    runtime: 'codex',
    agentConversationId: 'observed-core-anchor',
    transcriptPath,
  });

  assert.match(recovered.checkpoint.coreAnchor, /machine-checkable claim over the real App to Agent path/u);
  assert.match(recovered.checkpoint.coreAnchor, /thirty deterministic stub trials/u);
  assert.match(recovered.checkpoint.coreAnchor, /one later live counterexample invalidates acceptance/u);
  assert.match(recovered.checkpoint.coreAnchor, /Gate plus all confirmed remediation is required/u);
  assert.doesNotMatch(recovered.checkpoint.coreAnchor, /Initial user intent:\s*\.artifacts\//u);
});

test('skips a path-only preamble when recovering fallback user intent', t => {
  const root = fixture(t);
  const transcriptPath = path.join(root, 'path-preamble.jsonl');
  writeJsonl(transcriptPath, [
    { type: 'session_meta', payload: { id: 'path-preamble', cwd: root } },
    { type: 'event_msg', payload: { type: 'user_message', message: '.artifacts/' } },
    {
      type: 'event_msg',
      payload: { type: 'user_message', message: 'Review the Lens implementation against the approved visual.' },
    },
  ]);

  const recovered = recoverAgentConversationCheckpoint({
    root,
    runtime: 'codex',
    agentConversationId: 'path-preamble',
    transcriptPath,
  });

  assert.match(recovered.checkpoint.coreAnchor, /Initial user intent:\s*Review the Lens implementation/u);
  assert.doesNotMatch(recovered.checkpoint.coreAnchor, /Initial user intent:\s*\.artifacts\//u);
});

// A background-task completion notice arrives as a user-role entry, so recovery presented it as
// "Latest explicit user direction" — a real sealed checkpoint carried
// "<task-notification><task-id>bm603eb5u</task-id>…" where the human's own words belonged, and
// contradicted the genuine direction recorded beside it.
test('a harness task notification is not recovered as user direction', t => {
  const root = fixture(t);
  const transcriptPath = path.join(root, 'claude-notification-session.jsonl');
  writeJsonl(transcriptPath, [
    {
      type: 'user', sessionId: 'claude-notification-session', timestamp: '2026-08-04T10:00:00.000Z',
      message: { role: 'user', content: 'Accept S-01 and route the findings into S-02.' },
    },
    {
      type: 'user', sessionId: 'claude-notification-session', timestamp: '2026-08-04T10:01:00.000Z',
      message: {
        role: 'user',
        content: '<task-notification>\n<task-id>bm603eb5u</task-id>\n<status>completed</status>\n</task-notification>',
      },
    },
  ]);

  const recovered = recoverAgentConversationCheckpoint({
    root, runtime: 'claude', agentConversationId: 'claude-notification-session', transcriptPath,
  });

  assert.equal(recovered.latestUserDirection, 'Accept S-01 and route the findings into S-02.');
  assert.doesNotMatch(JSON.stringify(recovered.checkpoint), /task-notification/u);
});
