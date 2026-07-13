'use strict';

const crypto = require('node:crypto');

const { normalizeKnownWorkspaceContent } = require('./workspace-content.cjs');
const { normalizeWorkspaceDocument, WORKSPACE_KINDS } = require('./workspace-document.cjs');

const DEFAULT_TITLES = Object.freeze({
  product: 'Product Concept Studio',
  architecture: 'Architecture Canvas',
  research: 'Research Evidence Board',
  business: 'Business Reasoning Canvas',
  review: 'Feature Review Workbench',
});

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function productConcept(id, slot, title, differenceKind, summary) {
  return {
    id,
    slot,
    title,
    strategy: {
      id: `${id}-strategy`,
      difference_kind: differenceKind,
      summary,
    },
    preview: {
      primary_action: `Inspect ${title}`,
      regions: [
        {
          id: `${id}-navigation`,
          label: 'Navigation',
          role: 'navigation',
          items: ['Primary destination', 'Secondary destination'],
        },
        {
          id: `${id}-main`,
          label: 'Main task',
          role: 'main',
          items: ['Primary information', 'Primary action'],
        },
      ],
    },
    focus: {
      states: [
        { id: 'default', label: 'Default', detail: 'Ready for the primary task.' },
        { id: 'loading', label: 'Loading', detail: 'Preserve layout while data loads.' },
        { id: 'empty', label: 'Empty', detail: 'Offer one useful next action.' },
        { id: 'error', label: 'Error', detail: 'Explain recovery without losing input.' },
      ],
      responsive: [
        { viewport: 'mobile', behavior: 'Keep the primary action and comparison identity visible.' },
        { viewport: 'desktop', behavior: 'Use the available width for inspection detail.' },
      ],
      accessibility: {
        landmarks: ['Navigation', 'Main'],
        keyboard_order: ['Navigation', 'Primary information', 'Primary action'],
        announcements: ['Loading state', 'Error state'],
        reduced_motion: 'Replace animated transitions with immediate state changes.',
      },
      handoff: {
        component_boundaries: ['Navigation region', 'Main task region'],
        data_contracts: ['Replace with the feature data contract.'],
        events: ['Replace with the primary interaction event.'],
        implementation_notes: ['Replace placeholders after a concept is chosen.'],
      },
    },
  };
}

function productDraft(title) {
  const evidenceId = 'EVD-001-product-direction';
  const concepts = [
    productConcept('concept-a', 'A', 'Command center', 'information_architecture', 'Expose the full working set for direct inspection.'),
    productConcept('concept-b', 'B', 'Guided flow', 'interaction_model', 'Lead the user through one decision at a time.'),
    productConcept('concept-c', 'C', 'Direct manipulation', 'interaction_model', 'Make the primary object the interaction surface.'),
  ];
  return {
    evidence_refs: [{ id: evidenceId, label: 'Replace with approved Product direction evidence' }],
    frames: [
      { id: 'compare', title: 'Compare concepts', component_ids: ['concept-a', 'concept-b', 'concept-c', 'difference-lens'] },
      { id: 'focus', title: 'Focused handoff', component_ids: ['focus-states', 'focus-responsive', 'focus-accessibility', 'focus-handoff'] },
    ],
    components: [
      { id: 'concept-a', frame_id: 'compare', label: 'Concept A: Command center' },
      { id: 'concept-b', frame_id: 'compare', label: 'Concept B: Guided flow' },
      { id: 'concept-c', frame_id: 'compare', label: 'Concept C: Direct manipulation' },
      { id: 'difference-lens', frame_id: 'compare', label: 'Material differences' },
      { id: 'focus-states', frame_id: 'focus', label: 'Interaction states' },
      { id: 'focus-responsive', frame_id: 'focus', label: 'Responsive behavior' },
      { id: 'focus-accessibility', frame_id: 'focus', label: 'Accessibility behavior' },
      { id: 'focus-handoff', frame_id: 'focus', label: 'Implementation handoff' },
    ],
    decisions: [{
      id: 'product-concept-choice',
      title: 'Choose one Product concept',
      multiselect: false,
      option_component_ids: ['concept-a', 'concept-b', 'concept-c'],
    }],
    content: {
      layout_direction: {
        id: 'device-aware-triptych',
        mobile: 'three_up',
        desktop: 'stacked_with_difference_lens',
        evidence_ref: evidenceId,
      },
      fixture: {
        id: 'shared-product-fixture',
        device: 'responsive_web',
        scope: 'Replace with one concrete user task shared by all concepts.',
        fidelity: 'interaction_detailed',
        data: {
          work_title: title,
          revision: '00000000',
          pending_count: 1,
          feedback_batches: [{
            id: 'feedback-batch-one',
            author: 'Reviewer',
            summary: 'Replace with representative fixture data.',
            state: 'queued',
          }],
        },
      },
      recommendation: {
        concept_id: 'concept-a',
        disclosure: 'after_inspection_or_provisional_choice',
        rationale: ['Replace with evidence-grounded rationale after inspection.'],
      },
      concepts,
      difference_lens: {
        title: 'Material differences',
        dimensions: [{
          id: 'primary-difference',
          label: 'Primary interaction model',
          values: {
            'concept-a': 'Full working set',
            'concept-b': 'Guided sequence',
            'concept-c': 'Object-centered interaction',
          },
        }],
      },
    },
  };
}

function architectureDraft() {
  const evidenceId = 'EVD-001-architecture-direction';
  return {
    evidence_refs: [{ id: evidenceId, label: 'Replace with approved Architecture direction evidence' }],
    frames: [{
      id: 'topology',
      title: 'Runtime topology',
      component_ids: ['system-boundary', 'source-service', 'target-service', 'request-flow', 'primary-scenario'],
    }],
    components: [
      { id: 'system-boundary', frame_id: 'topology', label: 'System boundary' },
      { id: 'source-service', frame_id: 'topology', label: 'Source service' },
      { id: 'target-service', frame_id: 'topology', label: 'Target service' },
      { id: 'request-flow', frame_id: 'topology', label: 'Request flow' },
      { id: 'primary-scenario', frame_id: 'topology', label: 'Primary scenario' },
    ],
    decisions: [],
    content: {
      layout_direction: {
        id: 'exclusive-view-modes',
        comparison: 'exclusive_view_modes',
        evidence_ref: evidenceId,
      },
      layout: {
        contract_version: 1,
        engine: 'elk',
        algorithm: 'layered',
        direction: 'RIGHT',
        stable_across_modes: true,
      },
      initial_mode: 'proposed',
      ownership_boundaries: [{
        id: 'system-boundary',
        component_id: 'system-boundary',
        label: 'Replace with owning system',
        parent_id: null,
      }],
      nodes: [
        {
          id: 'source-service',
          component_id: 'source-service',
          type: 'service',
          label: 'Source service',
          owner_id: 'system-boundary',
          layout_hint: { layer: 0, order: 0 },
          ports: [
            { id: 'source-input', label: 'Input', direction: 'input', kind: 'request', protocol: 'replace-me' },
            { id: 'source-output', label: 'Output', direction: 'output', kind: 'command', protocol: 'replace-me' },
          ],
          modes: ['current', 'proposed'],
          change: 'unchanged',
        },
        {
          id: 'target-service',
          component_id: 'target-service',
          type: 'service',
          label: 'Target service',
          owner_id: 'system-boundary',
          layout_hint: { layer: 1, order: 0 },
          ports: [
            { id: 'target-input', label: 'Input', direction: 'input', kind: 'command', protocol: 'replace-me' },
            { id: 'target-output', label: 'Output', direction: 'output', kind: 'result', protocol: 'replace-me' },
          ],
          modes: ['current', 'proposed'],
          change: 'modified',
        },
      ],
      edges: [{
        id: 'request-flow',
        component_id: 'request-flow',
        type: 'command',
        source: { node_id: 'source-service', port_id: 'source-output' },
        target: { node_id: 'target-service', port_id: 'target-input' },
        modes: ['current', 'proposed'],
      }],
      scenarios: [{
        id: 'primary-scenario',
        component_id: 'primary-scenario',
        label: 'Primary scenario',
        description: 'Replace with the behavior this topology must explain.',
        paths: {
          current: { node_ids: ['source-service', 'target-service'], edge_ids: ['request-flow'] },
          proposed: { node_ids: ['source-service', 'target-service'], edge_ids: ['request-flow'] },
        },
      }],
      camera: {
        min_zoom: 0.2,
        max_zoom: 2,
        default_zoom: 1,
        fit_padding: 0.15,
        controls: ['pan', 'zoom_in', 'zoom_out', 'fit_view', 'minimap'],
      },
      focus_targets: ['source-service', 'target-service'],
      annotation_targets: ['system-boundary', 'source-service', 'target-service', 'request-flow', 'primary-scenario'],
    },
  };
}

function researchDraft() {
  const evidenceId = 'EVD-001-research-source';
  return {
    evidence_refs: [{ id: evidenceId, label: 'Replace with primary source evidence' }],
    frames: [{ id: 'board', title: 'Evidence board', component_ids: ['claim-one', 'unknown-one'] }],
    components: [
      { id: 'claim-one', frame_id: 'board', label: 'Evidence-backed claim' },
      { id: 'unknown-one', frame_id: 'board', label: 'Decision-relevant unknown' },
    ],
    decisions: [],
    content: {
      decision_relevance_options: ['Primary decision'],
      claims: [{
        component_id: 'claim-one',
        confidence: 'medium',
        source_refs: [evidenceId],
        decision_relevance: ['Primary decision'],
      }],
      unknowns: [{
        component_id: 'unknown-one',
        note: 'Replace with the highest-value unanswered question.',
        decision_relevance: ['Primary decision'],
      }],
    },
  };
}

function businessDraft() {
  return {
    evidence_refs: [],
    frames: [{ id: 'journey', title: 'Business reasoning', component_ids: ['stage-one'] }],
    components: [{ id: 'stage-one', frame_id: 'journey', label: 'First decision stage' }],
    decisions: [],
    content: {
      journey_spine: true,
      actors: [{ id: 'primary-actor', label: 'Replace with the primary actor' }],
      outcomes: [{ id: 'target-outcome', label: 'Replace with the measurable outcome' }],
      stages: [{
        component_id: 'stage-one',
        tone: 'accent',
        actor_id: 'primary-actor',
        outcome_id: 'target-outcome',
        items: [
          { kind: 'assumption', label: 'Replace with the riskiest business assumption.' },
          { kind: 'experiment', label: 'Replace with the cheapest discriminating experiment.' },
        ],
      }],
    },
  };
}

function reviewDraft(workId) {
  const acceptanceCriterionId = 'AC-1';
  const decisionRecordId = 'DR-001-review-scaffold';
  const evidenceId = 'EVD-001-review-scaffold';
  const taskId = '1.1';
  const sourceId = 'source-draft';
  const sourcePath = 'src/feature.js';
  const patchDigest = digest(`${workId}:review-scaffold:patch`);
  const patchSetId = digest(`${workId}:review-scaffold:patch-set`);
  const specDigest = digest(`${workId}:review-scaffold:spec`);
  const planDigest = digest(`${workId}:review-scaffold:plan`);
  const baseTree = '0'.repeat(40);
  const headTree = '1'.repeat(40);

  return {
    evidence_refs: [{ id: evidenceId, label: 'Replace with current Review evidence' }],
    frames: [{
      id: 'workbench',
      title: 'Feature review',
      component_ids: ['ac-1', 'slice-draft', sourceId, 'decision-draft', 'outcome-draft'],
    }],
    components: [
      { id: 'ac-1', frame_id: 'workbench', label: 'AC-1: replace with approved intent' },
      { id: 'slice-draft', frame_id: 'workbench', label: 'Review Slice 1.1' },
      { id: sourceId, frame_id: 'workbench', label: 'Changed source' },
      { id: 'decision-draft', frame_id: 'workbench', label: 'Accepted Decision Record' },
      { id: 'outcome-draft', frame_id: 'workbench', label: 'Recorded outcome' },
    ],
    decisions: [],
    content: {
      canonical_spec: {
        path: `docs/work/${workId}/spec.md`,
        digest: specDigest,
        acceptance_criteria: [{
          id: acceptanceCriterionId,
          component_id: 'ac-1',
          title: 'Replace with one approved Acceptance Criterion',
        }],
      },
      review_slices: [{
        component_id: 'slice-draft',
        task_id: taskId,
        stream_id: '1',
        title: 'Replace with the approved plan task',
        acceptance_criteria: [acceptanceCriterionId],
        expected_files: [sourcePath],
        verification_command: 'replace-with-verification-command',
        actual_changes: [{
          component_id: sourceId,
          path: sourcePath,
          hunk_id: patchDigest,
          symbols: ['replaceWithChangedSymbol'],
          claimed_by: [taskId],
          acceptance_criteria: [acceptanceCriterionId],
          evidence_ids: [evidenceId],
          source_preview: {
            start_line: 1,
            end_line: 1,
            lines: ['Replace with bounded source context.'],
          },
        }],
        verification: [evidenceId],
        finding_ids: [],
      }],
      cross_slice_changes: [],
      unmapped_changes: [],
      patch_set: {
        schema: 1,
        patch_set_id: patchSetId,
        attempt_id: 'attempt-001',
        work_id: workId,
        spec_digest: specDigest,
        plan_digest: planDigest,
        decision_record_ids: [decisionRecordId],
        base_tree: baseTree,
        head_tree: headTree,
        files: [{
          path: sourcePath,
          patch_digest: patchDigest,
          acceptance_criteria: [acceptanceCriterionId],
          attribution: { kind: 'review_slice', review_slice_ids: [taskId] },
        }],
      },
      patch_set_review: {
        schema: 1,
        patch_set_id: patchSetId,
        attempt_id: 'attempt-001',
        work_id: workId,
        base_tree: baseTree,
        head_tree: headTree,
        file_reviews: [{
          path: sourcePath,
          patch_digest: patchDigest,
          acceptance_criteria: [acceptanceCriterionId],
          viewed: false,
          viewed_patch_set_id: null,
        }],
        acceptance_evidence: {
          [acceptanceCriterionId]: {
            status: 'current',
            patch_set_id: patchSetId,
            evidence_ids: [evidenceId],
          },
        },
        whole_feature_verdict: null,
        viewed_progress: { viewed: 0, total: 1 },
        can_approve: false,
      },
      patch_set_invalidations: [],
      evidence_records: [{
        schema: 1,
        id: evidenceId,
        work_id: workId,
        kind: 'review-scaffold',
        acceptance_criteria: [acceptanceCriterionId],
        decision_record_ids: [decisionRecordId],
        source: 'Replace with an observed verification source',
        recorded_at: '1970-01-01T00:00:00.000Z',
        result: { state: 'draft' },
      }],
      source_evidence: [{
        id: sourceId,
        component_id: sourceId,
        path: sourcePath,
        hunk_id: patchDigest,
        symbols: ['replaceWithChangedSymbol'],
        start_line: 1,
        end_line: 1,
      }],
      verification_evidence: [{
        evidence_ref: evidenceId,
        status: 'current',
        patch_set_id: patchSetId,
        acceptance_criteria: [acceptanceCriterionId],
      }],
      findings: [],
      quality_contract: {
        workId,
        facts: [],
        obligations: [{
          id: 'EQC-BASE',
          quality: 'intent_maintainability',
          activation: 'always',
          activationFacts: [],
          impact: 'ordinary',
          owner: 'Replace with the responsible reviewer',
          status: 'open',
          activatedBy: [],
        }],
        canClose: false,
      },
      decision_records: [{
        id: decisionRecordId,
        component_id: 'decision-draft',
        title: 'Replace with an accepted Decision Record',
        status: 'accepted',
        acceptance_criteria: [acceptanceCriterionId],
        evidence_refs: [evidenceId],
      }],
      outcomes: [{
        id: 'OUT-001-review-scaffold',
        component_id: 'outcome-draft',
        decision_record_ids: [decisionRecordId],
        source: 'manual_review',
        result: 'Replace with the observed outcome of a manual review.',
        evidence_refs: [evidenceId],
        recorded_at: '1970-01-01T00:00:00.000Z',
      }],
    },
  };
}

const DRAFT_BUILDERS = Object.freeze({
  product: (_workId, title) => productDraft(title),
  architecture: () => architectureDraft(),
  research: () => researchDraft(),
  business: () => businessDraft(),
  review: workId => reviewDraft(workId),
});

function createWorkspaceScaffold(options = {}) {
  const { workId, workspaceKind } = options;
  const builder = DRAFT_BUILDERS[workspaceKind];
  if (!builder || !WORKSPACE_KINDS.includes(workspaceKind)) {
    throw new TypeError(`unsupported Workspace Kind ${workspaceKind || ''}`.trim());
  }
  const title = options.title || DEFAULT_TITLES[workspaceKind];
  const draft = builder(workId, title);
  return normalizeWorkspaceDocument({
    version: 2,
    work_id: workId,
    workspace_kind: workspaceKind,
    title,
    evidence_refs: draft.evidence_refs,
    revision: undefined,
    frames: draft.frames,
    components: draft.components,
    decisions: draft.decisions,
    feedback_threads: [],
    content: draft.content,
    read_only: false,
  }, {
    contentValidator: normalizeKnownWorkspaceContent,
  });
}

module.exports = {
  createWorkspaceScaffold,
};
