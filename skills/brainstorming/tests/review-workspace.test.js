'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const Ajv2020 = require('ajv/dist/2020').default;

const {
  buildPatchSet,
  updatePatchSetReview,
} = require('../../pair-v3/scripts/review-index.cjs');
const { createBrainstormServer } = require('../scripts/server.cjs');
const {
  documentRevision,
  normalizeWorkspaceDocument,
} = require('../scripts/workspace-document.cjs');
const { normalizeKnownWorkspaceContent } = require('../scripts/workspace-content.cjs');
const { evaluateQualityContract } = require('../scripts/work-lineage.cjs');
const { createScratchDirectory } = require('./test-support');

const FIXTURE_PATH = path.resolve(__dirname, '../fixtures/feature-review-work.json');
const REVIEW_SCHEMA_PATH = path.resolve(__dirname, '../schemas/review-workspace.schema.json');
const REVIEW_DATA_PATH = path.resolve(__dirname, '../scripts/review-workspace-data.cjs');
const CAPABILITY = 'review-workspace-current-capability';
const STALE_CAPABILITY = 'review-workspace-stale-capability';
const PRIVATE_VALUE = 'review-workspace-private-value';

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function reviewFixture() {
  return loadJson(FIXTURE_PATH);
}

function compileReviewSchema() {
  assert.ok(
    fs.existsSync(REVIEW_SCHEMA_PATH),
    'Task 10.3 must provide the Review Workspace content schema',
  );
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(loadJson(REVIEW_SCHEMA_PATH));
  return { ajv, validate };
}

function contentValidator(validate, ajv) {
  return content => {
    if (!validate(content)) {
      throw new TypeError(`review content is invalid: ${ajv.errorsText(validate.errors)}`);
    }
    return content;
  };
}

function indexedPatchSetReview(projected) {
  const { file_reviews: fileReviews, ...review } = structuredClone(projected);
  return {
    ...review,
    files: Object.fromEntries(fileReviews.map(({ path: filePath, ...state }) => [filePath, state])),
  };
}

function projectLocally(indexed) {
  const { files, ...review } = structuredClone(indexed);
  return {
    ...review,
    file_reviews: Object.entries(files).map(([filePath, state]) => ({ path: filePath, ...state })),
  };
}

function knownEvidenceIds(document) {
  return new Set(document.evidence_refs.map(reference => reference.id));
}

function assertRepositoryPath(value, label) {
  assert.equal(path.isAbsolute(value), false, `${label} must be repository-relative`);
  assert.equal(value.split('/').includes('..'), false, `${label} must not traverse outside the repository`);
}

test('the representative Review document normalizes canonically against a strict per-kind schema', () => {
  const fixture = reviewFixture();
  const { ajv, validate } = compileReviewSchema();
  const validateContent = contentValidator(validate, ajv);
  const first = normalizeWorkspaceDocument(fixture, { contentValidator: validateContent });
  const second = normalizeWorkspaceDocument(first, { contentValidator: validateContent });

  assert.equal(first.workspace_kind, 'review');
  assert.equal(first.revision, documentRevision(first));
  assert.deepEqual(second, first);

  const invalidDocuments = [
    document => { delete document.content.review_slices[0].actual_changes[0].symbols; },
    document => { document.content.patch_set_review.file_reviews[0].path = '../private-value'; },
    document => { delete document.content.quality_contract.canClose; },
    document => { document.content.decision_records[0].status = 'draft'; },
    document => { document.content.outcomes[0].decision_record_ids = []; },
  ];
  for (const mutate of invalidDocuments) {
    const candidate = reviewFixture();
    mutate(candidate);
    assert.equal(validate(candidate.content), false, 'the Review schema must reject an incomplete semantic projection');
  }
});

test('runtime composition treats Review content as a typed projection rather than opaque JSON', () => {
  const fixture = reviewFixture();
  assert.doesNotThrow(() => normalizeWorkspaceDocument(fixture, {
    contentValidator: normalizeKnownWorkspaceContent,
  }));

  const candidate = reviewFixture();
  candidate.content.unowned_review_state = { status: 'looks_valid' };
  candidate.revision = documentRevision(candidate);
  assert.throws(
    () => normalizeWorkspaceDocument(candidate, { contentValidator: normalizeKnownWorkspaceContent }),
    /review Workspace content is invalid|additional properties|unsupported/i,
  );
});

test('Review projection preserves the indexed Patch Set contract without path-keyed content fields', () => {
  assert.ok(
    fs.existsSync(REVIEW_DATA_PATH),
    'Task 10.3 must provide the Review Workspace projection module',
  );
  const reviewData = require(REVIEW_DATA_PATH);
  assert.equal(
    typeof reviewData.projectPatchSetReview,
    'function',
    'review-workspace-data.cjs must export projectPatchSetReview',
  );

  const fixture = reviewFixture();
  const indexed = indexedPatchSetReview(fixture.content.patch_set_review);
  const projected = reviewData.projectPatchSetReview(indexed);
  assert.deepEqual(projected, fixture.content.patch_set_review);
  assert.equal(Object.hasOwn(projected, 'files'), false, 'repository paths must not become JSON field names');
  assert.ok(projected.file_reviews.every(file => typeof file.path === 'string'));
});

test('spec intent resolves through stable Review Slices to full-path actual and verification evidence', () => {
  const fixture = reviewFixture();
  const content = fixture.content;
  const evidenceIds = knownEvidenceIds(fixture);
  const componentIds = new Set(fixture.components.map(component => component.id));
  const sourceByComponent = new Map(content.review_slices
    .flatMap(slice => slice.actual_changes)
    .map(source => [source.component_id, source]));
  const verificationByEvidence = new Map(
    content.evidence_records.map(item => [item.id, item]),
  );

  const requiredCriteria = ['AC-6', 'AC-15', 'AC-16', 'AC-18'];
  const specCriteria = new Set(content.canonical_spec.acceptance_criteria.map(criterion => criterion.id));
  for (const criterion of requiredCriteria) {
    assert.ok(specCriteria.has(criterion), `${criterion} must be selectable from the canonical spec`);
    assert.ok(
      content.review_slices.some(slice => slice.acceptance_criteria.includes(criterion)),
      `${criterion} must resolve to a Review Slice`,
    );
  }

  for (const slice of content.review_slices) {
    assert.ok(componentIds.has(slice.component_id));
    assert.match(slice.task_id, /^\d+\.\d+$/u);
    assert.ok(slice.expected_files.length > 0);
    assert.match(slice.verification_command, /\S/u);
    for (const expectedFile of slice.expected_files) assertRepositoryPath(expectedFile, 'expected file');
    for (const actual of slice.actual_changes) {
      assertRepositoryPath(actual.path, 'actual file');
      assert.match(actual.hunk_id, /^[a-f0-9]{64}$/u);
      assert.ok(actual.symbols.length > 0, `${actual.path} must expose changed symbols`);
      assert.deepEqual(sourceByComponent.get(actual.component_id)?.path, actual.path);
      for (const evidenceId of actual.evidence_ids) {
        assert.ok(evidenceIds.has(evidenceId), `${actual.path} references unknown evidence ${evidenceId}`);
        assert.ok(verificationByEvidence.has(evidenceId), `${evidenceId} needs verification evidence state`);
      }
    }
  }

  assert.deepEqual(content.cross_slice_changes, [{
    path: 'skills/brainstorming/scripts/server.cjs',
    hunk_id: '2'.repeat(64),
    claimed_by: ['10.3', '10.4'],
  }]);
  assert.deepEqual(content.unmapped_changes, [{ path: 'README.md', hunk_id: '4'.repeat(64) }]);
});

test('Patch Set invalidation is selective and whole-feature verdict stays independent of File Viewed', () => {
  const fixture = reviewFixture();
  const { patch_set: patchSet, patch_set_review: projectedReview } = fixture.content;
  const { patch_set_id: embeddedPatchSetId, ...patchSetInput } = patchSet;
  assert.deepEqual(buildPatchSet(patchSetInput), patchSet);
  assert.equal(projectedReview.patch_set_id, embeddedPatchSetId);

  let allViewed = indexedPatchSetReview(projectedReview);
  for (const file of projectedReview.file_reviews.filter(file => !file.viewed)) {
    allViewed = updatePatchSetReview(allViewed, {
      type: 'file_viewed',
      patch_set_id: patchSet.patch_set_id,
      path: file.path,
    });
  }
  assert.deepEqual(allViewed.viewed_progress, { viewed: 4, total: 4 });
  assert.equal(allViewed.whole_feature_verdict.verdict, 'rejected');
  assert.equal(allViewed.can_approve, false, 'all files Viewed must not imply whole-feature approval');

  let previouslyViewed = indexedPatchSetReview(projectedReview);
  previouslyViewed = updatePatchSetReview(previouslyViewed, {
    type: 'file_viewed',
    patch_set_id: patchSet.patch_set_id,
    path: 'skills/brainstorming/scripts/server.cjs',
  });
  const nextPatchSet = buildPatchSet({
    ...patchSetInput,
    attempt_id: '10.3-attempt-002',
    head_tree: 'c'.repeat(40),
    files: patchSetInput.files.map(file => file.path === 'skills/brainstorming/scripts/server.cjs'
      ? { ...file, patch_digest: '5'.repeat(64) }
      : file),
  });
  const replaced = updatePatchSetReview(previouslyViewed, {
    type: 'patch_set_replaced',
    patch_set: nextPatchSet,
  });

  assert.equal(replaced.files['skills/brainstorming/scripts/server.cjs'].viewed, false);
  assert.equal(replaced.files['skills/brainstorming/tests/review-workspace.test.js'].viewed, true);
  assert.equal(replaced.acceptance_evidence['AC-15'].status, 'current');
  assert.equal(replaced.acceptance_evidence['AC-18'].status, 'outdated');
  assert.equal(replaced.whole_feature_verdict, null, 'a replaced Patch Set invalidates its cumulative verdict');
  assert.deepEqual(projectLocally(indexedPatchSetReview(projectedReview)), projectedReview);
});

test('quality governance, findings, Decision Records, and outcomes remain linked to Work evidence', () => {
  const fixture = reviewFixture();
  const content = fixture.content;
  const projectedQuality = content.quality_contract;
  const accessibility = projectedQuality.obligations.find(item => item.id === 'EQC-A11Y');
  const qualityInput = {
    workId: projectedQuality.workId,
    facts: projectedQuality.facts,
    obligations: projectedQuality.obligations.map(item => ({
      id: item.id,
      quality: item.quality,
      activation: item.activation,
      activationFacts: item.activationFacts,
      impact: item.impact,
      owner: item.owner,
      status: item.id === 'EQC-A11Y' ? 'active' : item.status,
    })),
    exclusions: [{
      obligationId: accessibility.exclusion.obligationId,
      status: accessibility.exclusion.status,
      evidence: accessibility.exclusion.evidence,
      decider: accessibility.exclusion.decider,
      reviewer: accessibility.exclusion.reviewer,
      owner: accessibility.exclusion.owner,
      residualRisk: accessibility.exclusion.residualRisk,
      approval: accessibility.exclusion.approval,
    }],
  };
  const domainApproved = evaluateQualityContract(qualityInput, {
    verifyApproval: approval => ({
      approvedBy: approval.approvedBy,
      authority: 'CODEOWNER',
      domain: 'accessibility',
    }),
  });
  assert.equal(domainApproved.obligations.find(item => item.id === 'EQC-A11Y').status, 'not_applicable');
  assert.equal(domainApproved.canClose, false, 'the always-on open obligation still vetoes closure');

  const wrongDomainAuthority = evaluateQualityContract(qualityInput, {
    verifyApproval: approval => ({
      approvedBy: approval.approvedBy,
      authority: 'user',
      domain: 'accessibility',
    }),
  });
  const vetoed = wrongDomainAuthority.obligations.find(item => item.id === 'EQC-A11Y');
  assert.equal(vetoed.status, 'open');
  assert.equal(vetoed.exclusion.state, 'domain_approval_required');

  const evidenceIds = knownEvidenceIds(fixture);
  const decisionIds = new Set(content.decision_records.map(record => record.id));
  assert.ok(content.findings.some(finding => finding.status === 'open' && finding.severity === 'high'));
  for (const record of content.decision_records) {
    assert.equal(record.status, 'accepted');
    for (const evidenceId of record.evidence_refs) assert.ok(evidenceIds.has(evidenceId));
  }
  for (const outcome of content.outcomes) {
    assert.equal(outcome.source, 'manual_review');
    for (const decisionId of outcome.decision_record_ids) assert.ok(decisionIds.has(decisionId));
    for (const evidenceId of outcome.evidence_refs) assert.ok(evidenceIds.has(evidenceId));
  }
});

async function authenticatedCookie(address) {
  const response = await fetch(address.connection_url);
  assert.equal(response.status, 200, await response.text());
  return response.headers.get('set-cookie').split(';')[0];
}

function assertSecretSafe(value, ...secrets) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of [CAPABILITY, STALE_CAPABILITY, PRIVATE_VALUE, ...secrets]) {
    assert.equal(serialized.includes(secret), false, `response exposed private value ${secret}`);
  }
}

function writeFile(repositoryRoot, relativePath, contents) {
  const file = path.join(repositoryRoot, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, { mode: 0o600 });
  return file;
}

test('authenticated Review endpoints resolve opaque evidence identities and confine source reads', async t => {
  const sessionDir = createScratchDirectory(t, 'review-workspace-server');
  const repositoryRoot = createScratchDirectory(t, 'review-workspace-repository');
  const outsideRoot = createScratchDirectory(t, 'review-workspace-outside');
  const sourceLines = Array.from({ length: 470 }, (_, index) => `server source line ${index + 1}`);
  sourceLines[401] = 'function createBrainstormServer(options = {}) {';
  writeFile(repositoryRoot, 'skills/brainstorming/scripts/server.cjs', `${sourceLines.join('\n')}\n`);
  const outsideFile = writeFile(outsideRoot, 'private-source.txt', PRIVATE_VALUE);
  const rendererPath = path.join(
    repositoryRoot,
    'skills/brainstorming/ui/workspaces/review/FeatureReviewWorkbench.tsx',
  );
  fs.mkdirSync(path.dirname(rendererPath), { recursive: true });
  fs.symlinkSync(outsideFile, rendererPath);

  const app = createBrainstormServer({
    sessionDir,
    repositoryRoot,
    token: CAPABILITY,
    sessionId: 'review-workspace-server-session',
    idleTimeoutMs: 60_000,
  });
  fs.writeFileSync(
    path.join(app.contentDir, 'workspace.json'),
    `${JSON.stringify(reviewFixture())}\n`,
    { mode: 0o600 },
  );
  fs.writeFileSync(
    path.join(app.stateDir, 'visual-format.json'),
    `${JSON.stringify({
      version: 1,
      active_version: 2,
      v1_document: 'content/screen.json',
      v2_document: 'content/workspace.json',
    })}\n`,
    { mode: 0o600 },
  );
  const address = await app.listen();
  t.after(() => app.close());
  const sourceUrl = `${address.url}${address.base_path}api/review/source?id=source-review-server`;
  const evidenceUrl = `${address.url}${address.base_path}api/review/evidence?id=EVD-004-review-server`;

  const unauthorized = await fetch(sourceUrl);
  assert.equal(unauthorized.status, 401);
  assertSecretSafe(await unauthorized.text(), sessionDir, repositoryRoot, outsideRoot);

  const stale = await fetch(sourceUrl, {
    headers: { Cookie: `brainstorm_session=${STALE_CAPABILITY}` },
  });
  assert.equal(stale.status, 401);
  assertSecretSafe(await stale.text(), sessionDir, repositoryRoot, outsideRoot);

  const cookie = await authenticatedCookie(address);
  const crossOrigin = await fetch(sourceUrl, {
    headers: { Cookie: cookie, Origin: 'https://untrusted.example' },
  });
  assert.equal(crossOrigin.status, 403);
  assertSecretSafe(await crossOrigin.text(), sessionDir, repositoryRoot, outsideRoot);

  const source = await fetch(sourceUrl, { headers: { Cookie: cookie } });
  assert.equal(source.status, 200, await source.clone().text());
  assert.match(source.headers.get('cache-control') || '', /no-store/u);
  const sourceBody = await source.json();
  assert.equal(sourceBody.source.id, 'source-review-server');
  assert.equal(sourceBody.source.path, 'skills/brainstorming/scripts/server.cjs');
  assert.equal(sourceBody.context.start_line, 402);
  assert.equal(sourceBody.context.lines[0].number, 402);
  assert.equal(sourceBody.context.lines[0].text, 'function createBrainstormServer(options = {}) {');
  assertSecretSafe(sourceBody, sessionDir, repositoryRoot, outsideRoot);

  const evidence = await fetch(evidenceUrl, { headers: { Cookie: cookie } });
  assert.equal(evidence.status, 200, await evidence.clone().text());
  assert.match(evidence.headers.get('cache-control') || '', /no-store/u);
  const evidenceBody = await evidence.json();
  assert.equal(evidenceBody.evidence.id, 'EVD-004-review-server');
  assert.equal(evidenceBody.verification.status, 'outdated');
  assertSecretSafe(evidenceBody, sessionDir, repositoryRoot, outsideRoot);

  const symlink = await fetch(
    `${address.url}${address.base_path}api/review/source?id=source-review-renderer`,
    { headers: { Cookie: cookie } },
  );
  assert.ok([400, 404].includes(symlink.status), 'symlink source evidence must be rejected');
  assertSecretSafe(await symlink.text(), sessionDir, repositoryRoot, outsideRoot);

  for (const unsafeUrl of [
    `${address.url}${address.base_path}api/review/source?path=../../private-source.txt`,
    `${address.url}${address.base_path}api/review/source?id=../../private-source.txt`,
    `${address.url}${address.base_path}api/review/evidence?id=EVD-999-unknown`,
  ]) {
    const response = await fetch(unsafeUrl, { headers: { Cookie: cookie } });
    assert.ok([400, 404].includes(response.status));
    assertSecretSafe(await response.text(), sessionDir, repositoryRoot, outsideRoot);
  }
});
