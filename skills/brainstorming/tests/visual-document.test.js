const assert = require('node:assert/strict');
const test = require('node:test');

const { createVisualScaffold, normalizeVisualDocument } = require('../scripts/visual-document.cjs');

test('visual scaffold emits canonical shapes for every reusable section kind', () => {
  const document = createVisualScaffold({
    profile: 'technical',
    audience: 'Software developers',
    title: 'Framework capability review',
    summary: 'Inspect the framework-native baseline.',
    kinds: ['anchor', 'callout', 'cards', 'decision', 'flow', 'mockup', 'timeline'],
  });

  assert.deepEqual(normalizeVisualDocument(document), document);
  assert.deepEqual(document.sections.map(section => section.kind), [
    'anchor', 'callout', 'cards', 'decision', 'flow', 'mockup', 'timeline',
  ]);
  assert.ok(Array.isArray(document.sections.find(section => section.kind === 'cards').items));
  assert.equal(typeof document.sections.find(section => section.kind === 'callout').body, 'string');
  assert.ok(Array.isArray(document.sections.find(section => section.kind === 'flow').nodes));
  assert.ok(Array.isArray(document.sections.find(section => section.kind === 'decision').options));
});

test('technical profile normalizes architecture flow and decision components', () => {
  const document = normalizeVisualDocument({
    version: 1,
    profile: 'technical',
    audience: 'Software developers',
    title: 'Per-Turn rendering',
    summary: 'Choose ownership without hiding framework behavior.',
    sections: [
      {
        kind: 'flow',
        id: 'runtime-flow',
        title: 'Observed flow',
        nodes: [
          { id: 'session', title: 'Agent Session', detail: 'Owns Turn lifecycle.' },
          { id: 'renderer', title: 'Renderer', detail: 'Builds deterministic Nodes.' },
        ],
      },
      {
        kind: 'decision',
        id: 'ownership',
        title: 'Choose ownership',
        options: [
          { id: 'turn-owned', label: 'Turn-owned', detail: 'Collector lives for one Turn.', score: 9, recommended: true },
          { id: 'session-owned', label: 'Session-owned', detail: 'More shared state.', score: 5 },
        ],
      },
    ],
  });

  assert.equal(document.profile, 'technical');
  assert.equal(document.sections[0].nodes[0].id, 'session');
  assert.equal(document.sections[1].groupId, 'ownership');
  assert.equal(document.sections[1].options[0].recommended, true);
});

test('a normalized decision document is canonical and can be normalized again', () => {
  const first = normalizeVisualDocument({
    profile: 'technical',
    title: 'Choose transport',
    sections: [{
      kind: 'decision',
      id: 'transport',
      title: 'Transport',
      options: [
        { id: 'sse', label: 'SSE', score: 9, recommended: true },
        { id: 'polling', label: 'Polling', score: 3 },
      ],
    }],
  });

  assert.equal(Object.hasOwn(first.sections[0].options[0], 'title'), false);
  assert.deepEqual(normalizeVisualDocument(first), first);
  const legacyBrokenOutput = structuredClone(first);
  legacyBrokenOutput.sections[0].options[0].title = legacyBrokenOutput.sections[0].options[0].label;
  assert.deepEqual(normalizeVisualDocument(legacyBrokenOutput), first);
});

test('product and business profiles accept purpose-specific visual sections', () => {
  const product = normalizeVisualDocument({
    profile: 'product',
    audience: 'Mobile banking customers',
    title: 'Payment confirmation',
    sections: [{
      kind: 'mockup',
      id: 'confirmation-screen',
      title: 'Mobile confirmation',
      device: 'mobile',
      regions: [{ id: 'result', title: 'Payment sent', detail: 'Show amount and recipient.' }],
    }],
  });
  const business = normalizeVisualDocument({
    profile: 'business',
    audience: 'Independent retailers',
    title: 'Inventory assistant',
    sections: [{
      kind: 'timeline',
      id: 'adoption-journey',
      title: 'Adoption journey',
      items: [{ id: 'connect', title: 'Connect catalogue', detail: 'Import current stock.' }],
    }],
  });

  assert.equal(product.sections[0].device, 'mobile');
  assert.equal(business.sections[0].items[0].id, 'connect');
});

test('decision scores reject non-numeric coercions such as booleans', () => {
  const build = score => normalizeVisualDocument({
    profile: 'technical',
    title: 'Choose transport',
    sections: [{
      kind: 'decision',
      id: 'transport',
      title: 'Transport',
      options: [
        { id: 'sse', label: 'SSE', score },
        { id: 'polling', label: 'Polling' },
      ],
    }],
  });

  assert.throws(() => build(true), /score must be a number/i);
  assert.throws(() => build('9'), /score must be a number/i);
  assert.equal(build(9).sections[0].options[0].score, 9);
});

test('visual documents reject arbitrary HTML, styling, and unsupported section kinds', () => {
  assert.throws(() => normalizeVisualDocument({
    profile: 'technical',
    title: 'Unsafe',
    style: 'body { display: none }',
    sections: [],
  }), /unsupported field.*style/i);
  assert.throws(() => normalizeVisualDocument({
    profile: 'technical',
    title: 'Unsafe',
    sections: [{ kind: 'html', id: 'raw', html: '<script>alert(1)</script>' }],
  }), /unsupported section kind/i);
});
