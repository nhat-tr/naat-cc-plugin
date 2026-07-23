'use strict';

const { normalizeKnownWorkspaceContent } = require('./workspace-content.cjs');
const { normalizeWorkspaceDocument } = require('./workspace-document.cjs');

// Compact UML Draft compiler. Mirrors architecture-draft.cjs: an intent-owned,
// allow-listed Draft is expanded into a full v2 Workspace Document. The Draft is
// discriminated by `diagram_kind` into two families that render very differently:
//   - graph family (component | state_machine | activity): laid out by ELK.
//   - sequence family: a bespoke temporal layout (lifelines + ordered messages).
// The `kind` field is the self-describing draft discriminator read by the CLI
// dispatch (visual-session.cjs); it is accepted and ignored here.

const COMMON_DRAFT_FIELDS = ['kind', 'diagram_kind', 'work_id', 'title', 'evidence'];
const GRAPH_DRAFT_FIELDS = [...COMMON_DRAFT_FIELDS, 'containers', 'nodes', 'edges', 'direction'];
const SEQUENCE_DRAFT_FIELDS = [...COMMON_DRAFT_FIELDS, 'lifelines', 'messages', 'fragments'];
const GRAPH_DIAGRAM_KINDS = new Set(['component', 'state_machine', 'activity']);
const MAX_ANNOTATION_TARGETS = 2000;

const CAMERA = Object.freeze({
  min_zoom: 0.2,
  max_zoom: 2,
  default_zoom: 1,
  fit_padding: 0.15,
  controls: Object.freeze(['pan', 'zoom_in', 'zoom_out', 'fit_view', 'minimap']),
});

const DEFAULT_NODE_KIND = Object.freeze({
  component: 'component',
  state_machine: 'state',
  activity: 'action',
});
const DEFAULT_RELATION = Object.freeze({
  component: 'dependency',
  state_machine: 'transition',
  activity: 'control_flow',
});
const DEFAULT_CONTAINER_KIND = Object.freeze({
  component: 'package',
  state_machine: 'composite_state',
  activity: 'partition',
});
const DEFAULT_DIRECTION = Object.freeze({
  component: 'RIGHT',
  state_machine: 'DOWN',
  activity: 'DOWN',
});

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function rejectUnknown(value, allowed, label) {
  const unknown = Object.keys(value).find(key => !allowed.includes(key));
  if (unknown !== undefined) throw new TypeError(`unsupported field ${label}.${unknown}`);
}

function requiredArray(value, minimum, maximum, label) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new RangeError(`${label} must contain ${minimum}-${maximum} items`);
  }
  return value;
}

function optionalArray(value, maximum, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximum) {
    throw new RangeError(`${label} must contain 0-${maximum} items`);
  }
  return value;
}

function mapEvidence(values) {
  if (values === undefined) return [];
  return optionalArray(values, 100, 'uml Draft.evidence')
    .map((evidence, index) => {
      const label = `uml Draft.evidence[${index}]`;
      assertObject(evidence, label);
      rejectUnknown(evidence, ['id', 'label'], label);
      return { id: evidence.id, label: evidence.label };
    });
}

function mapContainers(values, diagramKind) {
  return optionalArray(values, 200, 'uml Draft.containers')
    .map((container, index) => {
      const label = `uml Draft.containers[${index}]`;
      assertObject(container, label);
      rejectUnknown(container, ['id', 'label', 'container_kind', 'parent_id'], label);
      return {
        id: container.id,
        component_id: container.id,
        label: container.label,
        container_kind: container.container_kind ?? DEFAULT_CONTAINER_KIND[diagramKind],
        parent_id: container.parent_id ?? null,
      };
    });
}

function mapGraphNodes(values, diagramKind) {
  return requiredArray(values, 1, 2000, 'uml Draft.nodes')
    .map((node, index) => {
      const label = `uml Draft.nodes[${index}]`;
      assertObject(node, label);
      rejectUnknown(node, ['id', 'label', 'node_kind', 'container_id', 'points'], label);
      return {
        id: node.id,
        component_id: node.id,
        label: node.label,
        node_kind: node.node_kind ?? DEFAULT_NODE_KIND[diagramKind],
        container_id: node.container_id ?? null,
        points: optionalArray(node.points, 6, `${label}.points`),
        layout_hint: { layer: index, order: 0 },
      };
    });
}

function mapGraphEdges(values, diagramKind) {
  return optionalArray(values, 5000, 'uml Draft.edges')
    .map((edge, index) => {
      const label = `uml Draft.edges[${index}]`;
      assertObject(edge, label);
      rejectUnknown(edge, ['id', 'label', 'relation', 'source', 'target'], label);
      const mapped = {
        id: edge.id,
        component_id: edge.id,
        relation: edge.relation ?? DEFAULT_RELATION[diagramKind],
        source: edge.source,
        target: edge.target,
      };
      if (edge.label !== undefined) mapped.label = edge.label;
      return mapped;
    });
}

function mapLifelines(values) {
  return requiredArray(values, 1, 100, 'uml Draft.lifelines')
    .map((lifeline, index) => {
      const label = `uml Draft.lifelines[${index}]`;
      assertObject(lifeline, label);
      rejectUnknown(lifeline, ['id', 'label', 'lifeline_kind', 'points'], label);
      return {
        id: lifeline.id,
        component_id: lifeline.id,
        label: lifeline.label,
        lifeline_kind: lifeline.lifeline_kind ?? 'participant',
        points: optionalArray(lifeline.points, 6, `${label}.points`),
      };
    });
}

function mapMessages(values) {
  return optionalArray(values, 1000, 'uml Draft.messages')
    .map((message, index) => {
      const label = `uml Draft.messages[${index}]`;
      assertObject(message, label);
      rejectUnknown(message, ['id', 'label', 'message_kind', 'from', 'to', 'points'], label);
      return {
        id: message.id,
        component_id: message.id,
        label: message.label,
        message_kind: message.message_kind ?? 'sync',
        from: message.from,
        to: message.to,
        points: optionalArray(message.points, 6, `${label}.points`),
      };
    });
}

function mapFragments(values) {
  return optionalArray(values, 200, 'uml Draft.fragments')
    .map((fragment, index) => {
      const label = `uml Draft.fragments[${index}]`;
      assertObject(fragment, label);
      rejectUnknown(fragment, ['id', 'label', 'fragment_kind', 'message_ids'], label);
      return {
        id: fragment.id,
        component_id: fragment.id,
        label: fragment.label,
        fragment_kind: fragment.fragment_kind,
        message_ids: requiredArray(fragment.message_ids, 1, 1000, `${label}.message_ids`).map(String),
      };
    });
}

function assertAnnotationBudget(annotationTargets) {
  if (annotationTargets.length > MAX_ANNOTATION_TARGETS) {
    throw new RangeError(`uml Draft produces more than ${MAX_ANNOTATION_TARGETS} Annotation Components`);
  }
}

function toComponents(sources) {
  return sources.map(source => ({
    id: source.component_id,
    frame_id: 'diagram',
    label: source.label ?? source.id,
  }));
}

function pointTargets(owners) {
  return owners.flatMap(owner => (owner.points ?? [])
    .map((_point, index) => `${owner.component_id}-p${index + 1}`));
}

function finalizeDocument(draft, evidenceRefs, components, content) {
  return normalizeWorkspaceDocument({
    version: 2,
    work_id: draft.work_id,
    workspace_kind: 'uml',
    title: draft.title,
    evidence_refs: evidenceRefs,
    revision: undefined,
    frames: [{
      id: 'diagram',
      title: draft.title,
      component_ids: components.map(component => component.id),
    }],
    components,
    decisions: [],
    feedback_threads: [],
    content,
    read_only: false,
  }, {
    contentValidator: normalizeKnownWorkspaceContent,
  });
}

function compileGraphDraft(draft) {
  rejectUnknown(draft, GRAPH_DRAFT_FIELDS, 'uml Draft');
  const diagramKind = draft.diagram_kind;
  const evidenceRefs = mapEvidence(draft.evidence);
  const containers = mapContainers(draft.containers, diagramKind);
  const nodes = mapGraphNodes(draft.nodes, diagramKind);
  const edges = mapGraphEdges(draft.edges, diagramKind);

  const annotationTargets = [
    ...containers.map(container => container.id),
    ...nodes.map(node => node.id),
    ...pointTargets(nodes),
    ...edges.map(edge => edge.id),
  ];
  assertAnnotationBudget(annotationTargets);

  const components = toComponents([...containers, ...nodes, ...edges]);
  const content = {
    diagram_kind: diagramKind,
    layout: {
      contract_version: 1,
      engine: 'elk',
      algorithm: 'layered',
      direction: draft.direction ?? DEFAULT_DIRECTION[diagramKind],
    },
    containers,
    nodes,
    edges,
    camera: structuredClone(CAMERA),
    focus_targets: nodes.slice(0, 100).map(node => node.id),
    annotation_targets: annotationTargets,
  };
  return finalizeDocument(draft, evidenceRefs, components, content);
}

function compileSequenceDraft(draft) {
  rejectUnknown(draft, SEQUENCE_DRAFT_FIELDS, 'uml Draft');
  const evidenceRefs = mapEvidence(draft.evidence);
  const lifelines = mapLifelines(draft.lifelines);
  const messages = mapMessages(draft.messages);
  const fragments = mapFragments(draft.fragments);

  const annotationTargets = [
    ...lifelines.map(lifeline => lifeline.id),
    ...pointTargets(lifelines),
    ...messages.map(message => message.id),
    ...pointTargets(messages),
    ...fragments.map(fragment => fragment.id),
  ];
  assertAnnotationBudget(annotationTargets);

  const components = toComponents([...lifelines, ...messages, ...fragments]);
  const content = {
    diagram_kind: 'sequence',
    lifelines,
    messages,
    fragments,
    annotation_targets: annotationTargets,
  };
  return finalizeDocument(draft, evidenceRefs, components, content);
}

function compileUmlDraft(draft) {
  assertObject(draft, 'uml Draft');
  const diagramKind = draft.diagram_kind;
  if (GRAPH_DIAGRAM_KINDS.has(diagramKind)) return compileGraphDraft(draft);
  if (diagramKind === 'sequence') return compileSequenceDraft(draft);
  throw new TypeError(
    `uml Draft.diagram_kind must be one of component, state_machine, activity, sequence`,
  );
}

module.exports = {
  compileUmlDraft,
};
