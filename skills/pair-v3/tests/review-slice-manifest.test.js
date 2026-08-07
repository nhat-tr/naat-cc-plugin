// What a Review Slice asks the running program is a design decision, so the manifest has to carry it — and
// a slice that asks nothing has to say why.
//
// AC-3: a Review Slice accepts an optional `probe`, and a slice without one is rejected unless it carries a
//       `probe_waived` reason.

const assert = require('node:assert/strict');
const test = require('node:test');

const { validateManifest } = require('../scripts/lib/review-slice-manifest');

const SPEC = '# Spec\n\n## Acceptance Criteria\n\n- [ ] AC-1: value becomes two\n';

function manifest(slice) {
  return {
    schema: 1,
    work_id: 'work-probe',
    slices: [{
      id: 'S1',
      acceptance_criteria: ['AC-1'],
      outcome: 'Existing value returns two.',
      depends_on: [],
      verify: 'node verify.js',
      ...slice,
    }],
  };
}

test('a Review Slice carries the question it will ask the running program', () => {
  const validated = validateManifest(manifest({ probe: 'curl -fsS http://localhost:5080/health' }), SPEC, null, { runtimeDeclared: true });

  assert.equal(validated.manifest.slices[0].probe, 'curl -fsS http://localhost:5080/health');
});

test('a Review Slice with nothing to ask is rejected when the repository declares a runtime', () => {
  assert.throws(
    () => validateManifest(manifest({}), SPEC, null, { runtimeDeclared: true }),
    /S1 requires a probe/u,
  );
});

test('a stated reason stands in for the probe', () => {
  const validated = validateManifest(
    manifest({ probe_waived: 'This slice only changes the manifest validator, which the running program never loads.' }),
    SPEC,
    null,
    { runtimeDeclared: true },
  );

  assert.equal(validated.manifest.slices[0].probe_waived.startsWith('This slice only changes'), true);
  assert.equal(validated.manifest.slices[0].probe, undefined);
});

test('declaring both a probe and a waiver is rejected', () => {
  assert.throws(
    () => validateManifest(manifest({ probe: 'curl -fsS http://localhost:5080/health', probe_waived: 'nothing to ask' }), SPEC, null, { runtimeDeclared: true }),
    /declares both probe and probe_waived/u,
  );
});

test('an empty waiver reason is rejected, because a waiver is the reason', () => {
  assert.throws(() => validateManifest(manifest({ probe_waived: '   ' }), SPEC, null, { runtimeDeclared: true }), /probe_waived/u);
});

// The obligation arrives with the declaration. A repository that has never said how to start its program
// cannot be asked to observe it, and every manifest written before runtime observation existed keeps
// validating — byte for byte, so its digest is unchanged and no Work in flight is disturbed.
test('a repository with no runtime declaration owes no probe', () => {
  const before = validateManifest(manifest({}), SPEC);

  assert.equal(before.manifest.slices[0].probe, undefined);
  assert.equal(before.manifest.slices[0].probe_waived, undefined);
  assert.equal(before.digest, validateManifest(manifest({}), SPEC, null, {}).digest);
});
