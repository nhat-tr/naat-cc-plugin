'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildInterviewDigest,
  interviewSidecarPaths,
  renderInterviewMarkdown,
  writeInterviewSidecars,
} = require('../scripts/interview-export.cjs');

function sampleScreen() {
  return {
    version: 2,
    workspace_kind: 'architecture',
    title: 'Agent delivery',
    revision: 'rev-3',
    nodes: [{ component_id: 'n1', label: 'Node One' }],
  };
}

function sampleSession() {
  return {
    version: 1,
    cursor: 1,
    pendingTurns: 0,
    events: [
      {
        version: 1,
        id: 't1',
        seq: 1,
        timestamp: 1_725_000_000_000,
        type: 'user.turn',
        role: 'user',
        clientTurnId: 'c1',
        message: 'Prefer foreground wait.',
        annotations: [{ id: 'a1', comment: 'This box is unclear', target: { componentId: 'n1', label: 'Node One' } }],
        choices: [{ groupId: 'd1', value: 'opt-a', label: 'Option A' }],
        screen: { id: 'architecture', file: 'workspace.json', revision: 'rev-3' },
      },
      {
        version: 1,
        id: 'r1',
        seq: 2,
        timestamp: 1_725_000_100_000,
        type: 'agent.message',
        role: 'agent',
        replyTo: 1,
        message: 'Understood, keeping foreground wait.',
      },
    ],
  };
}

test('buildInterviewDigest carries identity, the full document, and the interview history', () => {
  const screen = sampleScreen();
  const digest = buildInterviewDigest(screen, sampleSession());

  assert.equal(digest.schema, 'brainstorm-interview/v1');
  assert.equal(digest.workspace_kind, 'architecture');
  assert.equal(digest.title, 'Agent delivery');
  assert.equal(digest.revision, 'rev-3');
  assert.deepEqual(digest.document, screen);
  assert.notEqual(digest.document, screen, 'document is cloned, not the live reference');
  assert.equal(digest.history.events.length, 2);
  assert.equal(digest.history.events[0].message, 'Prefer foreground wait.');
});

test('buildInterviewDigest falls back to the v1 profile as the workspace kind', () => {
  const digest = buildInterviewDigest({ profile: 'technical', title: 'Legacy' }, {});
  assert.equal(digest.workspace_kind, 'technical');
  assert.deepEqual(digest.history.events, []);
});

test('renderInterviewMarkdown produces a skimmable transcript of turns, annotations, decisions, and replies', () => {
  const markdown = renderInterviewMarkdown(sampleScreen(), sampleSession(), {
    jsonName: 'visual.json',
    htmlName: 'visual.html',
  });

  assert.match(markdown, /^# Agent delivery — interview/u);
  assert.match(markdown, /- \*\*Workspace kind:\*\* architecture/u);
  assert.match(markdown, /- \*\*Revision:\*\* rev-3/u);
  assert.match(markdown, /- \*\*Reviewer turns:\*\* 1/u);
  assert.match(markdown, /- \*\*Full document \+ structured history:\*\* visual\.json/u);
  assert.match(markdown, /- \*\*Rendered visual:\*\* visual\.html/u);
  assert.match(markdown, /### Turn 1 · reviewer/u);
  assert.match(markdown, /Prefer foreground wait\./u);
  assert.match(markdown, /- `n1` \(Node One\): This box is unclear/u);
  assert.match(markdown, /- d1 → Option A/u);
  assert.match(markdown, /### Reply → turn 1 · agent/u);
  assert.match(markdown, /Understood, keeping foreground wait\./u);
});

test('renderInterviewMarkdown states plainly when no turns were recorded', () => {
  const markdown = renderInterviewMarkdown({ workspace_kind: 'research', title: 'Empty' }, { events: [] });
  assert.match(markdown, /_No interview turns were recorded\._/u);
});

test('interviewSidecarPaths maps the HTML export to its json and markdown siblings', () => {
  assert.deepEqual(interviewSidecarPaths('/a/b/visual.html'), {
    json: '/a/b/visual.json',
    markdown: '/a/b/visual.interview.md',
  });
  assert.deepEqual(interviewSidecarPaths('/a/b/visual-001.html'), {
    json: '/a/b/visual-001.json',
    markdown: '/a/b/visual-001.interview.md',
  });
  assert.deepEqual(interviewSidecarPaths('/a/b/visual'), {
    json: '/a/b/visual.json',
    markdown: '/a/b/visual.interview.md',
  });
});

test('writeInterviewSidecars writes both sidecars through the injected atomic writer', () => {
  const writes = new Map();
  const paths = writeInterviewSidecars(
    '/out/visual.html',
    sampleScreen(),
    sampleSession(),
    (file, contents) => writes.set(file, contents),
  );

  assert.deepEqual(paths, { json: '/out/visual.json', markdown: '/out/visual.interview.md' });
  assert.deepEqual([...writes.keys()].sort(), ['/out/visual.interview.md', '/out/visual.json']);
  const digest = JSON.parse(writes.get('/out/visual.json'));
  assert.equal(digest.schema, 'brainstorm-interview/v1');
  assert.match(writes.get('/out/visual.interview.md'), /# Agent delivery — interview/u);
});
