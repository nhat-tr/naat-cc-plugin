const assert = require('node:assert/strict');
const test = require('node:test');

const { normalizeBrowserTurn } = require('../scripts/session-store.cjs');

function workspaceContract() {
  return require('../scripts/workspace-document.cjs');
}

function workspaceDocument(overrides = {}) {
  return {
    version: 2,
    work_id: 'work-20260712-visual-companion-vnext',
    workspace_kind: 'architecture',
    title: 'Feedback thread contract',
    evidence_refs: [{ id: 'EVD-001', label: 'Observed architecture' }],
    frames: [{ id: 'frame-main', title: 'Current architecture', component_ids: ['service-boundary'] }],
    components: [{ id: 'service-boundary', frame_id: 'frame-main', label: 'Service boundary' }],
    decisions: [],
    feedback_threads: [],
    content: { nodes: [] },
    read_only: false,
    ...overrides,
  };
}

function feedbackThread(overrides = {}) {
  return {
    id: 'thread-service-boundary',
    component_id: 'service-boundary',
    revision: 'a1b2c3d4',
    type: 'annotation',
    status: 'open',
    comment: 'Make retry ownership explicit.',
    replies: [{
      id: 'reply-service-boundary-1',
      author: 'agent',
      text: 'Retry ownership now belongs to the delivery core.',
      recorded_at: '2026-07-13T09:30:00.000Z',
    }],
    ...overrides,
  };
}

function normalize(document) {
  const { documentRevision, normalizeWorkspaceDocument } = workspaceContract();
  const candidate = structuredClone(document);
  if (!Object.hasOwn(candidate, 'revision')) candidate.revision = documentRevision(candidate);
  return normalizeWorkspaceDocument(candidate, {
    contentValidator: content => structuredClone(content),
  });
}

test('Revision-bound feedback threads preserve stable Component and Reply identity', () => {
  const source = workspaceDocument({ feedback_threads: [feedbackThread()] });
  const normalized = normalize(source);

  assert.deepEqual(normalized.feedback_threads, source.feedback_threads);
  assert.equal(normalized.feedback_threads[0].component_id, normalized.components[0].id);
  assert.equal(normalized.feedback_threads[0].revision, 'a1b2c3d4');
  assert.equal(normalized.feedback_threads[0].replies[0].author, 'agent');
  assert.deepEqual(normalize(normalized), normalized);
});

test('open and resolved authored feedback thread state persists with exact Component and Revision identity', () => {
  assert.equal(normalize(workspaceDocument({
    feedback_threads: [feedbackThread({ status: 'resolved' })],
  })).feedback_threads[0].status, 'resolved');
  assert.throws(
    () => normalize(workspaceDocument({ feedback_threads: [feedbackThread({ component_id: 'missing-component' })] })),
    /component.*missing-component|known component/i,
  );
  assert.throws(
    () => normalize(workspaceDocument({ feedback_threads: [feedbackThread({ revision: 'not-a-revision' })] })),
    /revision.*8|revision/i,
  );
  assert.throws(
    () => normalize(workspaceDocument({ feedback_threads: [feedbackThread({ type: '' })] })),
    /feedback.*type|type.*required/i,
  );
  assert.throws(
    () => normalize(workspaceDocument({ feedback_threads: [feedbackThread({ type: 'x'.repeat(201) })] })),
    /feedback.*type|type.*at most|type.*length/i,
  );
  assert.throws(
    () => normalize(workspaceDocument({ feedback_threads: [feedbackThread({ comment: '' })] })),
    /feedback.*comment|comment.*required/i,
  );
  assert.throws(
    () => normalize(workspaceDocument({
      feedback_threads: [feedbackThread({
        replies: [{
          id: 'reply-service-boundary-1',
          author: 'agent',
          text: '',
          recorded_at: '2026-07-13T09:30:00.000Z',
        }],
      })],
    })),
    /reply.*text|text.*required/i,
  );
  assert.throws(
    () => normalize(workspaceDocument({
      feedback_threads: [feedbackThread({
        replies: [{
          ...feedbackThread().replies[0],
          recorded_at: 'July 13, 2026',
        }],
      })],
    })),
    /recorded_at|date-time|RFC 3339/i,
  );
  assert.throws(
    () => normalize(workspaceDocument({
      feedback_threads: [
        feedbackThread(),
        feedbackThread({ component_id: 'service-boundary', comment: 'Duplicate thread identity.' }),
      ],
    })),
    /duplicate.*thread|thread.*thread-service-boundary/i,
  );
  assert.throws(
    () => normalize(workspaceDocument({
      feedback_threads: [feedbackThread({
        replies: [
          feedbackThread().replies[0],
          { ...feedbackThread().replies[0], text: 'Duplicate Reply identity.' },
        ],
      })],
    })),
    /duplicate.*reply|reply.*reply-service-boundary-1/i,
  );
});

test('Choices and the Summary Note remain distinct Feedback Batch data, not feedback thread fields', () => {
  const batch = normalizeBrowserTurn({
    clientTurnId: 'feedback-batch-1',
    message: 'Keep the service boundary visible.',
    annotations: [{
      id: 'annotation-1',
      comment: 'Make retry ownership explicit.',
      target: { componentId: 'service-boundary', label: 'Service boundary' },
    }],
    choices: [{
      groupId: 'retry-owner',
      componentId: 'delivery-core-option',
      value: 'delivery-core',
      label: 'Delivery core',
    }],
    screen: { id: 'architecture', file: 'screen.json', revision: 'a1b2c3d4' },
  });

  assert.equal(batch.message, 'Keep the service boundary visible.');
  assert.equal(batch.annotations[0].target.componentId, 'service-boundary');
  assert.equal(batch.choices[0].value, 'delivery-core');
  assert.equal(batch.screen.revision, 'a1b2c3d4');

  assert.throws(
    () => normalize(workspaceDocument({
      feedback_threads: [feedbackThread({
        choices: batch.choices,
        summary_note: batch.message,
      })],
    })),
    /unsupported field.*choices|unsupported field.*summary_note/i,
  );
});

test('outdated feedback state consumes existing component Change Flags instead of comparing Revisions alone', () => {
  const { deriveFeedbackThreadState } = require('../assets/visual-shell/app.js');
  assert.equal(typeof deriveFeedbackThreadState, 'function');
  const thread = feedbackThread();

  assert.equal(deriveFeedbackThreadState(thread, 'a1b2c3d4', {
    added: [], updated: ['service-boundary'], removed: [],
  }), 'open', 'the thread is current when its Revision matches');
  assert.equal(deriveFeedbackThreadState(thread, 'b2c3d4e5', {
    added: [], updated: [], removed: [],
  }), 'open', 'a new Revision does not make an unchanged target outdated');
  const derivedOutdated = deriveFeedbackThreadState(thread, 'b2c3d4e5', {
    added: [], updated: ['service-boundary'], removed: [],
  });
  assert.equal(derivedOutdated, 'outdated');
  assert.equal(deriveFeedbackThreadState(thread, 'b2c3d4e5', {
    added: [], updated: [], removed: [{ id: 'service-boundary', label: 'Service boundary' }],
  }), 'outdated');
  const persistedOutdated = normalize(workspaceDocument({
    feedback_threads: [feedbackThread({ status: derivedOutdated })],
  })).feedback_threads[0];
  assert.equal(deriveFeedbackThreadState(persistedOutdated, 'c3d4e5f6', {
    added: [], updated: [], removed: [],
  }), 'outdated', 'outdated state remains sticky across a later unchanged publish or reload');
  assert.equal(deriveFeedbackThreadState(feedbackThread({ status: 'resolved' }), 'b2c3d4e5', {
    added: [], updated: ['service-boundary'], removed: [],
  }), 'resolved', 'resolved state remains explicit history');
});
