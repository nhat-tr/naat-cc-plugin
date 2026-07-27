const crypto = require('node:crypto');

const WORK_ID = 'work-20260727-compiled-pair-plan';
const EVIDENCE_ID = 'EVD-001-implementation-design';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalSpec(workId = WORK_ID) {
  return [
    '# Compiled Pair plan',
    '',
    `- **Work ID:** \`${workId}\``,
    '',
    '## Acceptance Criteria',
    '',
    '- AC-1: the command prints the requested greeting.',
    '',
    '## Engineering Quality Contract',
    '',
    'The command boundary remains covered by an integration test and no new command framework is introduced.',
    '',
  ].join('\n');
}

function implementationDesignRecord({
  workId = WORK_ID,
  spec = canonicalSpec(workId),
  decisionOverrides = {},
  resultOverrides = {},
} = {}) {
  const specPath = `docs/work/${workId}/spec.md`;
  return {
    schema: 1,
    id: EVIDENCE_ID,
    work_id: workId,
    kind: 'implementation-design-contract',
    acceptance_criteria: ['AC-1'],
    decision_record_ids: [],
    source: 'pair-promote/repository-grounding',
    recorded_at: '2026-07-27T10:00:00.000Z',
    result: {
      schema: 1,
      spec: { path: specPath, sha256: sha256(spec) },
      repository_evidence: [
        { path: 'src/commands/help.js', symbols: ['registerHelp'] },
        { path: 'package.json', symbols: ['scripts'] },
      ],
      decisions: [
        {
          id: 'IMP-001',
          outcome: 'Dispatch the requested greeting through the existing command table.',
          acceptance_criteria: ['AC-1'],
          depends_on: [],
          symbols: [
            { path: 'src/greeting.js', symbol: 'greet(name)', action: 'add' },
            { path: 'src/commands/greeting.js', symbol: 'registerGreeting(registry)', action: 'add' },
          ],
          call_paths: ['command table -> registerGreeting -> greet(name) -> stdout'],
          contract: {
            before: ['The greeting command is absent from dispatch.'],
            after: ['greet(name) returns the requested greeting and command dispatch prints it.'],
            errors: ['Existing command error propagation remains unchanged.'],
          },
          data_shapes: ['greet(name: string): string; no new DTO or serialized shape.'],
          state_flow: ['CLI argument -> greeting name -> returned string -> stdout'],
          wiring: ['Register registerGreeting in the existing command table.'],
          failure_handling: ['Do not catch or translate existing command-dispatch failures.'],
          deletions: [],
          pattern_references: [
            { path: 'src/commands/help.js', symbol: 'registerHelp' },
            { path: 'package.json', symbol: 'scripts' },
          ],
          tests: [
            {
              name: 'greeting command prints requested greeting',
              file: 'tests/greeting.integration.test.js',
              boundary: 'integration',
              purpose: 'Prove AC-1 through the real command boundary.',
              red_signal: 'command lookup reports that greeting is not registered',
            },
          ],
          verify: 'node --test tests/greeting.integration.test.js',
          non_goals: ['Do not introduce a general command framework.'],
          ...decisionOverrides,
        },
      ],
      ...resultOverrides,
    },
  };
}

function compiledPlan({
  workId = WORK_ID,
  spec = canonicalSpec(workId),
  designDigest = '0'.repeat(64),
  taskProfile = '[type:feature] [risk:medium] [scope:cross-module] [uncertainty:low] [ac:AC-1] [test:integration] · **M**',
  designIds = 'IMP-001',
} = {}) {
  const specPath = `docs/work/${workId}/spec.md`;
  const designPath = `docs/work/${workId}/evidence/${EVIDENCE_ID}.json`;
  return [
    '# Task: Add greeting command',
    '',
    '**Pair mode:** compiled',
    '',
    '## Intent Contract',
    `- **Spec:** \`${specPath}\` (\`sha256:${sha256(spec)}\`)`,
    `- **Implementation design:** \`${designPath}\` (\`sha256:${designDigest}\`)`,
    '- **Purpose:** Let a user request and receive a greeting.',
    '- **Repository evidence:** `src/commands/help.js#registerHelp` and `package.json`.',
    '- **Constraints:** Preserve the current command API; no new command framework.',
    '- **Verification:** `node --test tests/greeting.integration.test.js`',
    '',
    '## Streams',
    '### Stream 1: Greeting behavior',
    '- [ ] Task 1.1 — deliver the requested greeting through the real command boundary',
    `  - **Profile:** ${taskProfile}`,
    '  - **Files:** `tests/greeting.integration.test.js`, `src/greeting.js`, `src/commands/greeting.js`',
    '  - **Tests:** `tests/greeting.integration.test.js`',
    `  - **Design:** ${designIds}`,
    '  - **Verify:** `node --test tests/greeting.integration.test.js`',
    '',
    '## Acceptance Criteria',
    '- [ ] AC-1: the command prints the requested greeting.',
    '',
    '## Open Questions',
    '- None.',
  ].join('\n');
}

module.exports = {
  EVIDENCE_ID,
  WORK_ID,
  canonicalSpec,
  compiledPlan,
  implementationDesignRecord,
  sha256,
};
