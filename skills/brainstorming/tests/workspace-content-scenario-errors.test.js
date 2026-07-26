'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { normalizeKnownWorkspaceContent } = require('../scripts/workspace-content.cjs');

const fixturePath = path.join(__dirname, '..', 'fixtures', 'architecture-large.json');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function fixture() {
  return readJson(fixturePath);
}

function scenarioContent() {
  return structuredClone(fixture().content);
}

test('scenario path with mismatched node/edge counts reports the malformed-length diagnosis', () => {
  const content = scenarioContent();
  const currentPath = content.scenarios[0].paths.current;
  currentPath.edge_ids.pop();

  assert.throws(
    () => normalizeKnownWorkspaceContent(content, { workspace_kind: 'architecture' }),
    (error) => {
      assert.match(
        error.message,
        /scenario feedback-delivery current path is malformed: node_ids has 5 entries but edge_ids has 3 — a walk through N nodes needs exactly N-1 edges \(expected 4\)/,
      );
      return true;
    },
  );
});

test('scenario path referencing an unknown node id reports the dangling-reference diagnosis', () => {
  const content = scenarioContent();
  const currentPath = content.scenarios[0].paths.current;
  currentPath.node_ids[0] = 'missing-node';

  assert.throws(
    () => normalizeKnownWorkspaceContent(content, { workspace_kind: 'architecture' }),
    (error) => {
      assert.match(
        error.message,
        /scenario feedback-delivery current path references an unknown node id "missing-node" — every node_id\/edge_id in a Scenario Path must already exist in this workspace's nodes\/edges arrays/,
      );
      return true;
    },
  );
});

test('scenario path referencing an edge that does not declare the mode reports the mode-support diagnosis', () => {
  const content = scenarioContent();
  const sharedEdge = content.edges.find(edge => edge.id === 'edge-001');
  sharedEdge.modes = ['proposed'];

  assert.throws(
    () => normalizeKnownWorkspaceContent(content, { workspace_kind: 'architecture' }),
    (error) => {
      assert.match(
        error.message,
        /scenario feedback-delivery current path includes edge "edge-001" which does not declare "current" in its own modes array — every node\/edge referenced by a path for mode X must list X in modes, even when current and proposed reuse the identical path/,
      );
      return true;
    },
  );
});

test('scenario path whose edges do not chain node-to-node reports the disconnected-step diagnosis', () => {
  const content = scenarioContent();
  const proposedPath = content.scenarios[0].paths.proposed;
  [proposedPath.node_ids[1], proposedPath.node_ids[2]] = [proposedPath.node_ids[2], proposedPath.node_ids[1]];

  assert.throws(
    () => normalizeKnownWorkspaceContent(content, { workspace_kind: 'architecture' }),
    (error) => {
      assert.match(
        error.message,
        /scenario feedback-delivery proposed path is disconnected at step 0: edge "edge-001" connects "visual-companion-ui"→"visual-session", but the path expects "visual-companion-ui"→"session-store" — a Scenario Path must be one linear walk; if the real flow forks or branches, split it into two scenarios instead of one/,
      );
      return true;
    },
  );
});

test('a fully-valid scenario path document normalizes without throwing', () => {
  const content = scenarioContent();

  assert.doesNotThrow(() => normalizeKnownWorkspaceContent(content, { workspace_kind: 'architecture' }));
});
