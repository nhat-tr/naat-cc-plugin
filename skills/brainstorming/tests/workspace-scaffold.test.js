const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createVisualScaffold } = require('../scripts/visual-document.cjs');
const { normalizeKnownWorkspaceContent } = require('../scripts/workspace-content.cjs');
const { documentRevision, normalizeWorkspaceDocument } = require('../scripts/workspace-document.cjs');
const { createScratchDirectory } = require('./test-support');

const sessionCli = path.resolve(__dirname, '../scripts/visual-session.cjs');
const workId = 'work-20260713-workspace-scaffold';
const workspaceTitles = {
  product: 'Product Concept Studio',
  architecture: 'Architecture Canvas',
  research: 'Research Evidence Board',
  business: 'Business Reasoning Canvas',
  review: 'Feature Review Workbench',
  uml: 'UML Diagram',
};

function runSession(...args) {
  return childProcess.spawnSync(process.execPath, [sessionCli, ...args], { encoding: 'utf8' });
}

function normalizeWorkspace(value) {
  return normalizeWorkspaceDocument(value, { contentValidator: normalizeKnownWorkspaceContent });
}

test('scaffold emits a deterministic, canonical Visual Document v2 for every Workspace Kind', async t => {
  const directory = createScratchDirectory(t, 'workspace-scaffold-kinds');

  for (const [workspaceKind, title] of Object.entries(workspaceTitles)) {
    await t.test(workspaceKind, () => {
      const firstFile = path.join(directory, `${workspaceKind}-first.json`);
      const secondFile = path.join(directory, `${workspaceKind}-second.json`);
      const args = [
        'scaffold',
        '--work-id', workId,
        '--workspace-kind', workspaceKind,
      ];
      const first = runSession(...args, '--output', firstFile);
      const second = runSession(...args, '--output', secondFile);

      assert.equal(first.status, 0, first.stderr);
      assert.equal(second.status, 0, second.stderr);
      const firstDocument = JSON.parse(fs.readFileSync(firstFile, 'utf8'));
      const secondDocument = JSON.parse(fs.readFileSync(secondFile, 'utf8'));

      assert.deepEqual(firstDocument, secondDocument);
      assert.deepEqual(normalizeWorkspace(firstDocument), firstDocument);
      assert.equal(firstDocument.version, 2);
      assert.equal(firstDocument.work_id, workId);
      assert.equal(firstDocument.workspace_kind, workspaceKind);
      assert.equal(firstDocument.title, title);
      assert.equal(firstDocument.revision, documentRevision(firstDocument));
      assert.match(firstDocument.revision, /^[a-f0-9]{8}$/u);
      assert.ok(firstDocument.frames.length > 0);
      assert.ok(firstDocument.components.length > 0);
      assert.deepEqual(
        firstDocument.frames.flatMap(frame => frame.component_ids).sort(),
        firstDocument.components.map(component => component.id).sort(),
      );

      assert.deepEqual(JSON.parse(first.stdout), {
        type: 'workspace.scaffolded',
        workspace_file: firstFile,
        work_id: workId,
        workspace_kind: workspaceKind,
        revision: firstDocument.revision,
      });
    });
  }
});

test('v2 scaffold requires a Work ID and a supported Workspace Kind', t => {
  const directory = createScratchDirectory(t, 'workspace-scaffold-identity');
  const missingWorkIdFile = path.join(directory, 'missing-work-id.json');
  const missingKindFile = path.join(directory, 'missing-kind.json');
  const unsupportedKindFile = path.join(directory, 'unsupported-kind.json');

  const missingWorkId = runSession(
    'scaffold', '--workspace-kind', 'product', '--output', missingWorkIdFile,
  );
  const missingKind = runSession(
    'scaffold', '--work-id', workId, '--output', missingKindFile,
  );
  const unsupportedKind = runSession(
    'scaffold', '--work-id', workId, '--workspace-kind', 'technical', '--output', unsupportedKindFile,
  );

  assert.notEqual(missingWorkId.status, 0);
  assert.match(missingWorkId.stderr, /work-id/i);
  assert.equal(fs.existsSync(missingWorkIdFile), false);
  assert.notEqual(missingKind.status, 0);
  assert.match(missingKind.stderr, /workspace-kind/i);
  assert.equal(fs.existsSync(missingKindFile), false);
  assert.notEqual(unsupportedKind.status, 0);
  assert.match(unsupportedKind.stderr, /workspace kind|workspace-kind|unsupported/i);
  assert.equal(fs.existsSync(unsupportedKindFile), false);
});

test('legacy --profile scaffold retains the canonical v1 contract', t => {
  const directory = createScratchDirectory(t, 'workspace-scaffold-legacy');
  const output = path.join(directory, 'screen.json');
  const options = {
    profile: 'technical',
    audience: 'Software developers',
    title: 'Agent request flow',
    summary: 'Framework-owned path and one application decision.',
    kinds: ['anchor', 'flow', 'decision'],
  };
  const result = runSession(
    'scaffold',
    '--profile', options.profile,
    '--audience', options.audience,
    '--title', options.title,
    '--summary', options.summary,
    '--kinds', options.kinds.join(','),
    '--output', output,
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), createVisualScaffold(options));
  assert.deepEqual(JSON.parse(result.stdout), {
    type: 'screen.scaffolded',
    screen_file: output,
    profile: 'technical',
    sections: ['anchor', 'flow', 'decision'],
  });
});

test('scaffold refuses to replace an existing output file', t => {
  const directory = createScratchDirectory(t, 'workspace-scaffold-no-overwrite');
  const workspaceOutput = path.join(directory, 'workspace.json');
  const screenOutput = path.join(directory, 'screen.json');
  const existing = '{"owned_by":"user"}\n';
  fs.writeFileSync(workspaceOutput, existing);
  fs.writeFileSync(screenOutput, existing);

  const workspaceResult = runSession(
    'scaffold',
    '--work-id', workId,
    '--workspace-kind', 'product',
    '--output', workspaceOutput,
  );
  const screenResult = runSession(
    'scaffold',
    '--profile', 'technical',
    '--output', screenOutput,
  );

  assert.notEqual(workspaceResult.status, 0);
  assert.match(workspaceResult.stderr, /exists|replace|overwrite/i);
  assert.equal(fs.readFileSync(workspaceOutput, 'utf8'), existing);
  assert.notEqual(screenResult.status, 0);
  assert.match(screenResult.stderr, /exists|replace|overwrite/i);
  assert.equal(fs.readFileSync(screenOutput, 'utf8'), existing);
});
