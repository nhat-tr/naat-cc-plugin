'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { compileArchitectureDraft } = require('../scripts/architecture-draft.cjs');
const { normalizeKnownWorkspaceContent } = require('../scripts/workspace-content.cjs');
const { documentRevision, normalizeWorkspaceDocument } = require('../scripts/workspace-document.cjs');

function minimalDraft() {
  return {
    work_id: 'work-20260713-architecture-draft',
    title: 'Feedback delivery architecture',
    evidence: [{
      id: 'EVD-001-runtime-trace',
      label: 'Observed feedback delivery trace',
    }],
    boundaries: [{
      id: 'visual-companion',
      label: 'Visual Companion',
    }],
    nodes: [
      {
        id: 'browser-client',
        label: 'Browser client',
        owner_id: 'visual-companion',
        type: 'interface',
        ports: [{
          id: 'feedback-output',
          label: 'Feedback',
          direction: 'output',
          kind: 'event',
          protocol: 'HTTP',
        }],
      },
      {
        id: 'agent-session',
        label: 'Agent Session',
        owner_id: 'visual-companion',
        type: 'service',
        ports: [{
          id: 'feedback-input',
          label: 'Feedback',
          direction: 'input',
          kind: 'event',
          protocol: 'HTTP',
        }],
      },
    ],
    edges: [{
      id: 'feedback-delivery',
      label: 'Feedback delivery',
      type: 'event',
      source: { node_id: 'browser-client', port_id: 'feedback-output' },
      target: { node_id: 'agent-session', port_id: 'feedback-input' },
    }],
    scenarios: [{
      id: 'submit-feedback',
      label: 'Submit feedback',
      description: 'Deliver browser feedback to the same Agent Session.',
      paths: {
        current: {
          node_ids: ['browser-client', 'agent-session'],
          edge_ids: ['feedback-delivery'],
        },
        proposed: {
          node_ids: ['browser-client', 'agent-session'],
          edge_ids: ['feedback-delivery'],
        },
      },
    }],
    decisions: [{
      id: 'feedback-receiver',
      title: 'Choose the feedback receiver',
      options: [
        { id: 'foreground-wait', label: 'Foreground Wait' },
        { id: 'background-poll', label: 'Background polling' },
      ],
    }],
  };
}

function normalizeWorkspace(value) {
  return normalizeWorkspaceDocument(value, { contentValidator: normalizeKnownWorkspaceContent });
}

test('compileArchitectureDraft derives one canonical Architecture Canvas Visual Document', () => {
  const draft = minimalDraft();
  const original = structuredClone(draft);
  const first = compileArchitectureDraft(draft);
  const second = compileArchitectureDraft(structuredClone(draft));

  assert.deepEqual(draft, original, 'compilation must not mutate agent-authored intent');
  assert.deepEqual(first, second, 'equal Drafts must compile deterministically');
  assert.deepEqual(normalizeWorkspace(first), first);
  assert.equal(first.version, 2);
  assert.equal(first.work_id, draft.work_id);
  assert.equal(first.workspace_kind, 'architecture');
  assert.equal(first.title, draft.title);
  assert.deepEqual(first.evidence_refs, draft.evidence);
  assert.equal(first.revision, documentRevision(first));
  assert.match(first.revision, /^[a-f0-9]{8}$/u);
  assert.equal(first.read_only, false);
  assert.deepEqual(first.feedback_threads, []);
});

test('compileArchitectureDraft derives Components, frame membership, defaults, and Decision Options', () => {
  const document = compileArchitectureDraft(minimalDraft());
  const componentIds = [
    'visual-companion',
    'browser-client',
    'agent-session',
    'feedback-delivery',
    'submit-feedback',
    'foreground-wait',
    'background-poll',
  ];

  assert.deepEqual(document.frames, [{
    id: 'topology',
    title: 'Architecture topology',
    component_ids: componentIds,
  }]);
  assert.deepEqual(document.components.map(component => component.id), componentIds);
  assert.ok(document.components.every(component => component.frame_id === 'topology'));
  assert.deepEqual(document.decisions, [{
    id: 'feedback-receiver',
    title: 'Choose the feedback receiver',
    multiselect: false,
    option_component_ids: ['foreground-wait', 'background-poll'],
  }]);

  assert.deepEqual(document.content.layout_direction, {
    id: 'exclusive-view-modes',
    comparison: 'exclusive_view_modes',
    evidence_ref: 'EVD-001-runtime-trace',
  });
  assert.deepEqual(document.content.layout, {
    contract_version: 1,
    engine: 'elk',
    algorithm: 'layered',
    direction: 'RIGHT',
    stable_across_modes: true,
  });
  assert.equal(document.content.initial_mode, 'proposed');
  assert.deepEqual(document.content.camera, {
    min_zoom: 0.2,
    max_zoom: 2,
    default_zoom: 1,
    fit_padding: 0.15,
    controls: ['pan', 'zoom_in', 'zoom_out', 'fit_view', 'minimap'],
  });
  assert.deepEqual(document.content.focus_targets, ['browser-client', 'agent-session']);
  assert.deepEqual(document.content.annotation_targets, [
    'visual-companion',
    'browser-client',
    'agent-session',
    'feedback-delivery',
    'submit-feedback',
  ]);
});

test('compileArchitectureDraft derives mirrors and topology defaults without model-authored envelope fields', () => {
  const document = compileArchitectureDraft(minimalDraft());

  assert.deepEqual(document.content.ownership_boundaries, [{
    id: 'visual-companion',
    component_id: 'visual-companion',
    label: 'Visual Companion',
    parent_id: null,
  }]);
  assert.deepEqual(document.content.nodes.map(node => ({
    id: node.id,
    component_id: node.component_id,
    layout_hint: node.layout_hint,
    modes: node.modes,
    change: node.change,
  })), [
    {
      id: 'browser-client',
      component_id: 'browser-client',
      layout_hint: { layer: 0, order: 0 },
      modes: ['current', 'proposed'],
      change: 'unchanged',
    },
    {
      id: 'agent-session',
      component_id: 'agent-session',
      layout_hint: { layer: 1, order: 0 },
      modes: ['current', 'proposed'],
      change: 'unchanged',
    },
  ]);
  assert.deepEqual(document.content.edges[0], {
    id: 'feedback-delivery',
    component_id: 'feedback-delivery',
    type: 'event',
    source: { node_id: 'browser-client', port_id: 'feedback-output' },
    target: { node_id: 'agent-session', port_id: 'feedback-input' },
    modes: ['current', 'proposed'],
  });
  assert.equal(document.content.scenarios[0].component_id, 'submit-feedback');
});

test('compileArchitectureDraft delegates invalid topology rejection to canonical normalizers', () => {
  const invalid = minimalDraft();
  invalid.edges[0].target.node_id = 'missing-agent-session';

  assert.throws(
    () => compileArchitectureDraft(invalid),
    /edge feedback-delivery target node missing-agent-session does not resolve/i,
  );
});

test('compileArchitectureDraft rejects envelope protocol fields, missing evidence, and one-option Decisions', () => {
  const withRevision = { ...minimalDraft(), revision: '00000000' };
  const withoutEvidence = { ...minimalDraft(), evidence: [] };
  const oneOptionDecision = minimalDraft();
  oneOptionDecision.decisions[0].options.pop();

  assert.throws(
    () => compileArchitectureDraft(withRevision),
    /unsupported field architecture Draft\.revision/i,
  );
  assert.throws(
    () => compileArchitectureDraft(withoutEvidence),
    /architecture Draft\.evidence must contain 1-100 Evidence References/i,
  );
  assert.throws(
    () => compileArchitectureDraft(oneOptionDecision),
    /architecture Draft\.decisions\[0\]\.options must contain 2-5 items/i,
  );
});
