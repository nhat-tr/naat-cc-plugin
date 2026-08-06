// Per-process machine scope: the real machine lease is global, and parallel test files would refuse
// each other's verifications. Required before the engine, so the env var is set when pair-store reads it.
require('./helpers/isolate-machine-lease');

const assert = require('node:assert/strict');
const test = require('node:test');

const { verifyActiveSlice, warningIdentities } = require('../scripts/lib/pair-engine');
const { openTestWork } = require('./helpers/warm-work');

function openScratchWork(t, workId) {
  return openTestWork(t, { prefix: 'warnings', workId });
}

function fakeVerify(logDigest, warnings) {
  return { verify() { return { status: 0, duration_ms: 3, log_digest: logDigest, failing_tests: [], warnings }; }, hydrate() { return { hydrated: false }; } };
}

test('MSBuild/dotnet warning lines are read into stable <file>:<code> identities and deduplicated', () => {
  const dotnet = [
    "/src/Catalog/CatalogSync.cs(42,13): warning CS0168: The variable 'value' is declared but never used [/src/Catalog.csproj]",
    "/src/Catalog/CatalogSync.cs(42,13): warning CS0168: The variable 'value' is declared but never used [/src/Catalog.csproj]",
    "/src/Catalog/CatalogFacet.cs(10,5): warning CS8632: The annotation for nullable reference types should only be used in code within a '#nullable' annotations context.",
    'Build succeeded.',
    '    0 Warning(s)',
  ].join('\n');
  assert.deepEqual(warningIdentities(dotnet), ['CatalogFacet.cs:CS8632', 'CatalogSync.cs:CS0168']);
  assert.deepEqual(warningIdentities('Build succeeded.\n0 Warning(s)'), []);
});

// A run's warning count varies with cache state and machine, so treating every warning on the first
// verification as "introduced by this Work" would blame it for warnings it never wrote. The first
// verification for a Work is a capture, not a comparison.
test('the first verification for a Work captures its warnings as the baseline and introduces none', t => {
  const opened = openScratchWork(t, 'work-warnings-first');
  const { report } = verifyActiveSlice(opened.worktree, { workId: 'work-warnings-first' },
    fakeVerify('a'.repeat(64), ['File.cs:CS0168']));

  assert.deepEqual(report.introduced_warnings, [],
    'the first verification for a Work sets the baseline rather than reporting against one');
});

test('a warning identity absent from the first-run baseline is reported as introduced', t => {
  const opened = openScratchWork(t, 'work-warnings-introduced');
  verifyActiveSlice(opened.worktree, { workId: 'work-warnings-introduced' },
    fakeVerify('b'.repeat(64), ['File.cs:CS0168']));

  const { report } = verifyActiveSlice(opened.worktree, { workId: 'work-warnings-introduced' },
    fakeVerify('c'.repeat(64), ['File.cs:CS0168', 'Other.cs:CS8632']));

  assert.deepEqual(report.introduced_warnings, ['Other.cs:CS8632'],
    "a warning the Work's first verification never saw is this Work's to own");
});

test('a warning already present in the baseline is never re-reported as introduced', t => {
  const opened = openScratchWork(t, 'work-warnings-baselined');
  verifyActiveSlice(opened.worktree, { workId: 'work-warnings-baselined' },
    fakeVerify('d'.repeat(64), ['File.cs:CS0168']));

  const { report } = verifyActiveSlice(opened.worktree, { workId: 'work-warnings-baselined' },
    fakeVerify('e'.repeat(64), ['File.cs:CS0168']));

  assert.deepEqual(report.introduced_warnings, [], 'the same pre-existing warning stays baselined across runs');
});
