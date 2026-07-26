const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { deriveBrainstormingCheckpoint } = require('../scripts/lib/brainstorm-checkpoint');
const { brainstormBootstrapCheckpoint, normalizeCheckpoint } = require('../scripts/lib/handover-state');

const BOOTSTRAP_CURRENT_DIRECTION = brainstormBootstrapCheckpoint().currentDirection;

// Builds a temp repo root plus a temp CLAUDE_SCRATCH_DIR override so the active-session pointer
// path (mirrored from visual-session.cjs's scratchRoot()/activeKey()) resolves inside a fixture
// that is torn down afterward, never the real ~/.claude-scratch.
function fixture(t) {
  const realScratchBase = process.env.CLAUDE_SCRATCH_DIR || path.join(os.homedir(), '.claude-scratch');
  const root = fs.mkdtempSync(path.join(realScratchBase, 'my-claude-code-brainstorm-checkpoint-'));
  const fakeScratchDir = fs.mkdtempSync(path.join(realScratchBase, 'my-claude-code-brainstorm-checkpoint-scratchenv-'));
  const previousScratchDir = process.env.CLAUDE_SCRATCH_DIR;
  process.env.CLAUDE_SCRATCH_DIR = fakeScratchDir;
  t.after(() => {
    if (previousScratchDir === undefined) delete process.env.CLAUDE_SCRATCH_DIR;
    else process.env.CLAUDE_SCRATCH_DIR = previousScratchDir;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(fakeScratchDir, { recursive: true, force: true });
  });
  return { root, fakeScratchDir };
}

function pointerFileFor({ root, fakeScratchDir }) {
  const digest = crypto.createHash('sha256').update(root).digest('hex').slice(0, 8);
  return path.join(fakeScratchDir, `${path.basename(root)}-${digest}`, 'brainstorm', 'active-session.json');
}

// Shapes below mirror the CURRENT on-disk schema, re-verified against the tree as of the
// concurrent Workspace Tabs change (skills/brainstorming/scripts/workspace-tabs.cjs is new,
// but workspace-document.cjs and session-store.cjs — the files that define these shapes — are
// untouched by it; `git diff --stat` against both showed no changes):
//   - decisions[]: workspace-document.cjs normalizeDecisions/normalizeWorkspaceDocument
//     (~lines 217-235, 355-368) — {id, title, multiselect, option_component_ids}, and the
//     document itself always carries version:2, title, revision alongside decisions.
//   - choices[]: session-store.cjs normalizeChoices (~lines 72-86) — {groupId, componentId,
//     value, label} on a `type: 'user.turn'` event.
// content/workspace.json itself is still "the currently active document" even with Workspace
// Tabs — see workspace-tabs.cjs's header comment and visual-session.cjs's
// writeDocumentIntoLiveSession (~line 702-705): tabs are additive, filed under tab-<id>.json,
// and never redirect or reshape this file.
const DEFAULT_DECISIONS = [
  { id: 'decision-a', title: 'Choose the auth strategy', multiselect: false, option_component_ids: ['opt-a1', 'opt-a2'] },
  { id: 'decision-b', title: 'Choose the storage engine', multiselect: false, option_component_ids: ['opt-b1', 'opt-b2'] },
];

const DEFAULT_CHOICES = [
  { groupId: 'decision-a', componentId: 'opt-a1', value: 'oauth', label: 'OAuth 2.0' },
];

// Writes the pointer file plus a live session directory (content/workspace.json,
// state/session.jsonl) that deriveBrainstormingCheckpoint's discovery resolves. Pass
// writePointer:false plus a sessionsRoot to model a stopped companion: visual-session.cjs
// removes active-session.json on stop, leaving only the session directory behind.
function writeSessionState(context, options = {}) {
  const {
    sessionId = 'session-abc123',
    decisions = DEFAULT_DECISIONS,
    choices = DEFAULT_CHOICES,
    turnMessage = 'SECRET_TRANSCRIPT_MESSAGE_never_copied',
    annotationComment = 'SECRET_ANNOTATION_COMMENT_never_copied',
    title = 'Checkout revamp',
    revision = 'abcd1234',
    workspaceOverride,
    writePointer = true,
    sessionsRoot = path.join(context.fakeScratchDir, 'sessions'),
  } = options;
  const sessionDir = path.join(sessionsRoot, sessionId);
  const contentDir = path.join(sessionDir, 'content');
  const stateDir = path.join(sessionDir, 'state');
  fs.mkdirSync(contentDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  if (writePointer) {
    const pointerFile = pointerFileFor(context);
    fs.mkdirSync(path.dirname(pointerFile), { recursive: true });
    fs.writeFileSync(pointerFile, JSON.stringify({
      version: 1,
      pid: process.pid,
      session_id: sessionId,
      session_dir: sessionDir,
      content_dir: contentDir,
      state_dir: stateDir,
    }));
  }

  const workspaceFile = path.join(contentDir, 'workspace.json');
  if (workspaceOverride !== undefined) {
    fs.writeFileSync(workspaceFile, workspaceOverride);
  } else {
    fs.writeFileSync(workspaceFile, JSON.stringify({
      version: 2, work_id: 'work-brainstorm', workspace_kind: 'ui-screens', title, revision, decisions,
    }));
  }

  if (choices.length) {
    const event = {
      version: 1,
      id: 'evt-1',
      seq: 1,
      timestamp: new Date(1_000).toISOString(),
      type: 'user.turn',
      role: 'user',
      clientTurnId: 'turn-1',
      message: turnMessage,
      annotations: annotationComment
        ? [{ id: 'ann-1', comment: annotationComment, target: { componentId: 'opt-a1', selector: null, label: null } }]
        : [],
      choices,
      screen: null,
    };
    fs.writeFileSync(path.join(stateDir, 'session.jsonl'), `${JSON.stringify(event)}\n`);
  }

  return { sessionId, sessionDir, contentDir, stateDir };
}

test('derives confirmed_choices, unresolved_decisions and current_direction from on-disk visual state', t => {
  const context = fixture(t);
  writeSessionState(context);
  const existing = normalizeCheckpoint(brainstormBootstrapCheckpoint());

  const derived = deriveBrainstormingCheckpoint(context.root, existing);

  assert.deepEqual(derived.confirmed_choices, ['Choose the auth strategy: OAuth 2.0']);
  assert.deepEqual(derived.unresolved_decisions, ['Choose the storage engine']);
  assert.equal(derived.current_direction, "Brainstorming 'Checkout revamp' at revision abcd1234.");
});

test('replaces current_direction only when it is still the exact bootstrap placeholder', t => {
  const context = fixture(t);
  writeSessionState(context);

  const bootstrapped = deriveBrainstormingCheckpoint(context.root, normalizeCheckpoint(brainstormBootstrapCheckpoint()));
  assert.notEqual(bootstrapped.current_direction, BOOTSTRAP_CURRENT_DIRECTION);

  const modelAuthored = normalizeCheckpoint({
    currentDirection: 'Focus the interview on the checkout redesign before touching storage.',
  });
  const preserved = deriveBrainstormingCheckpoint(context.root, modelAuthored);
  assert.equal(preserved.current_direction, 'Focus the interview on the checkout redesign before touching storage.');
});

test('preserves model-authored fields verbatim and merges lists with existing entries first', t => {
  const context = fixture(t);
  writeSessionState(context);

  const existing = normalizeCheckpoint({
    coreAnchor: 'Land the checkout redesign spec.',
    findings: [{ finding: 'Checkout drop-off spikes at payment step.', reference: 'analytics/checkout.md' }],
    confirmedChoices: ['Pre-existing decision: kept as-is.'],
    rejectedAlternatives: ['Rebuilding checkout from scratch.'],
    currentDirection: 'Confirm the payment provider before wireframing.',
    unresolvedDecisions: ['Pre-existing unresolved item.'],
    nextAction: 'Ask the user to confirm the payment provider.',
    artifacts: [{ path: 'docs/unrelated.md', sha256: 'a'.repeat(64) }],
  });

  const derived = deriveBrainstormingCheckpoint(context.root, existing);

  assert.equal(derived.core_anchor, existing.core_anchor);
  assert.deepEqual(derived.findings, existing.findings);
  assert.deepEqual(derived.rejected_alternatives, existing.rejected_alternatives);
  assert.equal(derived.next_action, existing.next_action);
  assert.equal(derived.current_direction, existing.current_direction);

  assert.deepEqual(derived.confirmed_choices, [
    'Pre-existing decision: kept as-is.',
    'Choose the auth strategy: OAuth 2.0',
  ]);
  assert.deepEqual(derived.unresolved_decisions, [
    'Pre-existing unresolved item.',
    'Choose the storage engine',
  ]);
  assert.ok(derived.artifacts.some(artifact => artifact.path === 'docs/unrelated.md'));

  const serialized = JSON.stringify(derived);
  assert.doesNotMatch(serialized, /SECRET_TRANSCRIPT_MESSAGE_never_copied/u);
  assert.doesNotMatch(serialized, /SECRET_ANNOTATION_COMMENT_never_copied/u);
});

test('includes .pair/spec.md and the session visual.json as artifacts, deduped by path', t => {
  const context = fixture(t);
  const { sessionId } = writeSessionState(context);

  fs.mkdirSync(path.join(context.root, '.pair'), { recursive: true });
  fs.writeFileSync(path.join(context.root, '.pair', 'spec.md'), '# Checkout revamp spec\n');
  const artifactDir = path.join(context.root, '.artifacts', 'brainstorm', sessionId);
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, 'visual.json'), JSON.stringify({ schema: 'brainstorm-interview/v1' }));

  const existing = normalizeCheckpoint({
    artifacts: [{ path: '.pair/spec.md', sha256: 'f'.repeat(64) }],
  });

  const derived = deriveBrainstormingCheckpoint(context.root, existing);

  const specSha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(context.root, '.pair', 'spec.md'))).digest('hex');
  const visualSha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(artifactDir, 'visual.json'))).digest('hex');

  assert.deepEqual(
    [...derived.artifacts].sort((a, b) => a.path.localeCompare(b.path)),
    [
      { path: '.pair/spec.md', sha256: specSha256 },
      { path: `.artifacts/brainstorm/${sessionId}/visual.json`, sha256: visualSha256 },
    ].sort((a, b) => a.path.localeCompare(b.path)),
  );
  assert.notEqual(specSha256, 'f'.repeat(64), 'the recomputed digest must not be the stale placeholder');
});

test('falls back to the newest scratch session beside the pointer when the pointer file is gone', t => {
  const context = fixture(t);
  const brainstormRoot = path.dirname(pointerFileFor(context));
  const older = writeSessionState(context, {
    sessionId: 'session-older',
    sessionsRoot: brainstormRoot,
    writePointer: false,
    title: 'Stale direction',
    revision: 'older111',
    choices: [],
  });
  const newer = writeSessionState(context, {
    sessionId: 'session-newer',
    sessionsRoot: brainstormRoot,
    writePointer: false,
  });
  fs.utimesSync(path.join(older.contentDir, 'workspace.json'), new Date(1_000), new Date(1_000));
  fs.utimesSync(path.join(newer.contentDir, 'workspace.json'), new Date(2_000), new Date(2_000));

  const derived = deriveBrainstormingCheckpoint(context.root, normalizeCheckpoint(brainstormBootstrapCheckpoint()));

  assert.equal(derived.current_direction, "Brainstorming 'Checkout revamp' at revision abcd1234.");
  assert.deepEqual(derived.confirmed_choices, ['Choose the auth strategy: OAuth 2.0']);
  assert.ok(derived.next_action.includes(`--session-dir ${newer.sessionDir}`), 'next_action must point at the newest session directory');
});

test('falls back to a persistent .brainstorm session in the repo root when no scratch state exists', t => {
  const context = fixture(t);
  const persistent = writeSessionState(context, {
    sessionId: 'session-persistent',
    sessionsRoot: path.join(context.root, '.brainstorm'),
    writePointer: false,
  });

  const derived = deriveBrainstormingCheckpoint(context.root, normalizeCheckpoint(brainstormBootstrapCheckpoint()));

  assert.deepEqual(derived.confirmed_choices, ['Choose the auth strategy: OAuth 2.0']);
  assert.ok(derived.next_action.includes(persistent.sessionDir), 'next_action must point at the persistent session directory');
});

test('replaces next_action with a resume command only while it is still the bootstrap placeholder', t => {
  const context = fixture(t);
  const { sessionDir } = writeSessionState(context);

  const bootstrapped = deriveBrainstormingCheckpoint(context.root, normalizeCheckpoint(brainstormBootstrapCheckpoint()));
  assert.match(bootstrapped.next_action, /visual-session\.cjs resume --session-dir /u);
  assert.ok(bootstrapped.next_action.includes(sessionDir));

  const modelAuthored = normalizeCheckpoint({ nextAction: 'Ask the user to confirm the payment provider.' });
  const preserved = deriveBrainstormingCheckpoint(context.root, modelAuthored);
  assert.equal(preserved.next_action, 'Ask the user to confirm the payment provider.');
});

test('returns the existing checkpoint unchanged when no active session pointer exists', t => {
  const context = fixture(t);
  const existing = normalizeCheckpoint(brainstormBootstrapCheckpoint());

  const derived = deriveBrainstormingCheckpoint(context.root, existing);

  assert.deepEqual(derived, existing);
});

test('returns the existing checkpoint unchanged for an unrecognized workspace document version or shape', t => {
  const context = fixture(t);
  const existing = normalizeCheckpoint(brainstormBootstrapCheckpoint());

  writeSessionState(context, { workspaceOverride: JSON.stringify({ version: 3, title: 'Future shape', decisions: [] }) });
  assert.deepEqual(deriveBrainstormingCheckpoint(context.root, existing), existing, 'an unrecognized version must not be trusted');

  writeSessionState(context, { workspaceOverride: JSON.stringify({ version: 2, title: 'No decisions array' }) });
  assert.deepEqual(deriveBrainstormingCheckpoint(context.root, existing), existing, 'a missing decisions[] array must not be trusted');
});

test('returns the existing checkpoint unchanged when workspace.json is corrupt JSON', t => {
  const context = fixture(t);
  writeSessionState(context, { workspaceOverride: '{not valid json' });
  const existing = normalizeCheckpoint(brainstormBootstrapCheckpoint());

  const derived = deriveBrainstormingCheckpoint(context.root, existing);

  assert.deepEqual(derived, existing);
});

test('returns the existing checkpoint unchanged when the active-session pointer is corrupt JSON', t => {
  const context = fixture(t);
  writeSessionState(context);
  fs.writeFileSync(pointerFileFor(context), '{not valid json');
  const existing = normalizeCheckpoint(brainstormBootstrapCheckpoint());

  const derived = deriveBrainstormingCheckpoint(context.root, existing);

  assert.deepEqual(derived, existing);
});

test('never throws when handed a null existing checkpoint against missing state', t => {
  const context = fixture(t);
  assert.doesNotThrow(() => {
    const derived = deriveBrainstormingCheckpoint(context.root, null);
    assert.equal(derived, null);
  });
});

test('deriving twice against unchanged on-disk state is idempotent (no revision churn)', t => {
  const context = fixture(t);
  writeSessionState(context);
  const existing = normalizeCheckpoint(brainstormBootstrapCheckpoint());

  const first = deriveBrainstormingCheckpoint(context.root, existing);
  const second = deriveBrainstormingCheckpoint(context.root, first);

  assert.equal(JSON.stringify(second), JSON.stringify(first));
});
