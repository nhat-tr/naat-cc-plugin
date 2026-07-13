const assert = require('node:assert/strict');
const test = require('node:test');

const { evaluateQualityContract } = require('../scripts/work-lineage.cjs');

const workId = 'work-20260712-visual-companion-vnext';
const protectedDomains = ['security', 'privacy', 'accessibility', 'safety', 'compliance'];

function obligation(overrides = {}) {
  return {
    id: 'EQC-PERF',
    quality: 'performance',
    activation: 'fact',
    activationFacts: ['large_graph'],
    impact: 'ordinary',
    owner: 'Frontend reviewer',
    status: 'inactive',
    ...overrides,
  };
}

function exclusion(overrides = {}) {
  return {
    obligationId: 'EQC-PERF',
    status: 'not_applicable',
    evidence: ['evidence/performance-analysis.md'],
    decider: 'product-owner',
    reviewer: 'senior-reviewer',
    owner: 'frontend-owner',
    residualRisk: 'Large fixtures may still regress.',
    approval: { state: 'approved', approvedBy: 'user', provenanceId: 'APR-001' },
    ...overrides,
  };
}

function approvalVerifier({
  approvedBy = 'user',
  authority = 'user',
  domain = null,
  provenanceId = 'APR-001',
} = {}) {
  return approval => approval.provenanceId === provenanceId
    ? { approvedBy, authority, domain }
    : null;
}

function evaluate({
  target = obligation(),
  excluded = exclusion(),
  facts = target.activationFacts,
  verifyApproval = approvalVerifier(),
} = {}) {
  return evaluateQualityContract({
    workId,
    facts,
    obligations: [target],
    exclusions: excluded ? [excluded] : [],
  }, { verifyApproval });
}

test('engineering quality contract activates obligations from observed change facts', () => {
  const result = evaluate({ excluded: null });

  assert.equal(result.obligations[0].status, 'open');
  assert.deepEqual(result.obligations[0].activatedBy, ['large_graph']);
  assert.equal(result.canClose, false);
});

test('engineering quality contract accepts an ordinary user exclusion only with complete governance evidence', () => {
  const accepted = evaluate();

  assert.equal(accepted.obligations[0].status, 'not_applicable');
  assert.equal(accepted.canClose, true);

  const invalidRecords = [
    ['evidence', { evidence: [] }],
    ['decider', { decider: '' }],
    ['reviewer', { reviewer: '  ' }],
    ['owner', { owner: '' }],
    ['residualRisk', { residualRisk: '' }],
    ['approval', { approval: null }],
    ['approval state', { approval: { approvedBy: 'user', provenanceId: 'APR-001' } }],
    ['approvedBy', { approval: { state: 'approved', approvedBy: '', provenanceId: 'APR-001' } }],
    ['provenance', { approval: { state: 'approved', approvedBy: 'user', provenanceId: '' } }],
  ];

  for (const [label, overrides] of invalidRecords) {
    assert.throws(
      () => evaluate({ excluded: exclusion(overrides) }),
      new RegExp(label.replace(' ', '|'), 'i'),
    );
  }
});

test('engineering quality contract never lets automation clear an obligation', () => {
  const automated = evaluate({
    excluded: exclusion({
      approval: {
        state: 'approved',
        approvedBy: 'quality-scanner',
        provenanceId: 'APR-automation',
      },
    }),
    verifyApproval: approvalVerifier({
      approvedBy: 'quality-scanner',
      authority: 'automation',
      provenanceId: 'APR-automation',
    }),
  });

  assert.equal(automated.obligations[0].status, 'open');
  assert.equal(automated.canClose, false);
});

test('engineering quality contract keeps pending and rejected exclusions open', () => {
  for (const state of ['pending', 'rejected']) {
    const result = evaluate({
      excluded: exclusion({ approval: { state, approvedBy: 'user', provenanceId: 'APR-001' } }),
    });

    assert.equal(result.obligations[0].status, 'open');
    assert.equal(result.canClose, false);
  }
});

test('engineering quality contract keeps explicit always-on and previously active obligations open', () => {
  for (const target of [
    obligation({ activation: 'always', activationFacts: [], status: 'active' }),
    obligation({ activation: 'fact', activationFacts: ['large_graph'], status: 'active' }),
    obligation({ activation: 'fact', activationFacts: ['large_graph'], status: 'open' }),
    obligation({ activation: 'fact', activationFacts: ['large_graph'], status: 'not_applicable' }),
  ]) {
    const result = evaluate({ target, facts: [], excluded: null });
    assert.equal(result.obligations[0].status, 'open');
    assert.equal(result.canClose, false);
  }
});

test('engineering quality contract rejects forged authority, duplicate records, and unknown exclusions', () => {
  assert.throws(
    () => evaluate({
      excluded: exclusion({
        approval: {
          state: 'approved',
          approvedBy: 'security-codeowner',
          provenanceId: 'APR-forged',
          authority: 'CODEOWNER',
          domain: 'security',
        },
      }),
      verifyApproval: null,
    }),
    /unsupported field|authority/i,
  );

  const missingProvenance = evaluate({ verifyApproval: null });
  assert.equal(missingProvenance.obligations[0].status, 'open');
  assert.equal(missingProvenance.obligations[0].exclusion.state, 'approval_provenance_required');

  assert.throws(
    () => evaluateQualityContract({
      workId,
      facts: ['large_graph'],
      obligations: [obligation(), obligation()],
      exclusions: [],
    }),
    /duplicate.*obligation/i,
  );
  assert.throws(
    () => evaluateQualityContract({
      workId,
      facts: ['large_graph'],
      obligations: [obligation()],
      exclusions: [exclusion(), exclusion()],
    }),
    /duplicate.*exclusion/i,
  );
  assert.throws(
    () => evaluateQualityContract({
      workId,
      facts: ['large_graph'],
      obligations: [obligation()],
      exclusions: [exclusion({ obligationId: 'EQC-UNKNOWN' })],
    }),
    /unknown obligation/i,
  );
});

test('engineering quality contract requires matching specialist approval for every protected domain', () => {
  for (const domain of protectedDomains) {
    const fact = `protected_${domain}_change`;
    const target = obligation({
      id: `EQC-${domain.toUpperCase()}`,
      quality: domain,
      activation: 'fact',
      activationFacts: [fact],
      impact: 'high',
      owner: `${domain} owner`,
    });
    const baseExclusion = {
      obligationId: target.id,
      approval: { state: 'approved', approvedBy: 'user', provenanceId: 'APR-001' },
    };

    const userOnly = evaluate({ target, facts: [fact], excluded: exclusion(baseExclusion) });
    assert.equal(userOnly.obligations[0].status, 'open');
    assert.equal(userOnly.obligations[0].exclusion.state, 'domain_approval_required');
    assert.equal(userOnly.canClose, false);

    const wrongDomain = domain === 'security' ? 'privacy' : 'security';
    const mismatched = evaluate({
      target,
      facts: [fact],
      excluded: exclusion({
        ...baseExclusion,
        approval: {
          state: 'approved',
          approvedBy: `${wrongDomain}-codeowner`,
          provenanceId: 'APR-wrong-domain',
        },
      }),
      verifyApproval: approvalVerifier({
        approvedBy: `${wrongDomain}-codeowner`,
        authority: 'CODEOWNER',
        domain: wrongDomain,
        provenanceId: 'APR-wrong-domain',
      }),
    });
    assert.equal(mismatched.obligations[0].status, 'open');
    assert.equal(mismatched.canClose, false);

    for (const authority of ['CODEOWNER', 'domain_owner']) {
      const provenanceId = `APR-${domain}-${authority.replace('_', '-')}`;
      const approved = evaluate({
        target,
        facts: [fact],
        excluded: exclusion({
          ...baseExclusion,
          approval: {
            state: 'approved',
            approvedBy: `${domain}-${authority.toLowerCase()}`,
            provenanceId,
          },
        }),
        verifyApproval: approvalVerifier({
          approvedBy: `${domain}-${authority.toLowerCase()}`,
          authority,
          domain,
          provenanceId,
        }),
      });

      assert.equal(approved.obligations[0].status, 'not_applicable');
      assert.equal(approved.canClose, true);
    }
  }
});
