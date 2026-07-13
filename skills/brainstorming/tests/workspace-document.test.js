const assert = require('node:assert/strict');
const test = require('node:test');

const { renderStandalone } = require('../scripts/standalone.cjs');

let workspaceDocument = {};
try {
  workspaceDocument = require('../scripts/workspace-document.cjs');
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
}

function contractValue(name, type) {
  assert.equal(
    typeof workspaceDocument[name],
    type,
    `workspace-document.cjs must export ${name}`,
  );
  return workspaceDocument[name];
}

function expectedDocumentRevision(value) {
  const semantic = structuredClone(value);
  delete semantic.revision;
  const json = JSON.stringify(semantic);
  let hash = 0x811c9dc5;
  for (let index = 0; index < json.length; index += 1) {
    hash ^= json.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function workspaceFixture(overrides = {}) {
  const document = {
    version: 2,
    work_id: 'work-20260712-visual-companion-vnext',
    workspace_kind: 'product',
    title: 'Payment confirmation concepts',
    evidence_refs: [{ id: 'EVD-001-design-direction-approval', label: 'Approved design direction' }],
    revision: undefined,
    frames: [{ id: 'comparison', title: 'Concept comparison', component_ids: ['concept-a'] }],
    components: [{ id: 'concept-a', frame_id: 'comparison', label: 'Concept A' }],
    decisions: [],
    feedback_threads: [],
    content: { concepts: [{ id: 'concept-a', label: 'Device-aware triptych' }] },
    read_only: false,
    ...overrides,
  };
  if (!Object.hasOwn(overrides, 'revision')) document.revision = expectedDocumentRevision(document);
  return document;
}

function productContentValidator(value, context) {
  assert.equal(context.workspace_kind, 'product');
  assert.ok(Array.isArray(value.concepts));
  return {
    concepts: value.concepts.map(concept => ({
      id: String(concept.id).trim(),
      label: String(concept.label).trim(),
    })),
  };
}

test('Visual Document v2 exposes one stable lowercase Workspace Kind discriminator set', () => {
  const workspaceKinds = contractValue('WORKSPACE_KINDS', 'object');

  assert.deepEqual([...workspaceKinds], [
    'product',
    'architecture',
    'research',
    'business',
    'review',
  ]);

  const normalizeWorkspaceDocument = contractValue('normalizeWorkspaceDocument', 'function');
  for (const workspaceKind of workspaceKinds) {
    const normalized = normalizeWorkspaceDocument(workspaceFixture({ workspace_kind: workspaceKind }), {
      contentValidator: content => structuredClone(content),
    });
    assert.equal(normalized.workspace_kind, workspaceKind);
  }

  for (const alias of ['Product', 'technical', 'mockup', 'product-concept-studio']) {
    assert.throws(
      () => normalizeWorkspaceDocument(workspaceFixture({ workspace_kind: alias }), {
        contentValidator: content => content,
      }),
      /workspace kind|workspace_kind|unsupported/i,
    );
  }
});

test('the shared v2 envelope normalizes purpose-neutral state and is canonical on a second pass', () => {
  const normalizeWorkspaceDocument = contractValue('normalizeWorkspaceDocument', 'function');
  const input = workspaceFixture({
    title: '  Payment confirmation concepts  ',
    content: { concepts: [{ id: ' concept-a ', label: ' Device-aware triptych ' }] },
    revision: undefined,
  });

  const first = normalizeWorkspaceDocument(input, { contentValidator: productContentValidator });
  const second = normalizeWorkspaceDocument(first, { contentValidator: productContentValidator });

  assert.equal(first.version, 2);
  assert.equal(first.work_id, 'work-20260712-visual-companion-vnext');
  assert.equal(first.title, 'Payment confirmation concepts');
  assert.equal(first.revision, expectedDocumentRevision(first));
  assert.deepEqual(first.evidence_refs, [{
    id: 'EVD-001-design-direction-approval',
    label: 'Approved design direction',
  }]);
  assert.deepEqual(first.frames, [{
    id: 'comparison',
    title: 'Concept comparison',
    component_ids: ['concept-a'],
  }]);
  assert.deepEqual(first.components, [{
    id: 'concept-a',
    frame_id: 'comparison',
    label: 'Concept A',
  }]);
  assert.deepEqual(first.content, {
    concepts: [{ id: 'concept-a', label: 'Device-aware triptych' }],
  });
  assert.deepEqual(first.decisions, []);
  assert.deepEqual(first.feedback_threads, []);
  assert.equal(first.read_only, false);
  assert.deepEqual(second, first);
});

test('content validation is injected, called exactly once, and owns only Workspace Kind content', () => {
  const normalizeWorkspaceDocument = contractValue('normalizeWorkspaceDocument', 'function');
  const calls = [];
  const normalized = normalizeWorkspaceDocument(workspaceFixture({ revision: undefined }), {
    contentValidator(content, context) {
      calls.push({ content: structuredClone(content), context: structuredClone(context) });
      return { concepts: content.concepts, normalized_by: 'product-validator' };
    },
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].content, workspaceFixture().content);
  assert.equal(calls[0].context.workspace_kind, 'product');
  assert.equal(normalized.content.normalized_by, 'product-validator');
  assert.equal(normalized.revision, expectedDocumentRevision(normalized));

  assert.throws(
    () => normalizeWorkspaceDocument(workspaceFixture(), {}),
    /content validator.*required|contentValidator.*required/i,
  );
  assert.throws(
    () => normalizeWorkspaceDocument(workspaceFixture(), { contentValidator: () => undefined }),
    /content validator.*object|normalized content.*object/i,
  );
});

test('shared Decisions preserve Option Component identities while Choices stay in Feedback Batches', () => {
  const normalizeWorkspaceDocument = contractValue('normalizeWorkspaceDocument', 'function');
  const document = workspaceFixture({
    frames: [{
      id: 'comparison',
      title: 'Concept comparison',
      component_ids: ['concept-a', 'concept-b'],
    }],
    components: [
      { id: 'concept-a', frame_id: 'comparison', label: 'Concept A' },
      { id: 'concept-b', frame_id: 'comparison', label: 'Concept B' },
    ],
    decisions: [{
      id: 'concept-choice',
      title: 'Choose one concept',
      multiselect: false,
      option_component_ids: ['concept-a', 'concept-b'],
    }],
    content: {
      concepts: [
        { id: 'concept-a', label: 'Device-aware triptych' },
        { id: 'concept-b', label: 'Dense command center' },
      ],
    },
  });

  const normalized = normalizeWorkspaceDocument(document, {
    contentValidator: content => structuredClone(content),
  });
  assert.deepEqual(normalized.decisions, document.decisions);

  for (const decisions of [
    [{ ...document.decisions[0], option_component_ids: ['concept-a', 'missing-option'] }],
    [document.decisions[0], { ...document.decisions[0], title: 'Duplicate identity' }],
  ]) {
    assert.throws(
      () => normalizeWorkspaceDocument(workspaceFixture({
        ...document,
        decisions,
        revision: undefined,
      }), { contentValidator: content => structuredClone(content) }),
      /decision|choice|option|duplicate|component/i,
    );
  }
});

test('the shared envelope rejects malformed Revision, dangling Component identities, and host-owned fields', () => {
  const normalizeWorkspaceDocument = contractValue('normalizeWorkspaceDocument', 'function');
  const normalize = value => normalizeWorkspaceDocument(value, {
    contentValidator: content => structuredClone(content),
  });

  assert.throws(() => normalize(workspaceFixture({ revision: 'rev-a1b2c3d4' })), /revision.*8|revision.*hex/i);
  assert.throws(() => normalize(workspaceFixture({ revision: 'A1B2C3D4' })), /revision.*hex|revision.*lowercase/i);
  assert.throws(() => normalize(workspaceFixture({ revision: 'deadbeef' })), /revision.*match|revision.*derived|revision.*content/i);
  assert.throws(() => normalize(workspaceFixture({
    frames: [{ id: 'comparison', title: 'Concept comparison', component_ids: ['missing-component'] }],
  })), /missing-component|component.*frame|unknown component/i);
  assert.throws(() => normalize(workspaceFixture({
    components: [
      { id: 'concept-a', frame_id: 'comparison', label: 'Concept A' },
      { id: 'concept-a', frame_id: 'comparison', label: 'Duplicate Concept A' },
    ],
  })), /duplicate.*component|component.*concept-a/i);
  assert.throws(() => normalize(workspaceFixture({
    frames: [
      { id: 'comparison', title: 'Concept comparison', component_ids: ['concept-a'] },
      { id: 'comparison', title: 'Duplicate frame', component_ids: [] },
    ],
  })), /duplicate.*frame|frame.*comparison/i);
  assert.throws(() => normalize(workspaceFixture({
    frames: [{ id: 'comparison', title: 'Concept comparison', component_ids: ['concept-a', 'concept-a'] }],
  })), /duplicate.*component|component.*concept-a/i);
  assert.throws(() => normalize(workspaceFixture({
    components: [{ id: 'concept-a', frame_id: 'missing-frame', label: 'Concept A' }],
  })), /missing-frame|unknown frame|component.*frame/i);
  assert.throws(() => normalize(workspaceFixture({
    frames: [{ id: 'comparison', title: 'Concept comparison', component_ids: [] }],
  })), /concept-a|component.*listed|frame.*component/i);
  assert.throws(() => normalize(workspaceFixture({
    profile: 'product',
  })), /unsupported field.*profile/i);
  assert.throws(() => normalize(workspaceFixture({
    style: 'body { display: none }',
  })), /unsupported field.*style/i);
});

test('documentRevision preserves the v1 FNV-1a contract while excluding its top-level Revision field', () => {
  const documentRevision = contractValue('documentRevision', 'function');
  const normalizeWorkspaceDocument = contractValue('normalizeWorkspaceDocument', 'function');
  const withoutRevision = workspaceFixture({ revision: undefined });
  const normalized = normalizeWorkspaceDocument(withoutRevision, {
    contentValidator: content => structuredClone(content),
  });

  assert.match(normalized.revision, /^[a-f0-9]{8}$/);
  assert.equal(normalized.revision, expectedDocumentRevision(normalized));
  assert.equal(documentRevision(normalized), normalized.revision);
  assert.equal(documentRevision({ ...normalized, revision: 'ffffffff' }), normalized.revision);

  const changed = structuredClone(normalized);
  changed.title = 'Payment confirmation concepts, revised';
  assert.notEqual(documentRevision(changed), normalized.revision);
});

test('standalone state preserves Workspace Kind, evidence, Decision Choice, feedback history, and read-only Revision', () => {
  const screen = workspaceFixture({
    decisions: [{
      id: 'concept-choice',
      title: 'Choose one concept',
      multiselect: false,
      option_component_ids: ['concept-a'],
    }],
    read_only: true,
  });
  const session = {
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
      message: 'Keep this Choice.',
      annotations: [],
      choices: [{
        groupId: 'concept-choice',
        componentId: 'concept-a',
        value: 'concept-a',
        label: 'Concept A',
      }],
      screen: { id: 'screen', file: 'screen.json', revision: screen.revision },
    }],
  };
  const html = renderStandalone({
    shell: '<link rel="stylesheet" href="assets/styles.css"><script src="assets/app.js"></script>',
    styles: 'body {}',
    script: 'void 0;',
    screen,
    session,
  });

  assert.match(html, /"workspace_kind":"product"/u);
  assert.match(html, /EVD-001-design-direction-approval/u);
  assert.match(html, /"id":"concept-choice"/u);
  assert.match(html, /"choices":\[\{"groupId":"concept-choice","componentId":"concept-a"/u);
  assert.match(html, /"clientTurnId":"standalone-choice-1"/u);
  assert.match(html, new RegExp(`"revision":"${screen.revision}"`, 'u'));
  assert.match(html, /"readOnly":true/u);
  assert.doesNotMatch(html, /capability_token|brainstorm_session=/iu);
});
