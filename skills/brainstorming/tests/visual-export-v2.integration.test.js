const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { buildStandaloneHtml } = require('../scripts/visual-session.cjs');
const { RAW_STANDALONE_LIMIT_BYTES } = require('../scripts/standalone.cjs');
const { createScratchDirectory } = require('./test-support');

const sessionCli = path.resolve(__dirname, '../scripts/visual-session.cjs');
const repositoryRoot = path.resolve(__dirname, '../../..');

const CAPABILITY = 'standalone-capability-must-not-ship';
const PROMPT = 'private-agent-prompt-must-not-ship';

test('raw standalone exports use the recorded inspectable size ceiling', () => {
  const budgets = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '../fixtures/performance-budgets.json'),
    'utf8',
  ));
  assert.equal(RAW_STANDALONE_LIMIT_BYTES, budgets.standalone_export.max_bytes);
});

function workspaceDocument() {
  const document = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../fixtures/product-concept-set.json'), 'utf8'));
  Object.assign(document, {
    title: 'Payment confirmation concepts',
    revision: undefined,
    feedback_threads: [{
      id: 'thread-1',
      component_id: 'concept-a',
      revision: 'a1b2c3d4',
      type: 'suggestion',
      status: 'resolved',
      comment: 'Keep the compact mobile state.',
      replies: [{
        id: 'reply-1',
        author: 'agent',
        text: 'The compact state is retained.',
        recorded_at: '2026-07-12T12:00:00.000Z',
      }],
    }],
    read_only: false,
  });
  const semantic = structuredClone(document);
  delete semantic.revision;
  const json = JSON.stringify(semantic);
  let hash = 0x811c9dc5;
  for (let index = 0; index < json.length; index += 1) {
    hash ^= json.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  document.revision = (hash >>> 0).toString(16).padStart(8, '0');
  return document;
}

function sessionSnapshot(privatePath) {
  return {
    version: 1,
    cursor: 0,
    pendingTurns: 1,
    events: [{
      version: 1,
      id: 'event-1',
      seq: 1,
      timestamp: 1_725_000_000_000,
      type: 'user.turn',
      role: 'user',
      clientTurnId: 'standalone-choice-1',
      message: 'Use the device-aware concept.',
      annotations: [{
        id: 'annotation-1',
        comment: 'Keep the compact state.',
        target: { componentId: 'concept-a', selector: null, label: 'Device-aware triptych' },
      }],
      choices: [{
        groupId: 'concept-choice',
        componentId: 'concept-a',
        value: 'concept-a',
        label: 'Device-aware triptych',
      }],
      screen: { id: 'screen', file: privatePath, revision: 'a1b2c3d4' },
      prompt: PROMPT,
    }],
    capability_token: CAPABILITY,
    connection_url: `http://localhost/session/example/?token=${CAPABILITY}`,
  };
}

function parseEmbeddedState(html) {
  const match = html.match(/window\.__BRAINSTORM_EMBEDDED__ = (\{[\s\S]*?\});/u);
  assert.ok(match, 'standalone export must embed its complete state');
  return JSON.parse(match[1]);
}

test('v2 standalone export is self-contained, secret-safe, and preserves the workspace plus feedback read-only', t => {
  const scratch = createScratchDirectory(t, 'standalone-v2-private-path');
  const privatePath = path.join(scratch, 'content', 'workspace.json');
  const document = workspaceDocument();
  const session = sessionSnapshot(privatePath);
  const documentBefore = structuredClone(document);
  const sessionBefore = structuredClone(session);

  const html = buildStandaloneHtml(document, session);
  const state = parseEmbeddedState(html);

  assert.doesNotMatch(html, /<link[^>]+href=["'](?:https?:|\/\/)/iu);
  assert.doesNotMatch(html, /<script[^>]+src=/iu);
  assert.equal(html.includes(CAPABILITY), false);
  assert.equal(html.includes(PROMPT), false);
  assert.equal(html.includes(privatePath), false);
  assert.equal(state.readOnly, true);
  assert.equal(state.screen.read_only, false, 'host readOnly must not rewrite Revision-bearing document content');
  assert.deepEqual(state.screen, document);
  assert.equal(state.screen.workspace_kind, 'product');
  assert.equal(state.screen.revision, document.revision);
  assert.deepEqual(state.screen.evidence_refs, document.evidence_refs);
  assert.deepEqual(state.screen.decisions, document.decisions);
  assert.deepEqual(state.screen.feedback_threads, document.feedback_threads);

  assert.equal(state.session.events[0].id, 'event-1');
  assert.equal(state.session.events[0].clientTurnId, 'standalone-choice-1');
  assert.equal(state.session.events[0].message, 'Use the device-aware concept.');
  assert.equal(state.session.events[0].annotations[0].id, 'annotation-1');
  assert.deepEqual(state.session.events[0].choices, session.events[0].choices);
  assert.equal(state.session.events[0].screen.revision, 'a1b2c3d4');
  assert.equal(Object.hasOwn(state.session.events[0], 'prompt'), false);
  assert.equal(Object.hasOwn(state.session, 'capability_token'), false);
  assert.equal(Object.hasOwn(state.session, 'connection_url'), false);

  assert.deepEqual(document, documentBefore, 'export must not mutate the live Visual Document');
  assert.deepEqual(session, sessionBefore, 'export must not mutate the Session Store snapshot');
  assert.equal(fs.existsSync(scratch), true);
});

test('standalone export fails closed on corrupt active v2 state and preserves the last good output', t => {
  const sessionDir = createScratchDirectory(t, 'standalone-v2-corrupt-active');
  const contentDir = path.join(sessionDir, 'content');
  const stateDir = path.join(sessionDir, 'state');
  const output = path.join(sessionDir, 'visual.html');
  fs.mkdirSync(contentDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(contentDir, 'screen.json'), '{"version":1}\n');
  fs.writeFileSync(path.join(contentDir, 'workspace.json'), '{"version":2,"broken":\n');
  fs.writeFileSync(path.join(stateDir, 'visual-format.json'), `${JSON.stringify({
    version: 1,
    active_version: 2,
    v1_document: 'content/screen.json',
    v2_document: 'content/workspace.json',
  })}\n`);
  const lastGood = '<html>last good export</html>\n';
  fs.writeFileSync(output, lastGood);

  const result = childProcess.spawnSync(process.execPath, [
    sessionCli,
    'export',
    '--session-dir', sessionDir,
    '--output', output,
  ], { cwd: repositoryRoot, encoding: 'utf8' });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /active|workspace|visual document|invalid json/i);
  assert.equal(`${result.stdout}\n${result.stderr}`.includes(sessionDir), false);
  assert.equal(fs.readFileSync(output, 'utf8'), lastGood);
});

test('standalone export fails closed on corrupt Session Store state instead of dropping feedback history', t => {
  const sessionDir = createScratchDirectory(t, 'standalone-corrupt-session-store');
  const contentDir = path.join(sessionDir, 'content');
  const stateDir = path.join(sessionDir, 'state');
  const output = path.join(sessionDir, 'visual.html');
  fs.mkdirSync(contentDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(contentDir, 'screen.json'), `${JSON.stringify({
    version: 1,
    profile: 'technical',
    title: 'Corrupt history fixture',
    sections: [{ kind: 'callout', id: 'history', title: 'History', body: 'Must remain durable.' }],
  })}\n`);
  fs.writeFileSync(path.join(stateDir, 'session.jsonl'), `${JSON.stringify({
    version: 1,
    id: 'event-1',
    seq: 1,
    timestamp: 1_725_000_000_000,
    type: 'user.turn',
    role: 'user',
    clientTurnId: 'history-turn',
    message: 'Do not drop this feedback.',
    annotations: [],
    choices: [],
    screen: null,
  })}\n`);
  fs.writeFileSync(path.join(stateDir, 'agent-cursor.json'), '{"seq":');
  const lastGood = '<html>history remains here</html>\n';
  fs.writeFileSync(output, lastGood);

  const result = childProcess.spawnSync(process.execPath, [
    sessionCli,
    'export',
    '--session-dir', sessionDir,
    '--output', output,
  ], { cwd: repositoryRoot, encoding: 'utf8' });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /session|cursor|feedback|invalid/i);
  assert.equal(`${result.stdout}\n${result.stderr}`.includes(sessionDir), false);
  assert.equal(fs.readFileSync(output, 'utf8'), lastGood);

  fs.writeFileSync(path.join(stateDir, 'agent-cursor.json'), '{"seq":0}\n');
  fs.writeFileSync(
    path.join(stateDir, 'session.jsonl'),
    `{"message":"${PROMPT}",`,
  );
  const corruptEvents = childProcess.spawnSync(process.execPath, [
    sessionCli,
    'export',
    '--session-dir', sessionDir,
    '--output', output,
  ], { cwd: repositoryRoot, encoding: 'utf8' });
  assert.notEqual(corruptEvents.status, 0);
  assert.match(corruptEvents.stderr, /session|history|event|invalid/i);
  assert.equal(corruptEvents.stderr.includes(PROMPT), false);
  assert.equal(corruptEvents.stderr.includes(sessionDir), false);
  assert.equal(fs.readFileSync(output, 'utf8'), lastGood);
});

test('stop retains a recoverable scratch Visual Session when its final export fails', t => {
  const sessionDir = createScratchDirectory(t, 'stop-retains-corrupt-session');
  const outputDir = createScratchDirectory(t, 'stop-retains-last-good-export');
  const contentDir = path.join(sessionDir, 'content');
  const stateDir = path.join(sessionDir, 'state');
  const output = path.join(outputDir, 'visual.html');
  fs.mkdirSync(contentDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(contentDir, 'screen.json'), `${JSON.stringify({
    version: 1,
    profile: 'technical',
    title: 'Recoverable stopped session',
    sections: [{ kind: 'callout', id: 'recovery', title: 'Recovery', body: 'Retain this Visual Session.' }],
  })}\n`);
  fs.writeFileSync(path.join(stateDir, 'session.jsonl'), '{"message":"truncated"');
  fs.writeFileSync(path.join(stateDir, 'agent-cursor.json'), '{"seq":0}\n');
  fs.writeFileSync(path.join(stateDir, 'session-meta.json'), `${JSON.stringify({
    session_dir: sessionDir,
    content_dir: contentDir,
    state_dir: stateDir,
    persistent: false,
    pid: null,
  })}\n`);
  const lastGood = '<html>last good stopped export</html>\n';
  fs.writeFileSync(output, lastGood);

  const result = childProcess.spawnSync(process.execPath, [
    sessionCli,
    'stop',
    '--session-dir', sessionDir,
    '--output', output,
  ], { cwd: repositoryRoot, encoding: 'utf8' });

  assert.notEqual(result.status, 0, 'stop must surface final export failure');
  assert.match(result.stderr, /standalone|export|session store|history|invalid/i);
  assert.equal(result.stderr.includes(sessionDir), false);
  assert.equal(fs.existsSync(sessionDir), true, 'recoverable Session Store state must not be deleted');
  assert.equal(fs.readFileSync(output, 'utf8'), lastGood);
});
