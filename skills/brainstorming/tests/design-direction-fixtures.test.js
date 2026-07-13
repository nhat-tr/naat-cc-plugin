const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const { normalizeVisualDocument } = require('../scripts/visual-document.cjs');

const fixtureDirectory = path.join(__dirname, '..', 'fixtures', 'design-directions');

function visibleText(value, key = '') {
  if (typeof value === 'string') return key === 'id' || key === 'groupId' ? [] : [value];
  if (Array.isArray(value)) return value.flatMap(item => visibleText(item));
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([childKey, child]) => visibleText(child, childKey));
}

const directions = [
  {
    name: 'product',
    primary: /device-aware triptych/i,
    rival: /stacked.*difference lens/i,
  },
  {
    name: 'architecture',
    primary: /exclusive view modes/i,
    rival: /synced compare split.*sharing one layout/i,
  },
  {
    name: 'research',
    primary: /confidence columns/i,
    rival: /decision-relevance grouping/i,
  },
  {
    name: 'business',
    primary: /journey spine/i,
    rival: /proposition blocks/i,
    rivalQualifier: /spine optional/i,
  },
  {
    name: 'review',
    primary: /three-pane density/i,
    rival: /single-pane progressive drill-down/i,
  },
];

for (const direction of directions) {
  test(`${direction.name} design-direction fixture is a valid v1 document that presents both skeletons`, async () => {
    const fixturePath = path.join(fixtureDirectory, `${direction.name}.json`);
    const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
    const document = normalizeVisualDocument(fixture);

    assert.equal(document.version, 1);

    const visibleSkeleton = document.sections.filter(section => section.kind !== 'decision');
    assert.notEqual(visibleSkeleton.length, 0, 'fixture must show the primary skeleton outside its Decision');
    assert.match(visibleText(visibleSkeleton).join(' '), direction.primary);

    const decision = document.sections.find(section => section.kind === 'decision');
    assert.ok(decision, 'fixture must carry a decision section');

    const optionText = option => [option.label, option.detail, ...(option.points || [])].join(' ');
    const primary = decision.options.find(option => direction.primary.test(optionText(option)));
    const rival = decision.options.find(option => direction.rival.test(optionText(option)));

    assert.ok(primary, 'Decision must identify the primary skeleton semantically');
    assert.ok(rival, 'Decision must identify the strongest rival semantically');
    assert.notEqual(rival.id, primary.id);
    if (direction.rivalQualifier) assert.match(optionText(rival), direction.rivalQualifier);
  });
}
