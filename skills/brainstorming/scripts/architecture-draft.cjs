'use strict';

const { normalizeKnownWorkspaceContent } = require('./workspace-content.cjs');
const { normalizeWorkspaceDocument } = require('./workspace-document.cjs');

const ARCHITECTURE_DRAFT_FIELDS = [
  'work_id',
  'title',
  'evidence',
  'boundaries',
  'nodes',
  'edges',
  'scenarios',
  'decisions',
];
const MODES = Object.freeze(['current', 'proposed']);
const CAMERA = Object.freeze({
  min_zoom: 0.2,
  max_zoom: 2,
  default_zoom: 1,
  fit_padding: 0.15,
  controls: Object.freeze(['pan', 'zoom_in', 'zoom_out', 'fit_view', 'minimap']),
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
  if (!Array.isArray(values) || values.length < 1 || values.length > 100) {
    throw new RangeError('architecture Draft.evidence must contain 1-100 Evidence References');
  }
  return values
    .map((evidence, index) => {
      const label = `architecture Draft.evidence[${index}]`;
      assertObject(evidence, label);
      rejectUnknown(evidence, ['id', 'label'], label);
      return { id: evidence.id, label: evidence.label };
    });
}

function mapBoundaries(values) {
  return requiredArray(values, 1, 100, 'architecture Draft.boundaries')
    .map((boundary, index) => {
      const label = `architecture Draft.boundaries[${index}]`;
      assertObject(boundary, label);
      rejectUnknown(boundary, ['id', 'label', 'parent_id'], label);
      return {
        id: boundary.id,
        component_id: boundary.id,
        label: boundary.label,
        parent_id: boundary.parent_id ?? null,
      };
    });
}

function inferredChange(modes) {
  if (Array.isArray(modes) && modes.length === 1) {
    if (modes[0] === 'current') return 'removed';
    if (modes[0] === 'proposed') return 'added';
  }
  return 'unchanged';
}

function mapPorts(values, nodeLabel) {
  return requiredArray(values, 1, 32, `${nodeLabel}.ports`)
    .map((port, index) => {
      const label = `${nodeLabel}.ports[${index}]`;
      assertObject(port, label);
      rejectUnknown(port, ['id', 'label', 'direction', 'kind', 'protocol'], label);
      return {
        id: port.id,
        label: port.label,
        direction: port.direction,
        kind: port.kind,
        protocol: port.protocol,
      };
    });
}

function mapNodes(values) {
  return requiredArray(values, 1, 2000, 'architecture Draft.nodes')
    .map((node, index) => {
      const label = `architecture Draft.nodes[${index}]`;
      assertObject(node, label);
      rejectUnknown(node, ['id', 'label', 'points', 'owner_id', 'type', 'ports', 'modes', 'change'], label);
      const modes = node.modes === undefined ? [...MODES] : structuredClone(node.modes);
      return {
        id: node.id,
        component_id: node.id,
        type: node.type ?? 'service',
        label: node.label,
        points: optionalArray(node.points, 6, `${label}.points`),
        owner_id: node.owner_id,
        layout_hint: { layer: index, order: 0 },
        ports: mapPorts(node.ports, label),
        modes,
        change: node.change ?? inferredChange(modes),
      };
    });
}

function endpointModes(endpoint, nodeModes) {
  return nodeModes.get(endpoint?.node_id) ?? MODES;
}

function defaultEdgeModes(edge, nodeModes) {
  const sourceModes = new Set(endpointModes(edge.source, nodeModes));
  const targetModes = new Set(endpointModes(edge.target, nodeModes));
  return MODES.filter(mode => sourceModes.has(mode) && targetModes.has(mode));
}

function mapEndpoint(value, label) {
  assertObject(value, label);
  rejectUnknown(value, ['node_id', 'port_id'], label);
  return { node_id: value.node_id, port_id: value.port_id };
}

function mapEdges(values, nodes) {
  const nodeModes = new Map(nodes.map(node => [node.id, node.modes]));
  return requiredArray(values, 1, 5000, 'architecture Draft.edges')
    .map((edge, index) => {
      const label = `architecture Draft.edges[${index}]`;
      assertObject(edge, label);
      rejectUnknown(edge, ['id', 'label', 'type', 'source', 'target', 'modes'], label);
      return {
        id: edge.id,
        component_id: edge.id,
        type: edge.type ?? 'data',
        source: mapEndpoint(edge.source, `${label}.source`),
        target: mapEndpoint(edge.target, `${label}.target`),
        modes: edge.modes === undefined
          ? defaultEdgeModes(edge, nodeModes)
          : structuredClone(edge.modes),
      };
    });
}

function mapScenarios(values) {
  return requiredArray(values, 1, 100, 'architecture Draft.scenarios')
    .map((scenario, index) => {
      const label = `architecture Draft.scenarios[${index}]`;
      assertObject(scenario, label);
      rejectUnknown(scenario, ['id', 'label', 'description', 'paths'], label);
      return {
        id: scenario.id,
        component_id: scenario.id,
        label: scenario.label,
        description: scenario.description,
        paths: structuredClone(scenario.paths),
      };
    });
}

function mapDecisions(values) {
  return optionalArray(values, 100, 'architecture Draft.decisions')
    .map((decision, decisionIndex) => {
      const label = `architecture Draft.decisions[${decisionIndex}]`;
      assertObject(decision, label);
      rejectUnknown(decision, ['id', 'title', 'multiselect', 'options'], label);
      const options = requiredArray(decision.options, 2, 5, `${label}.options`)
        .map((option, optionIndex) => {
          const optionLabel = `${label}.options[${optionIndex}]`;
          assertObject(option, optionLabel);
          rejectUnknown(option, ['id', 'label'], optionLabel);
          return { id: option.id, label: option.label };
        });
      return {
        decision: {
          id: decision.id,
          title: decision.title,
          multiselect: decision.multiselect ?? false,
          option_component_ids: options.map(option => option.id),
        },
        options,
      };
    });
}

function compileArchitectureDraft(draft) {
  assertObject(draft, 'architecture Draft');
  rejectUnknown(draft, ARCHITECTURE_DRAFT_FIELDS, 'architecture Draft');

  const evidenceRefs = mapEvidence(draft.evidence);
  const boundaries = mapBoundaries(draft.boundaries);
  const nodes = mapNodes(draft.nodes);
  const edges = mapEdges(draft.edges, nodes);
  const scenarios = mapScenarios(draft.scenarios);
  const mappedDecisions = mapDecisions(draft.decisions);
  const optionComponents = mappedDecisions.flatMap(entry => entry.options);
  const componentSources = [
    ...boundaries,
    ...nodes,
    ...draft.edges,
    ...scenarios,
    ...optionComponents,
  ];
  const components = componentSources.map(component => ({
    id: component.id,
    frame_id: 'topology',
    label: component.label,
  }));
  const annotationTargets = [
    ...boundaries.map(boundary => boundary.id),
    ...nodes.map(node => node.id),
    ...nodes.flatMap(node => node.points.map((_point, index) => `${node.id}-p${index + 1}`)),
    ...edges.map(edge => edge.id),
    ...scenarios.map(scenario => scenario.id),
  ];
  if (annotationTargets.length > 5000) {
    throw new RangeError('architecture Draft produces more than 5000 Annotation Components');
  }

  return normalizeWorkspaceDocument({
    version: 2,
    work_id: draft.work_id,
    workspace_kind: 'architecture',
    title: draft.title,
    evidence_refs: evidenceRefs,
    revision: undefined,
    frames: [{
      id: 'topology',
      title: 'Architecture topology',
      component_ids: components.map(component => component.id),
    }],
    components,
    decisions: mappedDecisions.map(entry => entry.decision),
    feedback_threads: [],
    content: {
      layout_direction: {
        id: 'exclusive-view-modes',
        comparison: 'exclusive_view_modes',
        evidence_ref: evidenceRefs[0].id,
      },
      layout: {
        contract_version: 1,
        engine: 'elk',
        algorithm: 'layered',
        direction: 'RIGHT',
        stable_across_modes: true,
      },
      initial_mode: 'proposed',
      ownership_boundaries: boundaries,
      nodes,
      edges,
      scenarios,
      camera: structuredClone(CAMERA),
      focus_targets: nodes.slice(0, 100).map(node => node.id),
      annotation_targets: annotationTargets,
    },
    read_only: false,
  }, {
    contentValidator: normalizeKnownWorkspaceContent,
  });
}

module.exports = {
  compileArchitectureDraft,
};
