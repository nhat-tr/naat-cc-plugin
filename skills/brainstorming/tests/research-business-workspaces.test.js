'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const Ajv = require('ajv/dist/2020');

const { normalizeWorkspaceDocument, documentRevision } = require('../scripts/workspace-document.cjs');

const SCHEMA_DIR = path.join(__dirname, '..', 'schemas');
const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures');

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// The per-kind JSON Schema is the authoritative content contract. It is injected
// into normalizeWorkspaceDocument as a contentValidator exactly the way the
// server/CLI composition layer wires it, so the same shape guards fixtures,
// runtime publishing, and standalone export.
function contentValidatorFor(kind) {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(loadJson(path.join(SCHEMA_DIR, `${kind}-workspace.schema.json`)));
  return content => {
    if (!validate(content)) {
      throw new TypeError(`${kind} content is invalid: ${ajv.errorsText(validate.errors)}`);
    }
    return content;
  };
}

function researchFixture() {
  return loadJson(path.join(FIXTURE_DIR, 'research-evidence.json'));
}

function businessFixture() {
  return loadJson(path.join(FIXTURE_DIR, 'business-reasoning.json'));
}

function componentIds(document) {
  return new Set(document.components.map(component => component.id));
}

function evidenceIds(document) {
  return new Set(document.evidence_refs.map(reference => reference.id));
}

test('the research fixture normalizes against its schema and is canonical on a second pass', () => {
  const validator = contentValidatorFor('research');
  const first = normalizeWorkspaceDocument(researchFixture(), { contentValidator: validator });
  const second = normalizeWorkspaceDocument(first, { contentValidator: validator });
  assert.equal(first.version, 2);
  assert.equal(first.workspace_kind, 'research');
  assert.equal(first.revision, documentRevision(first));
  assert.deepEqual(second, first);
});

test('the business fixture normalizes against its schema and is canonical on a second pass', () => {
  const validator = contentValidatorFor('business');
  const first = normalizeWorkspaceDocument(businessFixture(), { contentValidator: validator });
  const second = normalizeWorkspaceDocument(first, { contentValidator: validator });
  assert.equal(first.version, 2);
  assert.equal(first.workspace_kind, 'business');
  assert.equal(first.content.journey_spine, true);
  assert.deepEqual(second, first);
});

test('research claims each link at least one source and carry a known confidence band', () => {
  const validator = contentValidatorFor('research');
  const bands = new Set(['high', 'medium', 'low']);
  for (const claim of researchFixture().content.claims) {
    assert.ok(Array.isArray(claim.source_refs) && claim.source_refs.length >= 1, `claim ${claim.component_id} must cite a source`);
    assert.ok(bands.has(claim.confidence), `claim ${claim.component_id} has an unknown confidence band`);
  }
  // A claim with no source is an unsourced summary and must be rejected (AC-4).
  const doc = researchFixture();
  doc.content.claims[0] = { component_id: doc.content.claims[0].component_id, confidence: 'high', source_refs: [] };
  assert.throws(() => normalizeWorkspaceDocument(doc, { contentValidator: validator }), /invalid/i);
});

test('research unknowns are never presented as evidence (no sources) and an unknown with sources is rejected', () => {
  const validator = contentValidatorFor('research');
  for (const unknown of researchFixture().content.unknowns) {
    assert.equal(unknown.source_refs, undefined, `unknown ${unknown.component_id} must not carry sources`);
  }
  const doc = researchFixture();
  doc.content.unknowns[0].source_refs = ['EVD-wait-durability'];
  assert.throws(() => normalizeWorkspaceDocument(doc, { contentValidator: validator }), /invalid/i);
});

test('research content ids, sources, and contradictions resolve to real components and evidence', () => {
  const document = researchFixture();
  const components = componentIds(document);
  const evidence = evidenceIds(document);
  const claimIds = new Set(document.content.claims.map(claim => claim.component_id));
  for (const claim of document.content.claims) {
    assert.ok(components.has(claim.component_id), `claim ${claim.component_id} is not a component`);
    for (const source of claim.source_refs) assert.ok(evidence.has(source), `source ${source} is not an evidence ref`);
    for (const other of claim.contradicts || []) assert.ok(claimIds.has(other), `contradiction ${other} is not a claim`);
  }
  for (const unknown of document.content.unknowns) {
    assert.ok(components.has(unknown.component_id), `unknown ${unknown.component_id} is not a component`);
  }
});

test('an unsupported research confidence band is rejected by the schema', () => {
  const validator = contentValidatorFor('research');
  const doc = researchFixture();
  doc.content.claims[0].confidence = 'certain';
  assert.throws(() => normalizeWorkspaceDocument(doc, { contentValidator: validator }), /invalid/i);
});

test('business stages carry known reasoning kinds and resolve to real components', () => {
  const validator = contentValidatorFor('business');
  const document = businessFixture();
  const components = componentIds(document);
  const kinds = new Set(['assumption', 'economics', 'risk', 'experiment', 'outcome', 'evidence']);
  for (const stage of document.content.stages) {
    assert.ok(components.has(stage.component_id), `stage ${stage.component_id} is not a component`);
    for (const item of stage.items) assert.ok(kinds.has(item.kind), `reasoning kind ${item.kind} is not supported`);
  }
  const doc = businessFixture();
  doc.content.stages[0].items[0].kind = 'vibe';
  assert.throws(() => normalizeWorkspaceDocument(doc, { contentValidator: validator }), /invalid/i);
});

test('business actors and outcomes lead the reading order and are referenced by stages', () => {
  const document = businessFixture();
  assert.ok(document.content.actors.length >= 1, 'business reasoning must name at least one actor');
  assert.ok(document.content.outcomes.length >= 1, 'business reasoning must name at least one outcome');
  const actorIds = new Set(document.content.actors.map(actor => actor.id));
  const outcomeIds = new Set(document.content.outcomes.map(outcome => outcome.id));
  for (const stage of document.content.stages) {
    if (stage.actor_id !== undefined) assert.ok(actorIds.has(stage.actor_id), `stage actor ${stage.actor_id} is undefined`);
    if (stage.outcome_id !== undefined) assert.ok(outcomeIds.has(stage.outcome_id), `stage outcome ${stage.outcome_id} is undefined`);
  }
});

test('the business journey spine is optional so proposition-shaped documents stay valid', () => {
  const validator = contentValidatorFor('business');
  const doc = businessFixture();
  doc.content.journey_spine = false;
  doc.revision = documentRevision(doc);
  const normalized = normalizeWorkspaceDocument(doc, { contentValidator: validator });
  assert.equal(normalized.content.journey_spine, false);
});
