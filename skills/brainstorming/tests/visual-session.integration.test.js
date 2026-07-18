const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createBrainstormServer } = require('../scripts/server.cjs');
const { normalizeKnownWorkspaceContent } = require('../scripts/workspace-content.cjs');
const { normalizeWorkspaceDocument, WORKSPACE_KINDS } = require('../scripts/workspace-document.cjs');
const { createWorkspaceScaffold } = require('../scripts/workspace-scaffold.cjs');
const { SessionStore } = require('../scripts/session-store.cjs');
const { createScratchDirectory } = require('./test-support');

const sessionCli = path.resolve(__dirname, '../scripts/visual-session.cjs');

function runSession(...args) {
  return childProcess.spawnSync(process.execPath, [sessionCli, ...args], { encoding: 'utf8' });
}

function spawnSession(...args) {
  return childProcess.spawn(process.execPath, [sessionCli, ...args], { encoding: 'utf8' });
}

function architectureDraft(title) {
  return {
    work_id: 'work-20260713-architecture-draft-present',
    title,
    evidence: [{ id: 'EVD-001-architecture-trace', label: 'Observed architecture trace' }],
    boundaries: [{ id: 'runtime', label: 'Runtime' }],
    nodes: [
      {
        id: 'request-source',
        label: 'Request source',
        owner_id: 'runtime',
        type: 'interface',
        ports: [{
          id: 'request-output',
          label: 'Request',
          direction: 'output',
          kind: 'command',
          protocol: 'HTTP',
        }],
      },
      {
        id: 'request-handler',
        label: 'Request handler',
        owner_id: 'runtime',
        type: 'service',
        ports: [{
          id: 'request-input',
          label: 'Request',
          direction: 'input',
          kind: 'command',
          protocol: 'HTTP',
        }],
      },
    ],
    edges: [{
      id: 'request-flow',
      label: 'Request flow',
      type: 'command',
      source: { node_id: 'request-source', port_id: 'request-output' },
      target: { node_id: 'request-handler', port_id: 'request-input' },
    }],
    scenarios: [{
      id: 'handle-request',
      label: 'Handle request',
      description: 'Deliver one request to the handler.',
      paths: {
        current: {
          node_ids: ['request-source', 'request-handler'],
          edge_ids: ['request-flow'],
        },
        proposed: {
          node_ids: ['request-source', 'request-handler'],
          edge_ids: ['request-flow'],
        },
      },
    }],
    decisions: [{
      id: 'request-transport',
      title: 'Choose request transport',
      options: [
        { id: 'http-transport', label: 'HTTP' },
        { id: 'queue-transport', label: 'Queue' },
      ],
    }],
  };
}

function processOutput(child) {
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  return new Promise(resolve => {
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
}

function firstOutputLine(stream, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('timed out waiting for Visual Session startup')), timeoutMs);
    stream.setEncoding('utf8');
    stream.on('data', chunk => {
      output += chunk;
      const newline = output.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timeout);
      resolve(output.slice(0, newline));
    });
  });
}

async function readUntil(reader, expression, timeoutMs = 2_000) {
  const decoder = new TextDecoder();
  let value = '';
  const timeout = new Promise((_, reject) => {
    const handle = setTimeout(() => reject(new Error(`timed out waiting for ${expression}`)), timeoutMs);
    handle.unref?.();
  });
  while (!expression.test(value)) {
    const next = await Promise.race([reader.read(), timeout]);
    if (next.done) break;
    value += decoder.decode(next.value, { stream: true });
  }
  return value;
}

test('browser feedback is drained once on the next agent turn and replies return through the same session', async t => {
  const sessionDir = createScratchDirectory(t, 'integration');
  const contentDir = path.join(sessionDir, 'content');
  fs.mkdirSync(contentDir, { recursive: true });
  fs.writeFileSync(path.join(contentDir, 'screen.json'), JSON.stringify({
    profile: 'technical',
    audience: 'Software developers',
    title: 'Transport decision',
    sections: [{
      kind: 'decision',
      id: 'transport',
      title: 'Transport',
      options: [
        { id: 'transport-sse', label: 'SSE' },
        { id: 'transport-poll', label: 'Polling' },
      ],
    }],
  }));

  const app = createBrainstormServer({
    sessionDir,
    host: '127.0.0.1',
    port: 0,
    token: 'integration-secret',
    sessionId: 'integration-session',
    idleTimeoutMs: 60_000,
  });
  const address = await app.listen();
  t.after(() => app.close());

  const unauthorized = await fetch(`${address.url}${address.base_path}api/session`);
  assert.equal(unauthorized.status, 401);

  const root = await fetch(address.connection_url);
  const cookie = root.headers.get('set-cookie').split(';')[0];
  assert.equal(root.status, 200);
  assert.match(await root.text(), /visual-shell-root/);
  assert.doesNotMatch(root.headers.get('content-security-policy'), /unsafe-inline|ws:/);
  assert.match(root.headers.get('set-cookie'), /Path=\/session\/integration-session\//);

  const rejectedOrigin = await fetch(`${address.url}${address.base_path}api/feedback`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: 'http://malicious.local' },
    body: JSON.stringify({ message: 'Cross-origin turn' }),
  });
  assert.equal(rejectedOrigin.status, 403);

  const events = await fetch(`${address.url}${address.base_path}api/events`, { headers: { Cookie: cookie } });
  assert.match(events.headers.get('content-type'), /text\/event-stream/);
  const reader = events.body.getReader();
  t.after(() => reader.cancel());
  assert.match(await readUntil(reader, /connected/), /connected/);

  fs.writeFileSync(path.join(contentDir, 'screen.json'), JSON.stringify({
    profile: 'technical',
    title: 'Revised transport decision',
    sections: [{ kind: 'callout', id: 'revised', title: 'Revised', body: 'Prefer framework-owned SSE.', tone: 'positive' }],
  }));
  assert.match(await readUntil(reader, /event: screen/), /event: screen/);

  const submitted = await fetch(`${address.url}${address.base_path}api/feedback`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientTurnId: 'feedback-1',
      message: 'Show reconnection risk.',
      annotations: [{ id: 'note-1', comment: 'Keep ownership explicit.', target: { componentId: 'transport-sse' } }],
      choices: [{ groupId: 'transport', componentId: 'transport-sse', value: 'transport-sse', label: 'SSE' }],
      screen: { id: 'screen', file: 'screen.json' },
    }),
  });
  assert.equal(submitted.status, 201);

  const drained = runSession('drain', '--session-dir', sessionDir);
  assert.equal(drained.status, 0, drained.stderr);
  const browserTurn = JSON.parse(drained.stdout);
  assert.equal(browserTurn.message, 'Show reconnection risk.');
  assert.equal(browserTurn.annotations[0].target.componentId, 'transport-sse');

  const responseFile = path.join(sessionDir, 'agent-response.txt');
  fs.writeFileSync(responseFile, 'I added reconnect and ownership failure modes.');
  const replied = runSession('reply', '--session-dir', sessionDir, '--reply-to', String(browserTurn.seq), '--message-file', responseFile);
  assert.equal(replied.status, 0, replied.stderr);

  const drainedAgain = runSession('drain', '--session-dir', sessionDir);
  assert.deepEqual(JSON.parse(drainedAgain.stdout), { type: 'empty' });

  const session = await fetch(`${address.url}${address.base_path}api/session`, { headers: { Cookie: cookie } });
  const snapshot = await session.json();
  assert.equal(snapshot.cursor, browserTurn.seq);
  assert.equal(snapshot.pendingTurns, 0);
  assert.match(snapshot.events.at(-1).message, /reconnect and ownership/);

  const removedRoute = await fetch(`${address.url}${address.base_path}api/turns`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(removedRoute.status, 404);
});

test('wait returns the next browser feedback batch without a manual visual ready turn', async t => {
  const sessionDir = createScratchDirectory(t, 'wait-integration');
  const app = createBrainstormServer({
    sessionDir,
    host: '127.0.0.1',
    port: 0,
    token: 'wait-secret',
    sessionId: 'wait-session',
    idleTimeoutMs: 60_000,
  });
  const address = await app.listen();
  t.after(() => app.close());

  const root = await fetch(address.connection_url);
  const cookie = root.headers.get('set-cookie').split(';')[0];
  const waiter = spawnSession('wait', '--session-dir', sessionDir, '--timeout-ms', '1000');
  const waiterResult = processOutput(waiter);

  const submitted = await fetch(`${address.url}${address.base_path}api/feedback`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientTurnId: 'feedback-wait-1',
      message: 'No manual visual ready handoff.',
      screen: { id: 'screen', file: 'screen.json' },
    }),
  });
  assert.equal(submitted.status, 201);

  const waited = await waiterResult;
  assert.equal(waited.status, 0, waited.stderr);
  const browserTurn = JSON.parse(waited.stdout);
  assert.equal(browserTurn.clientTurnId, 'feedback-wait-1');
  assert.equal(browserTurn.message, 'No manual visual ready handoff.');

  const responseFile = path.join(sessionDir, 'agent-response.txt');
  fs.writeFileSync(responseFile, 'Received without a manual ready turn.');
  const replied = runSession('reply', '--session-dir', sessionDir, '--reply-to', String(browserTurn.seq), '--message-file', responseFile);
  assert.equal(replied.status, 0, replied.stderr);

  const drainedAgain = runSession('drain', '--session-dir', sessionDir);
  assert.deepEqual(JSON.parse(drainedAgain.stdout), { type: 'empty' });
});

test('each server scopes its browser cookie to a unique session path', async t => {
  const first = createBrainstormServer({ sessionDir: createScratchDirectory(t, 'cookie-first'), token: 'first-secret', idleTimeoutMs: 60_000 });
  const second = createBrainstormServer({ sessionDir: createScratchDirectory(t, 'cookie-second'), token: 'second-secret', idleTimeoutMs: 60_000 });
  const firstAddress = await first.listen();
  const secondAddress = await second.listen();
  t.after(() => Promise.all([first.close(), second.close()]));

  assert.notEqual(firstAddress.base_path, secondAddress.base_path);
  const firstCookie = (await fetch(firstAddress.connection_url)).headers.get('set-cookie');
  const secondCookie = (await fetch(secondAddress.connection_url)).headers.get('set-cookie');
  assert.match(firstCookie, new RegExp(`Path=${firstAddress.base_path.replaceAll('/', '\\/')}`));
  assert.match(secondCookie, new RegExp(`Path=${secondAddress.base_path.replaceAll('/', '\\/')}`));
});

test('scaffold command produces a screen the server accepts without a 422 repair cycle', async t => {
  const sessionDir = createScratchDirectory(t, 'scaffold-integration');
  const contentDir = path.join(sessionDir, 'content');
  const screenFile = path.join(contentDir, 'screen.json');
  fs.mkdirSync(contentDir, { recursive: true });

  const scaffolded = runSession(
    'scaffold',
    '--profile', 'technical',
    '--audience', 'Software developers',
    '--title', 'Framework-native design',
    '--summary', 'Compare observed capabilities.',
    '--kinds', 'anchor,flow,cards,decision,callout',
    '--output', screenFile,
  );
  assert.equal(scaffolded.status, 0, scaffolded.stderr);

  const app = createBrainstormServer({
    sessionDir,
    host: '127.0.0.1',
    port: 0,
    token: 'scaffold-secret',
    sessionId: 'scaffold-session',
    idleTimeoutMs: 60_000,
  });
  const address = await app.listen();
  t.after(() => app.close());

  const root = await fetch(address.connection_url);
  const cookie = root.headers.get('set-cookie').split(';')[0];
  const screen = await fetch(`${address.url}${address.base_path}api/screen`, { headers: { Cookie: cookie } });
  const screenPayload = await screen.json();
  assert.equal(screen.status, 200, JSON.stringify(screenPayload));
  assert.deepEqual(screenPayload.sections.map(section => section.kind), [
    'anchor', 'flow', 'cards', 'decision', 'callout',
  ]);
});

test('workspace scaffold command emits a canonical v2 draft for every Workspace Kind', t => {
  const outputDir = createScratchDirectory(t, 'workspace-scaffold-integration');
  const workId = 'work-20260713-scaffold-contract';

  for (const workspaceKind of WORKSPACE_KINDS) {
    const output = path.join(outputDir, `${workspaceKind}-workspace.json`);
    const scaffolded = runSession(
      'scaffold',
      '--workspace-kind', workspaceKind,
      '--work-id', workId,
      '--title', `${workspaceKind} workspace draft`,
      '--output', output,
    );
    assert.equal(scaffolded.status, 0, `${workspaceKind}: ${scaffolded.stderr}`);

    const result = JSON.parse(scaffolded.stdout);
    const document = JSON.parse(fs.readFileSync(output, 'utf8'));
    const normalized = normalizeWorkspaceDocument(document, {
      contentValidator: normalizeKnownWorkspaceContent,
    });

    assert.deepEqual(document, normalized, `${workspaceKind} scaffold must already be canonical`);
    assert.equal(document.version, 2);
    assert.equal(document.work_id, workId);
    assert.equal(document.workspace_kind, workspaceKind);
    assert.equal(document.title, `${workspaceKind} workspace draft`);
    assert.equal(document.read_only, false);
    assert.deepEqual(result, {
      type: 'workspace.scaffolded',
      workspace_file: output,
      work_id: workId,
      workspace_kind: workspaceKind,
      revision: document.revision,
    });
  }
});

test('present starts directly on a canonical v2 document and derives a stale Revision', async t => {
  const scratchRoot = createScratchDirectory(t, 'present-v2-session');
  const projectDir = path.join(scratchRoot, 'project');
  const candidateFile = path.join(scratchRoot, 'architecture-workspace.json');
  const environment = { ...process.env, CLAUDE_SCRATCH_DIR: scratchRoot };
  const candidate = createWorkspaceScaffold({
    workId: 'work-20260713-architecture-present',
    workspaceKind: 'architecture',
    title: 'Architecture before edit',
  });
  candidate.title = 'Architecture after edit';
  fs.writeFileSync(candidateFile, `${JSON.stringify(candidate)}\n`);

  const presented = childProcess.spawn(
    process.execPath,
    [sessionCli, 'present', '--document', candidateFile, '--project-dir', projectDir],
    { encoding: 'utf8', env: environment, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let info;
  t.after(() => {
    if (info?.session_dir) {
      childProcess.spawnSync(path.resolve(__dirname, '../scripts/stop-server.sh'), [info.session_dir], {
        encoding: 'utf8',
        env: environment,
      });
    }
    if (presented.exitCode == null) presented.kill('SIGTERM');
  });

  info = JSON.parse(await firstOutputLine(presented.stdout));
  assert.equal(info.type, 'visual-session-presented');
  assert.equal(info.workspace_kind, 'architecture');
  assert.equal(info.elk_preflight.status, 'ready');
  assert.equal(Object.hasOwn(info, 'render_preflight'), false, 'ELK-only evidence must not claim Shell readiness');
  assert.equal(info.work_id, 'work-20260713-architecture-present');
  assert.match(info.revision, /^[a-f0-9]{8}$/);
  assert.notEqual(info.revision, candidate.revision, 'Present must derive Revision after edits');
  assert.equal(info.feedback_delivery.mechanism, 'background_wait');
  assert.equal(info.feedback_delivery.wait_receiver, 'not_listening');
  assert.match(info.next_action, /background/i);

  const format = JSON.parse(fs.readFileSync(path.join(info.state_dir, 'visual-format.json'), 'utf8'));
  assert.equal(format.active_version, 2);
  const workspace = JSON.parse(fs.readFileSync(info.workspace_file, 'utf8'));
  assert.equal(workspace.title, 'Architecture after edit');
  assert.equal(workspace.revision, info.revision);
  assert.deepEqual(workspace, normalizeWorkspaceDocument(workspace, {
    contentValidator: normalizeKnownWorkspaceContent,
  }));

  candidate.title = 'Architecture after Publish';
  // Editing content invalidates the prior revision; drop it so Publish derives the matching one.
  // (Publish rejects a supplied revision that does not match its content — the integrity guard.)
  delete candidate.revision;
  fs.writeFileSync(candidateFile, `${JSON.stringify(candidate)}\n`);
  const published = childProcess.spawnSync(process.execPath, [
    sessionCli,
    'publish',
    '--document', candidateFile,
    '--session-dir', info.session_dir,
  ], { encoding: 'utf8', env: environment });
  assert.equal(published.status, 0, published.stderr);
  const publishedWorkspace = JSON.parse(fs.readFileSync(info.workspace_file, 'utf8'));
  assert.equal(publishedWorkspace.title, 'Architecture after Publish');
  assert.notEqual(publishedWorkspace.revision, workspace.revision);

  const root = await fetch(info.connection_url);
  const cookie = root.headers.get('set-cookie').split(';')[0];
  const active = await fetch(`${info.url}${info.base_path}api/screen`, { headers: { Cookie: cookie } });
  assert.equal(active.status, 200);
  assert.equal((await active.json()).workspace_kind, 'architecture');
});

test('present reuses a live session on a workspace-kind switch instead of orphaning the browser URL', async t => {
  const scratchRoot = createScratchDirectory(t, 'present-reuse-session');
  const projectDir = path.join(scratchRoot, 'project');
  const environment = { ...process.env, CLAUDE_SCRATCH_DIR: scratchRoot };

  const productFile = path.join(scratchRoot, 'product-workspace.json');
  const product = createWorkspaceScaffold({
    workId: 'work-20260714-product-lens',
    workspaceKind: 'product',
    title: 'Product concepts',
  });
  fs.writeFileSync(productFile, `${JSON.stringify(product)}\n`);

  const architectureFile = path.join(scratchRoot, 'architecture-workspace.json');
  const architecture = createWorkspaceScaffold({
    workId: 'work-20260714-architecture-lens',
    workspaceKind: 'architecture',
    title: 'Architecture canvas',
  });
  fs.writeFileSync(architectureFile, `${JSON.stringify(architecture)}\n`);

  const presented = childProcess.spawn(
    process.execPath,
    [sessionCli, 'present', '--document', productFile, '--project-dir', projectDir],
    { encoding: 'utf8', env: environment, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let info;
  t.after(() => {
    if (info?.session_dir) {
      childProcess.spawnSync(path.resolve(__dirname, '../scripts/stop-server.sh'), [info.session_dir], {
        encoding: 'utf8',
        env: environment,
      });
    }
    if (presented.exitCode == null) presented.kill('SIGTERM');
  });
  info = JSON.parse(await firstOutputLine(presented.stdout));
  assert.equal(info.type, 'visual-session-presented');
  assert.equal(info.workspace_kind, 'product');

  // Switching the workspace kind while the session is live must REUSE the running server —
  // same port, token, and URL — so the already-open browser tab is not orphaned.
  const represented = childProcess.spawnSync(
    process.execPath,
    [sessionCli, 'present', '--document', architectureFile, '--project-dir', projectDir],
    { encoding: 'utf8', env: environment },
  );
  assert.equal(represented.status, 0, represented.stderr);
  const reuse = JSON.parse(represented.stdout.trim().split('\n').pop());
  assert.equal(reuse.type, 'visual-session-represented');
  assert.equal(reuse.url, info.url, 'a reused session keeps the same server URL and port');
  assert.equal(reuse.session_dir, info.session_dir, 'a reused session does not create a new session directory');
  assert.equal(reuse.workspace_kind, 'architecture');
  // Reuse must re-emit a working link so the agent can re-paste it instead of saying "same URL".
  assert.equal(reuse.connection_url, info.connection_url, 'represent re-emits the original connection_url');

  // The re-emitted connection URL still authenticates and now serves the architecture document.
  const root = await fetch(reuse.connection_url);
  const cookie = root.headers.get('set-cookie').split(';')[0];
  const active = await fetch(`${info.url}${info.base_path}api/screen`, { headers: { Cookie: cookie } });
  assert.equal(active.status, 200);
  assert.equal((await active.json()).workspace_kind, 'architecture');

  // status recovers the same shareable link, so a lost URL is always retrievable.
  const statusResult = childProcess.spawnSync(
    process.execPath,
    [sessionCli, 'status', '--session-dir', info.session_dir],
    { encoding: 'utf8', env: environment },
  );
  assert.equal(statusResult.status, 0, statusResult.stderr);
  assert.equal(JSON.parse(statusResult.stdout).connection_url, info.connection_url);
});

test('reply accepts an inline --message and re-emits the shareable connection URL', async t => {
  const scratchRoot = createScratchDirectory(t, 'reply-inline');
  const projectDir = path.join(scratchRoot, 'project');
  const environment = { ...process.env, CLAUDE_SCRATCH_DIR: scratchRoot };
  const candidateFile = path.join(scratchRoot, 'architecture-workspace.json');
  fs.writeFileSync(candidateFile, `${JSON.stringify(createWorkspaceScaffold({
    workId: 'work-20260715-reply-inline',
    workspaceKind: 'architecture',
    title: 'Reply canvas',
  }))}\n`);

  const presented = childProcess.spawn(
    process.execPath,
    [sessionCli, 'present', '--document', candidateFile, '--project-dir', projectDir],
    { encoding: 'utf8', env: environment, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let info;
  t.after(() => {
    if (info?.session_dir) {
      childProcess.spawnSync(path.resolve(__dirname, '../scripts/stop-server.sh'), [info.session_dir], {
        encoding: 'utf8',
        env: environment,
      });
    }
    if (presented.exitCode == null) presented.kill('SIGTERM');
  });
  info = JSON.parse(await firstOutputLine(presented.stdout));

  // A browser turn must exist for reply to acknowledge.
  new SessionStore(info.state_dir).appendBrowserTurn({
    message: 'Tighten the ownership boundary.',
    annotations: [],
    choices: [],
  });

  const replied = childProcess.spawnSync(
    process.execPath,
    [sessionCli, 'reply', '--message', 'Acknowledged inline — no temp file needed.', '--session-dir', info.session_dir],
    { encoding: 'utf8', env: environment },
  );
  assert.equal(replied.status, 0, replied.stderr);
  const record = JSON.parse(replied.stdout);
  assert.equal(record.message, 'Acknowledged inline — no temp file needed.');
});

test('present and Publish compile Architecture Drafts without migration or manual Revision work', async t => {
  const scratchRoot = createScratchDirectory(t, 'present-architecture-draft');
  const projectDir = path.join(scratchRoot, 'project');
  const draftFile = path.join(scratchRoot, 'architecture-draft.json');
  const environment = { ...process.env, CLAUDE_SCRATCH_DIR: scratchRoot };
  fs.writeFileSync(draftFile, `${JSON.stringify(architectureDraft('Initial architecture'))}\n`);

  const presented = childProcess.spawn(
    process.execPath,
    [sessionCli, 'present', '--draft', draftFile, '--project-dir', projectDir],
    { encoding: 'utf8', env: environment, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let info;
  t.after(() => {
    if (info?.session_dir) {
      childProcess.spawnSync(path.resolve(__dirname, '../scripts/stop-server.sh'), [info.session_dir], {
        encoding: 'utf8',
        env: environment,
      });
    }
    if (presented.exitCode == null) presented.kill('SIGTERM');
  });

  info = JSON.parse(await firstOutputLine(presented.stdout));
  assert.equal(info.type, 'visual-session-presented');
  assert.equal(info.workspace_kind, 'architecture');
  assert.equal(JSON.parse(fs.readFileSync(path.join(info.state_dir, 'visual-format.json'), 'utf8')).active_version, 2);
  const firstRevision = info.revision;

  fs.writeFileSync(draftFile, `${JSON.stringify(architectureDraft('Revised architecture'))}\n`);
  const published = childProcess.spawnSync(process.execPath, [
    sessionCli,
    'publish',
    '--draft', draftFile,
    '--session-dir', info.session_dir,
  ], { encoding: 'utf8', env: environment });
  assert.equal(published.status, 0, published.stderr);

  const workspace = JSON.parse(fs.readFileSync(info.workspace_file, 'utf8'));
  assert.equal(workspace.title, 'Revised architecture');
  assert.notEqual(workspace.revision, firstRevision);
  assert.deepEqual(workspace.decisions[0].option_component_ids, ['http-transport', 'queue-transport']);
});

test('fresh Visual Session supports the documented v1 to v2 migration, Publish, and backout lifecycle', async t => {
  const scratchRoot = createScratchDirectory(t, 'fresh-v2-session');
  const projectDir = path.join(scratchRoot, 'project');
  const environment = { ...process.env, CLAUDE_SCRATCH_DIR: scratchRoot };
  const started = childProcess.spawn(
    process.execPath,
    [sessionCli, 'start', '--project-dir', projectDir],
    { encoding: 'utf8', env: environment, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let info;
  t.after(() => {
    if (info?.session_dir) {
      childProcess.spawnSync(path.resolve(__dirname, '../scripts/stop-server.sh'), [info.session_dir], {
        encoding: 'utf8',
        env: environment,
      });
    }
    if (started.exitCode == null) started.kill('SIGTERM');
  });

  info = JSON.parse(await firstOutputLine(started.stdout));
  const legacyFile = path.join(info.content_dir, 'screen.json');
  assert.equal(fs.existsSync(legacyFile), true, 'fresh Start must persist its v1 compatibility document');
  assert.equal(JSON.parse(fs.readFileSync(legacyFile, 'utf8')).version, 1);

  const migrated = childProcess.spawnSync(process.execPath, [
    sessionCli,
    'migrate',
    '--work-id', 'work-20260712-visual-companion-vnext',
    '--workspace-kind', 'review',
    '--session-dir', info.session_dir,
  ], { encoding: 'utf8', env: environment });
  assert.equal(migrated.status, 0, migrated.stderr);

  const published = childProcess.spawnSync(process.execPath, [
    sessionCli,
    'publish',
    '--document', path.resolve(__dirname, '../fixtures/feature-review-work.json'),
    '--session-dir', info.session_dir,
  ], { encoding: 'utf8', env: environment });
  assert.equal(published.status, 0, published.stderr);

  const root = await fetch(info.connection_url);
  const cookie = root.headers.get('set-cookie').split(';')[0];
  const activeV2 = await fetch(`${info.url}${info.base_path}api/screen`, { headers: { Cookie: cookie } });
  const v2Document = await activeV2.json();
  assert.equal(activeV2.status, 200);
  assert.equal(v2Document.version, 2);
  assert.equal(v2Document.workspace_kind, 'review');

  const backedOut = childProcess.spawnSync(process.execPath, [
    sessionCli,
    'backout',
    '--session-dir', info.session_dir,
  ], { encoding: 'utf8', env: environment });
  assert.equal(backedOut.status, 0, backedOut.stderr);
  const activeV1 = await fetch(`${info.url}${info.base_path}api/screen`, { headers: { Cookie: cookie } });
  assert.equal(activeV1.status, 200);
  assert.equal((await activeV1.json()).version, 1);
});

test('server rejects plaintext non-loopback binding without explicit risk acceptance', t => {
  let app;
  t.after(() => app?.close());
  assert.throws(() => {
    app = createBrainstormServer({
      sessionDir: createScratchDirectory(t, 'non-loopback'),
      host: '0.0.0.0',
      token: 'remote-secret',
    });
  }, /plaintext non-loopback/i);
});
