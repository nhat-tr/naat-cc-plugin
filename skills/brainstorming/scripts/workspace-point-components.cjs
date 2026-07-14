'use strict';

const MAX_POINTS = 6;
const MAX_PRODUCT_PREVIEW_ITEMS = 100;
const MAX_POINT_LENGTH = 160;
const MAX_COMPONENT_ID_LENGTH = 120;

function records(value) {
  return Array.isArray(value) ? value.filter(entry => entry && typeof entry === 'object' && !Array.isArray(entry)) : [];
}

function strings(value) {
  return Array.isArray(value) ? value.filter(entry => typeof entry === 'string') : [];
}

function reviewPointOwners(content) {
  const owners = [
    ...records(content?.canonical_spec?.acceptance_criteria),
    ...records(content?.review_slices),
    ...records(content?.findings),
    ...records(content?.quality_contract?.obligations).filter(owner => typeof owner.component_id === 'string'),
    ...records(content?.decision_records),
    ...records(content?.outcomes),
  ];
  return owners.map(owner => ({ ownerId: owner.component_id, points: strings(owner.points) }));
}

function pointOwners(workspaceKind, content) {
  if (!content || typeof content !== 'object' || Array.isArray(content)) return [];
  if (workspaceKind === 'architecture') {
    return records(content.nodes).map(node => ({ ownerId: node.component_id, points: strings(node.points) }));
  }
  if (workspaceKind === 'business') {
    return records(content.stages).map(stage => ({
      ownerId: stage.component_id,
      points: records(stage.items).map(item => item.label).filter(label => typeof label === 'string'),
    }));
  }
  if (workspaceKind === 'research') {
    return [
      ...records(content.claims).map(claim => ({
        ownerId: claim.component_id,
        points: [...strings(claim.source_refs), ...strings(claim.decision_relevance)],
      })),
      ...records(content.unknowns).map(unknown => ({
        ownerId: unknown.component_id,
        points: [unknown.note, ...strings(unknown.decision_relevance)].filter(value => typeof value === 'string'),
      })),
    ];
  }
  if (workspaceKind === 'product') {
    return records(content.concepts).map(concept => ({
      maxPoints: MAX_PRODUCT_PREVIEW_ITEMS,
      ownerId: concept.id,
      points: records(concept.preview?.regions).flatMap(region => strings(region.items)),
    }));
  }
  if (workspaceKind === 'review') return reviewPointOwners(content);
  return [];
}

function materializeWorkspacePointComponents(workspaceKind, frames, components, content) {
  const nextFrames = structuredClone(frames);
  const nextComponents = structuredClone(components);
  const componentById = new Map(nextComponents.map(component => [component.id, component]));
  const frameById = new Map(nextFrames.map(frame => [frame.id, frame]));

  for (const owner of pointOwners(workspaceKind, content)) {
    if (typeof owner.ownerId !== 'string' || owner.points.length === 0) continue;
    const maxPoints = owner.maxPoints ?? MAX_POINTS;
    if (owner.points.length > maxPoints) {
      throw new RangeError(`Component ${owner.ownerId} must contain at most ${maxPoints} Points`);
    }
    const ownerComponent = componentById.get(owner.ownerId);
    if (!ownerComponent) throw new TypeError(`Point owner ${owner.ownerId} must be an envelope Component`);
    const frame = frameById.get(ownerComponent.frame_id);
    if (!frame) throw new TypeError(`Point owner ${owner.ownerId} references an unknown Frame`);
    owner.points.forEach((value, index) => {
      const id = `${owner.ownerId}-p${index + 1}`;
      if (id.length > MAX_COMPONENT_ID_LENGTH) {
        throw new RangeError(`Point Component id ${id} exceeds ${MAX_COMPONENT_ID_LENGTH} characters`);
      }
      const point = typeof value === 'string' ? value.trim() : '';
      if (point.length === 0 || point.length > MAX_POINT_LENGTH) {
        throw new TypeError(`Point ${id} must contain 1-${MAX_POINT_LENGTH} characters`);
      }
      if (!componentById.has(id)) {
        const component = {
          id,
          frame_id: ownerComponent.frame_id,
          label: `${ownerComponent.label} · point ${index + 1}: ${point}`.slice(0, 300),
        };
        nextComponents.push(component);
        componentById.set(id, component);
      }
      if (!frame.component_ids.includes(id)) frame.component_ids.push(id);
    });
  }

  return { frames: nextFrames, components: nextComponents };
}

module.exports = { materializeWorkspacePointComponents };
