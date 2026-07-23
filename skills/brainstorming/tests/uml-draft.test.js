'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { compileUmlDraft } = require('../scripts/uml-draft.cjs');
const { normalizeKnownWorkspaceContent } = require('../scripts/workspace-content.cjs');
const { documentRevision, normalizeWorkspaceDocument } = require('../scripts/workspace-document.cjs');

function componentDraft() {
  return {
    kind: 'uml',
    diagram_kind: 'component',
    work_id: 'work-20260723-uml-component',
    title: 'Payment components',
    containers: [{ id: 'billing', label: 'Billing' }],
    nodes: [
      {
        id: 'payment-api',
        label: 'Payment API',
        node_kind: 'component',
        container_id: 'billing',
        points: ['Validates cards', 'Emits charge intents'],
      },
      { id: 'gateway', label: 'Gateway' },
      { id: 'payments-iface', label: 'IPayments', node_kind: 'interface' },
    ],
    edges: [
      { id: 'api-uses-gateway', label: 'charges via', source: 'payment-api', target: 'gateway' },
      { id: 'api-realizes', relation: 'realization', source: 'payment-api', target: 'payments-iface' },
    ],
  };
}

function stateMachineDraft() {
  return {
    kind: 'uml',
    diagram_kind: 'state_machine',
    work_id: 'work-20260723-uml-state',
    title: 'Order lifecycle',
    nodes: [
      { id: 'start', label: 'start', node_kind: 'initial' },
      { id: 'pending', label: 'Pending', node_kind: 'state' },
      { id: 'paid', label: 'Paid', node_kind: 'state' },
      { id: 'done', label: 'end', node_kind: 'final' },
    ],
    edges: [
      { id: 't-start', source: 'start', target: 'pending' },
      { id: 't-pay', label: 'pay / capture', source: 'pending', target: 'paid' },
      { id: 't-ship', label: 'ship', source: 'paid', target: 'done' },
    ],
  };
}

function sequenceDraft() {
  return {
    kind: 'uml',
    diagram_kind: 'sequence',
    work_id: 'work-20260723-uml-sequence',
    title: 'Login sequence',
    lifelines: [
      { id: 'user', label: 'User', lifeline_kind: 'actor' },
      { id: 'ui', label: 'Login UI', lifeline_kind: 'boundary' },
      { id: 'auth', label: 'Auth', lifeline_kind: 'control', points: ['Holds the session'] },
    ],
    messages: [
      { id: 'm-submit', label: 'submit(user, pass)', from: 'user', to: 'ui' },
      { id: 'm-auth', label: 'authenticate()', from: 'ui', to: 'auth', points: ['bcrypt compare'] },
      { id: 'm-token', label: 'token', message_kind: 'reply', from: 'auth', to: 'ui' },
    ],
    fragments: [
      { id: 'frag-first', label: 'opt [first login]', fragment_kind: 'opt', message_ids: ['m-auth', 'm-token'] },
    ],
  };
}

function normalizeWorkspace(value) {
  return normalizeWorkspaceDocument(value, { contentValidator: normalizeKnownWorkspaceContent });
}

test('compileUmlDraft derives one canonical UML Visual Document', () => {
  const draft = componentDraft();
  const original = structuredClone(draft);
  const first = compileUmlDraft(draft);
  const second = compileUmlDraft(structuredClone(draft));

  assert.deepEqual(draft, original, 'compilation must not mutate agent-authored intent');
  assert.deepEqual(first, second, 'equal Drafts must compile deterministically');
  assert.deepEqual(normalizeWorkspace(first), first);
  assert.equal(first.version, 2);
  assert.equal(first.work_id, draft.work_id);
  assert.equal(first.workspace_kind, 'uml');
  assert.equal(first.title, draft.title);
  assert.equal(first.content.diagram_kind, 'component');
  assert.equal(first.revision, documentRevision(first));
  assert.match(first.revision, /^[a-f0-9]{8}$/u);
  assert.equal(first.read_only, false);
  assert.deepEqual(first.feedback_threads, []);
});

test('compileUmlDraft materializes Components, points, and annotation targets', () => {
  const document = compileUmlDraft(componentDraft());
  const componentIds = document.components.map(component => component.id);

  // Base components: one container, three nodes, two edges.
  for (const id of ['billing', 'payment-api', 'gateway', 'payments-iface', 'api-uses-gateway', 'api-realizes']) {
    assert.ok(componentIds.includes(id), `expected component ${id}`);
  }
  // Point Components are materialized for node points.
  assert.ok(componentIds.includes('payment-api-p1'));
  assert.ok(componentIds.includes('payment-api-p2'));
  // Every component belongs to the single diagram frame.
  assert.deepEqual(document.frames.map(frame => frame.id), ['diagram']);
  assert.ok(document.frames[0].component_ids.includes('payment-api-p1'));
  // node_kind default is applied to nodes that omit it.
  const gateway = document.content.nodes.find(node => node.id === 'gateway');
  assert.equal(gateway.node_kind, 'component');
  // relation default is applied to edges that omit it.
  const usesGateway = document.content.edges.find(edge => edge.id === 'api-uses-gateway');
  assert.equal(usesGateway.relation, 'dependency');
  // annotation targets include node points.
  assert.ok(document.content.annotation_targets.includes('payment-api-p1'));
});

test('compileUmlDraft compiles state machine and activity graph diagrams', () => {
  const state = compileUmlDraft(stateMachineDraft());
  assert.equal(state.content.diagram_kind, 'state_machine');
  assert.equal(state.content.layout.direction, 'DOWN');
  assert.equal(state.content.edges.find(edge => edge.id === 't-start').relation, 'transition');

  const activity = compileUmlDraft({
    kind: 'uml',
    diagram_kind: 'activity',
    work_id: 'work-20260723-uml-activity',
    title: 'Checkout',
    containers: [{ id: 'user-lane', label: 'User' }],
    nodes: [
      { id: 'a-start', label: 'start', node_kind: 'initial' },
      { id: 'a-review', label: 'Review cart', node_kind: 'action', container_id: 'user-lane' },
      { id: 'a-valid', label: 'valid?', node_kind: 'decision' },
      { id: 'a-end', label: 'end', node_kind: 'final' },
    ],
    edges: [
      { id: 'a-f1', source: 'a-start', target: 'a-review' },
      { id: 'a-f2', source: 'a-review', target: 'a-valid' },
      { id: 'a-f3', label: '[yes]', source: 'a-valid', target: 'a-end' },
    ],
  });
  assert.equal(activity.content.diagram_kind, 'activity');
  assert.equal(activity.content.containers[0].container_kind, 'partition');
  assert.equal(activity.content.edges[0].relation, 'control_flow');
});

test('compileUmlDraft compiles a sequence diagram with lifelines, messages, and fragments', () => {
  const document = compileUmlDraft(sequenceDraft());
  assert.equal(document.content.diagram_kind, 'sequence');
  const componentIds = document.components.map(component => component.id);
  for (const id of ['user', 'ui', 'auth', 'm-submit', 'm-auth', 'm-token', 'frag-first']) {
    assert.ok(componentIds.includes(id), `expected component ${id}`);
  }
  // Points on lifelines and messages become annotatable Point Components.
  assert.ok(componentIds.includes('auth-p1'));
  assert.ok(componentIds.includes('m-auth-p1'));
  assert.equal(document.content.messages.find(message => message.id === 'm-submit').message_kind, 'sync');
});

test('compileUmlDraft rejects unknown and cross-family fields', () => {
  assert.throws(
    () => compileUmlDraft({ ...componentDraft(), bogus: true }),
    /unsupported field uml Draft.bogus/,
  );
  // Graph-only field inside a sequence Draft is rejected.
  assert.throws(
    () => compileUmlDraft({ ...sequenceDraft(), nodes: [] }),
    /unsupported field uml Draft.nodes/,
  );
  // Sequence-only field inside a graph Draft is rejected.
  assert.throws(
    () => compileUmlDraft({ ...componentDraft(), lifelines: [] }),
    /unsupported field uml Draft.lifelines/,
  );
});

test('compileUmlDraft enforces per-diagram semantics', () => {
  // Illegal relation for the diagram kind.
  assert.throws(
    () => compileUmlDraft({
      kind: 'uml',
      diagram_kind: 'state_machine',
      work_id: 'work-20260723-uml-bad',
      title: 'Bad',
      nodes: [{ id: 'a', label: 'A', node_kind: 'state' }, { id: 'b', label: 'B', node_kind: 'state' }],
      edges: [{ id: 'e', relation: 'dependency', source: 'a', target: 'b' }],
    }),
    /relation dependency is not valid for a state_machine diagram/,
  );
  // Dangling edge endpoint.
  assert.throws(
    () => compileUmlDraft({
      kind: 'uml',
      diagram_kind: 'component',
      work_id: 'work-20260723-uml-bad',
      title: 'Bad',
      nodes: [{ id: 'a', label: 'A' }],
      edges: [{ id: 'e', source: 'a', target: 'ghost' }],
    }),
    /target ghost does not resolve to a node/,
  );
  // Dangling message endpoint.
  assert.throws(
    () => compileUmlDraft({
      kind: 'uml',
      diagram_kind: 'sequence',
      work_id: 'work-20260723-uml-bad',
      title: 'Bad',
      lifelines: [{ id: 'a', label: 'A' }],
      messages: [{ id: 'm', label: 'x', from: 'a', to: 'ghost' }],
    }),
    /to ghost does not resolve to a lifeline/,
  );
  // Self message with mismatched endpoints.
  assert.throws(
    () => compileUmlDraft({
      kind: 'uml',
      diagram_kind: 'sequence',
      work_id: 'work-20260723-uml-bad',
      title: 'Bad',
      lifelines: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
      messages: [{ id: 'm', label: 'x', message_kind: 'self', from: 'a', to: 'b' }],
    }),
    /self message but from and to differ/,
  );
  // Unsupported diagram kind.
  assert.throws(
    () => compileUmlDraft({ kind: 'uml', diagram_kind: 'class', work_id: 'work-20260723-x', title: 'x' }),
    /diagram_kind must be one of/,
  );
});
