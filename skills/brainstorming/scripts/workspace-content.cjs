'use strict';

const fs = require('node:fs');
const path = require('node:path');

const Ajv2020 = require('ajv/dist/2020').default;

const { normalizeOpaqueWorkspaceContent } = require('./workspace-document.cjs');

const SCHEMA_DIR = path.resolve(__dirname, '../schemas');
const validators = new Map();

function semanticError(message) {
  throw new TypeError(`architecture Workspace content is invalid: ${message}`);
}

function uniqueById(values, label) {
  const result = new Map();
  for (const value of values) {
    if (result.has(value.id)) semanticError(`${label} id ${value.id} is duplicated`);
    result.set(value.id, value);
  }
  return result;
}

function validateArchitectureSemantics(content, context) {
  const boundaries = uniqueById(content.ownership_boundaries, 'ownership boundary');
  const nodes = uniqueById(content.nodes, 'node');
  const edges = uniqueById(content.edges, 'edge');
  uniqueById(content.scenarios, 'scenario');
  const activeEdgeRelationships = new Map();
  const architectureComponents = new Map();
  const topologyIdentities = new Map();
  const decisionOptionComponents = new Set(context.decision_option_component_ids ?? []);

  for (const [label, values] of [
    ['ownership boundary', content.ownership_boundaries],
    ['node', content.nodes],
    ['edge', content.edges],
    ['scenario', content.scenarios],
  ]) {
    for (const value of values) {
      const existingIdentity = topologyIdentities.get(value.id);
      if (existingIdentity) {
        semanticError(
          `topology id ${value.id} is duplicated across ${existingIdentity} and ${label} collections`,
        );
      }
      topologyIdentities.set(value.id, label);
      const existing = architectureComponents.get(value.component_id);
      if (existing) {
        semanticError(
          `Architecture Component ${value.component_id} is duplicated by ${existing.label} ${existing.id} and ${label} ${value.id}`,
        );
      }
      architectureComponents.set(value.component_id, { id: value.id, label });
      if (label === 'node') {
        for (let index = 0; index < (value.points ?? []).length; index += 1) {
          const pointId = `${value.component_id}-p${index + 1}`;
          if (architectureComponents.has(pointId)) {
            semanticError(`Architecture Point Component ${pointId} is duplicated`);
          }
          architectureComponents.set(pointId, { id: pointId, label: 'point' });
        }
      }
    }
  }

  if (Array.isArray(context.component_ids)) {
    const envelopeComponents = new Set(context.component_ids);
    for (const componentId of architectureComponents.keys()) {
      if (!envelopeComponents.has(componentId)) {
        semanticError(`Architecture Component ${componentId} is missing from envelope Components`);
      }
    }
    for (const componentId of envelopeComponents) {
      if (!architectureComponents.has(componentId) && !decisionOptionComponents.has(componentId)) {
        semanticError(
          `envelope Component ${componentId} has no Architecture content or Decision Option Component`,
        );
      }
    }
  }

  for (const boundary of content.ownership_boundaries) {
    if (boundary.parent_id !== null && !boundaries.has(boundary.parent_id)) {
      semanticError(`ownership boundary ${boundary.id} parent ${boundary.parent_id} does not resolve`);
    }
  }
  for (const boundary of content.ownership_boundaries) {
    const chain = new Set();
    let current = boundary;
    while (current) {
      if (chain.has(current.id)) {
        semanticError(`ownership boundary parent cycle includes ${current.id}`);
      }
      chain.add(current.id);
      current = current.parent_id === null ? null : boundaries.get(current.parent_id);
    }
  }

  for (const node of content.nodes) {
    if (!boundaries.has(node.owner_id)) {
      semanticError(`node ${node.id} owner ${node.owner_id} does not resolve`);
    }
    uniqueById(node.ports, `node ${node.id} port`);
  }

  for (const targetId of content.focus_targets) {
    if (!nodes.has(targetId) && !boundaries.has(targetId)) {
      semanticError(`focus target ${targetId} must resolve to a node or ownership boundary`);
    }
  }
  for (const targetId of content.annotation_targets) {
    if (!architectureComponents.has(targetId) && !decisionOptionComponents.has(targetId)) {
      semanticError(`annotation target ${targetId} must resolve to an Architecture Component`);
    }
  }

  for (const edge of content.edges) {
    const source = nodes.get(edge.source.node_id);
    const target = nodes.get(edge.target.node_id);
    if (!source) semanticError(`edge ${edge.id} source node ${edge.source.node_id} does not resolve`);
    if (!target) semanticError(`edge ${edge.id} target node ${edge.target.node_id} does not resolve`);
    const sourcePort = source.ports.find(port => port.id === edge.source.port_id);
    const targetPort = target.ports.find(port => port.id === edge.target.port_id);
    if (!sourcePort || sourcePort.direction !== 'output') {
      semanticError(`edge ${edge.id} source port ${edge.source.port_id} must resolve to an output`);
    }
    if (!targetPort || targetPort.direction !== 'input') {
      semanticError(`edge ${edge.id} target port ${edge.target.port_id} must resolve to an input`);
    }
    for (const mode of edge.modes) {
      if (!source.modes.includes(mode) || !target.modes.includes(mode)) {
        semanticError(`edge ${edge.id} mode ${mode} must be supported by both endpoint nodes`);
      }
    }

    const relationshipKey = JSON.stringify([
      edge.type,
      edge.source.node_id,
      edge.source.port_id,
      edge.target.node_id,
      edge.target.port_id,
    ]);
    const activeModes = activeEdgeRelationships.get(relationshipKey) ?? new Map();
    for (const mode of edge.modes) {
      const existingEdgeId = activeModes.get(mode);
      if (existingEdgeId) {
        semanticError(
          `duplicate edge relationship ${existingEdgeId} and ${edge.id} overlap in active mode ${mode}`,
        );
      }
      activeModes.set(mode, edge.id);
    }
    activeEdgeRelationships.set(relationshipKey, activeModes);
  }

  for (const scenario of content.scenarios) {
    for (const mode of ['current', 'proposed']) {
      const scenarioPath = scenario.paths[mode];
      const pathError = () => semanticError(
        `scenario ${scenario.id} ${mode} path must be an ordered contiguous directed walk`,
      );
      if (scenarioPath.node_ids.length !== scenarioPath.edge_ids.length + 1) pathError();
      const pathNodes = scenarioPath.node_ids.map(id => nodes.get(id));
      const pathEdges = scenarioPath.edge_ids.map(id => edges.get(id));
      if (pathNodes.some(node => !node) || pathEdges.some(edge => !edge)) pathError();
      if (pathNodes.some(node => !node.modes.includes(mode))
        || pathEdges.some(edge => !edge.modes.includes(mode))) pathError();
      for (let index = 0; index < pathEdges.length; index += 1) {
        const edge = pathEdges[index];
        if (edge.source.node_id !== scenarioPath.node_ids[index]
          || edge.target.node_id !== scenarioPath.node_ids[index + 1]) pathError();
      }
    }
  }
}

function validatorFor(workspaceKind) {
  if (validators.has(workspaceKind)) return validators.get(workspaceKind);
  const schemaFile = path.join(SCHEMA_DIR, `${workspaceKind}-workspace.schema.json`);
  if (!fs.existsSync(schemaFile)) {
    validators.set(workspaceKind, null);
    return null;
  }
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(JSON.parse(fs.readFileSync(schemaFile, 'utf8')));
  const entry = { ajv, validate };
  validators.set(workspaceKind, entry);
  return entry;
}

function normalizeKnownWorkspaceContent(content, context) {
  const normalized = normalizeOpaqueWorkspaceContent(content);
  const entry = validatorFor(context.workspace_kind);
  if (!entry) return normalized;
  if (!entry.validate(normalized)) {
    throw new TypeError(`${context.workspace_kind} Workspace content is invalid: ${entry.ajv.errorsText(entry.validate.errors)}`);
  }
  if (context.workspace_kind === 'architecture') validateArchitectureSemantics(normalized, context);
  return normalized;
}

module.exports = {
  normalizeKnownWorkspaceContent,
};
