const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const Ajv2020 = require('ajv/dist/2020').default;

const { normalizeWorkspaceDocument } = require('../scripts/workspace-document.cjs');

const fixturePath = path.join(__dirname, '..', 'fixtures', 'product-concept-set.json');
const schemaPath = path.join(__dirname, '..', 'schemas', 'product-workspace.schema.json');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function fixture() {
  return readJson(fixturePath);
}

function productValidator() {
  assert.equal(
    fs.existsSync(schemaPath),
    true,
    'Product Concept Studio must own product-workspace.schema.json',
  );
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  return ajv.compile(readJson(schemaPath));
}

function assertValid(validate, value, message) {
  assert.equal(validate(value), true, `${message}: ${JSON.stringify(validate.errors)}`);
}

test('representative Product Concept Studio fixture is one normalized product Visual Document', () => {
  const document = fixture();
  const normalized = normalizeWorkspaceDocument(document, {
    contentValidator(content, context) {
      assert.equal(context.workspace_kind, 'product');
      return structuredClone(content);
    },
  });

  assert.deepEqual(normalized, document);
  assert.equal(document.workspace_kind, 'product');
  assert.deepEqual(document.evidence_refs, [{
    id: 'EVD-001-design-direction-approval',
    label: 'Approved device-aware triptych',
  }]);
  assert.deepEqual(document.frames.map(frame => frame.id), ['compare', 'focus']);
});

test('A/B/C concepts share one device, scope, fidelity, and data fixture by construction', () => {
  const { content } = fixture();

  assert.equal(content.concepts.length, 3);
  assert.deepEqual(content.concepts.map(concept => concept.slot), ['A', 'B', 'C']);
  assert.deepEqual(content.concepts.map(concept => concept.id), ['concept-a', 'concept-b', 'concept-c']);
  assert.deepEqual(
    Object.keys(content.fixture).sort(),
    ['data', 'device', 'fidelity', 'id', 'scope'],
  );
  assert.equal(content.fixture.device, 'responsive_web');
  assert.equal(content.fixture.scope, 'Review and acknowledge one Feedback Batch');
  assert.equal(content.fixture.fidelity, 'interaction_detailed');
  assert.equal(content.fixture.data.feedback_batches.length, 3);

  for (const concept of content.concepts) {
    for (const duplicateFixtureField of ['device', 'scope', 'fidelity', 'data', 'fixture']) {
      assert.equal(
        Object.hasOwn(concept, duplicateFixtureField),
        false,
        `${concept.id} must consume the shared fixture instead of overriding ${duplicateFixtureField}`,
      );
    }
  }
});

test('concept strategies differ materially and preserve the approved width strategy', () => {
  const { content } = fixture();
  const strategies = content.concepts.map(concept => concept.strategy);

  assert.equal(new Set(strategies.map(strategy => strategy.id)).size, 3);
  for (const strategy of strategies) {
    assert.match(strategy.summary, /\S/);
    assert.ok(
      ['information_architecture', 'interaction_model'].includes(strategy.difference_kind),
      `${strategy.id} must differ in information architecture or interaction model`,
    );
  }
  assert.deepEqual(content.layout_direction, {
    id: 'device-aware-triptych',
    mobile: 'three_up',
    desktop: 'stacked_with_difference_lens',
    evidence_ref: 'EVD-001-design-direction-approval',
  });
  assert.deepEqual(
    content.difference_lens.dimensions.map(dimension => Object.keys(dimension.values)),
    Array.from({ length: 3 }, () => ['concept-a', 'concept-b', 'concept-c']),
  );
});

test('recommendation disclosure, single Choice, and selected-concept handoff are explicit', () => {
  const document = fixture();
  const { content } = document;
  const conceptIds = content.concepts.map(concept => concept.id);

  assert.equal(content.recommendation.disclosure, 'after_inspection_or_provisional_choice');
  assert.ok(conceptIds.includes(content.recommendation.concept_id));
  assert.deepEqual(document.decisions, [{
    id: 'product-concept-choice',
    title: 'Choose one product concept',
    multiselect: false,
    option_component_ids: conceptIds,
  }]);

  for (const concept of content.concepts) {
    assert.deepEqual(concept.focus.states.map(state => state.id), ['default', 'loading', 'empty', 'error']);
    assert.deepEqual(concept.focus.responsive.map(state => state.viewport), ['mobile', 'desktop']);
    assert.ok(concept.focus.accessibility.keyboard_order.length > 0);
    assert.ok(concept.focus.accessibility.announcements.length > 0);
    assert.match(concept.focus.accessibility.reduced_motion, /\S/);
    assert.ok(concept.focus.handoff.component_boundaries.length > 0);
    assert.ok(concept.focus.handoff.data_contracts.length > 0);
    assert.ok(concept.focus.handoff.events.length > 0);
    assert.ok(concept.focus.handoff.implementation_notes.length > 0);
  }
});

test('Product Workspace Kind schema validates the representative content contract', () => {
  const validate = productValidator();
  assertValid(validate, fixture().content, 'representative Product content must validate');
});

test('Product Workspace Kind schema rejects fixture drift, cosmetic-only concepts, and incomplete focus handoff', () => {
  const validate = productValidator();
  const candidates = [];

  const duplicateDevice = structuredClone(fixture().content);
  duplicateDevice.concepts[0].device = 'mobile';
  candidates.push(['per-concept fixture override', duplicateDevice]);

  const cosmeticOnly = structuredClone(fixture().content);
  cosmeticOnly.concepts[1].strategy.difference_kind = 'visual_style';
  candidates.push(['cosmetic-only strategy', cosmeticOnly]);

  const earlyRecommendation = structuredClone(fixture().content);
  earlyRecommendation.recommendation.disclosure = 'always_visible';
  candidates.push(['early recommendation', earlyRecommendation]);

  const incompleteFocus = structuredClone(fixture().content);
  delete incompleteFocus.concepts[2].focus.handoff;
  candidates.push(['missing handoff', incompleteFocus]);

  const twoConcepts = structuredClone(fixture().content);
  twoConcepts.concepts.pop();
  candidates.push(['two-concept comparison', twoConcepts]);

  for (const [name, candidate] of candidates) {
    assert.equal(validate(candidate), false, `${name} must be rejected by the product schema`);
  }
});
