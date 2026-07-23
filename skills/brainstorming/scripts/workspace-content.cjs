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

const UML_LEGAL_NODE_KINDS = {
  component: new Set(['component', 'interface', 'artifact', 'deployment_node', 'actor', 'use_case']),
  state_machine: new Set(['state', 'initial', 'final', 'choice', 'junction', 'fork', 'join', 'terminate', 'history']),
  activity: new Set(['action', 'initial', 'final', 'flow_final', 'decision', 'merge', 'fork', 'join', 'object', 'accept_event', 'send_signal']),
};
const UML_LEGAL_RELATIONS = {
  component: new Set(['dependency', 'assembly', 'delegation', 'realization', 'association', 'generalization']),
  state_machine: new Set(['transition']),
  activity: new Set(['control_flow', 'object_flow']),
};
const UML_LEGAL_CONTAINER_KINDS = {
  component: new Set(['package', 'node', 'frame']),
  state_machine: new Set(['composite_state', 'frame']),
  activity: new Set(['partition', 'frame']),
};

function umlSemanticError(message) {
  throw new TypeError(`uml Workspace content is invalid: ${message}`);
}

function registerUmlComponents(records, umlComponents, topologyIds, kindLabel, withPoints) {
  for (const record of records) {
    const existingTopology = topologyIds.get(record.id);
    if (existingTopology) {
      umlSemanticError(`topology id ${record.id} is duplicated across ${existingTopology} and ${kindLabel}`);
    }
    topologyIds.set(record.id, kindLabel);
    if (umlComponents.has(record.component_id)) {
      umlSemanticError(`Component ${record.component_id} is duplicated`);
    }
    umlComponents.set(record.component_id, { id: record.id, label: kindLabel });
    if (!withPoints) continue;
    const points = Array.isArray(record.points) ? record.points : [];
    for (let index = 0; index < points.length; index += 1) {
      const pointId = `${record.component_id}-p${index + 1}`;
      if (umlComponents.has(pointId)) umlSemanticError(`Point Component ${pointId} is duplicated`);
      umlComponents.set(pointId, { id: pointId, label: 'point' });
    }
  }
}

function checkUmlEnvelopeParity(umlComponents, context) {
  if (!Array.isArray(context.component_ids)) return;
  const envelopeComponents = new Set(context.component_ids);
  for (const componentId of umlComponents.keys()) {
    if (!envelopeComponents.has(componentId)) {
      umlSemanticError(`Component ${componentId} is missing from envelope Components`);
    }
  }
  for (const componentId of envelopeComponents) {
    if (!umlComponents.has(componentId)) {
      umlSemanticError(`envelope Component ${componentId} has no UML content`);
    }
  }
}

function validateUmlGraphSemantics(content, context) {
  const diagramKind = content.diagram_kind;
  const umlComponents = new Map();
  const topologyIds = new Map();
  registerUmlComponents(content.containers, umlComponents, topologyIds, 'container', false);
  registerUmlComponents(content.nodes, umlComponents, topologyIds, 'node', true);
  registerUmlComponents(content.edges, umlComponents, topologyIds, 'edge', false);
  checkUmlEnvelopeParity(umlComponents, context);

  const containerById = new Map(content.containers.map(container => [container.id, container]));
  const nodeById = new Map(content.nodes.map(node => [node.id, node]));

  for (const container of content.containers) {
    if (!UML_LEGAL_CONTAINER_KINDS[diagramKind].has(container.container_kind)) {
      umlSemanticError(`container ${container.id} kind ${container.container_kind} is not valid for a ${diagramKind} diagram`);
    }
    if (container.parent_id !== null && !containerById.has(container.parent_id)) {
      umlSemanticError(`container ${container.id} parent ${container.parent_id} does not resolve`);
    }
  }
  for (const container of content.containers) {
    const chain = new Set();
    let current = container;
    while (current) {
      if (chain.has(current.id)) umlSemanticError(`container parent cycle includes ${current.id}`);
      chain.add(current.id);
      current = current.parent_id === null ? null : containerById.get(current.parent_id);
    }
  }

  for (const node of content.nodes) {
    if (!UML_LEGAL_NODE_KINDS[diagramKind].has(node.node_kind)) {
      umlSemanticError(`node ${node.id} kind ${node.node_kind} is not valid for a ${diagramKind} diagram`);
    }
    if (node.container_id !== null && !containerById.has(node.container_id)) {
      umlSemanticError(`node ${node.id} container ${node.container_id} does not resolve`);
    }
  }

  for (const edge of content.edges) {
    if (!UML_LEGAL_RELATIONS[diagramKind].has(edge.relation)) {
      umlSemanticError(`edge ${edge.id} relation ${edge.relation} is not valid for a ${diagramKind} diagram`);
    }
    if (!nodeById.has(edge.source)) umlSemanticError(`edge ${edge.id} source ${edge.source} does not resolve to a node`);
    if (!nodeById.has(edge.target)) umlSemanticError(`edge ${edge.id} target ${edge.target} does not resolve to a node`);
  }

  for (const targetId of content.focus_targets) {
    if (!nodeById.has(targetId) && !containerById.has(targetId)) {
      umlSemanticError(`focus target ${targetId} must resolve to a node or container`);
    }
  }
  for (const targetId of content.annotation_targets) {
    if (!umlComponents.has(targetId)) {
      umlSemanticError(`annotation target ${targetId} must resolve to a UML Component`);
    }
  }
}

function validateUmlSequenceSemantics(content, context) {
  const umlComponents = new Map();
  const topologyIds = new Map();
  registerUmlComponents(content.lifelines, umlComponents, topologyIds, 'lifeline', true);
  registerUmlComponents(content.messages, umlComponents, topologyIds, 'message', true);
  registerUmlComponents(content.fragments, umlComponents, topologyIds, 'fragment', false);
  checkUmlEnvelopeParity(umlComponents, context);

  const lifelineById = new Map(content.lifelines.map(lifeline => [lifeline.id, lifeline]));
  const messageById = new Map(content.messages.map(message => [message.id, message]));

  for (const message of content.messages) {
    if (!lifelineById.has(message.from)) {
      umlSemanticError(`message ${message.id} from ${message.from} does not resolve to a lifeline`);
    }
    if (!lifelineById.has(message.to)) {
      umlSemanticError(`message ${message.id} to ${message.to} does not resolve to a lifeline`);
    }
    if (message.message_kind === 'self' && message.from !== message.to) {
      umlSemanticError(`message ${message.id} is a self message but from and to differ`);
    }
  }

  for (const fragment of content.fragments) {
    const seen = new Set();
    for (const messageId of fragment.message_ids) {
      if (!messageById.has(messageId)) {
        umlSemanticError(`fragment ${fragment.id} references message ${messageId} that does not resolve`);
      }
      if (seen.has(messageId)) {
        umlSemanticError(`fragment ${fragment.id} references message ${messageId} more than once`);
      }
      seen.add(messageId);
    }
  }

  for (const targetId of content.annotation_targets) {
    if (!umlComponents.has(targetId)) {
      umlSemanticError(`annotation target ${targetId} must resolve to a UML Component`);
    }
  }
}

function validateUmlSemantics(content, context) {
  if (content.diagram_kind === 'sequence') {
    validateUmlSequenceSemantics(content, context);
    return;
  }
  validateUmlGraphSemantics(content, context);
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
  if (context.workspace_kind === 'uml') validateUmlSemantics(normalized, context);
  return normalized;
}

module.exports = {
  normalizeKnownWorkspaceContent,
};
