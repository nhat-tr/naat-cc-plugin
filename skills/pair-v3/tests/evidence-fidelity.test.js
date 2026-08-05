const assert = require('node:assert/strict');
const test = require('node:test');

const { acceptanceCriteriaFromSpec } = require('../scripts/lib/review-slice-manifest');
const { redactString, sanitizeValue } = require('../scripts/lib/pair-store');
const checkpointRedaction = require('../scripts/lib/pair-state');

test('a wrapped Acceptance Criterion reaches prompts whole rather than cut at its first line', () => {
  const spec = [
    '## Acceptance Criteria',
    '',
    '- [ ] AC-5: facets are sourced from v1 `attributes(filter:{classificationTypeKeys:["HoClass"]})`; no',
    '  query anywhere selects `characteristics`, and no query fans out over `Product.articles`.',
    '- [ ] AC-6: sync is two-phase — a product walk and a batched representative-article read — and the',
    '  two facet sets merge into one `facets` value.',
    '',
    'Prose after the list must not be swallowed.',
  ].join('\n');
  const criteria = acceptanceCriteriaFromSpec(spec);
  assert.match(criteria.get('AC-5'), /no query anywhere selects `characteristics`/u);
  assert.match(criteria.get('AC-5'), /fans out over `Product\.articles`\.$/u);
  assert.match(criteria.get('AC-6'), /merge into one `facets` value\.$/u);
  assert.equal(criteria.size, 2);
});

test('a single-line Acceptance Criterion and a repeated identifier keep their existing behaviour', () => {
  const criteria = acceptanceCriteriaFromSpec('- [ ] AC-1: value becomes two\n- [x] AC-2: done\n');
  assert.equal(criteria.get('AC-1'), 'value becomes two');
  assert.equal(criteria.get('AC-2'), 'done');
  assert.throws(
    () => acceptanceCriteriaFromSpec('- [ ] AC-1: one\n- [ ] AC-1: again\n'),
    /repeats AC-1/u,
  );
  assert.throws(() => acceptanceCriteriaFromSpec('# Spec with no criteria\n'), /no Acceptance Criteria/u);
});

test('prose that merely mentions a credential word keeps its next word', () => {
  const risk = 'Snapshot paging assumes the token survives a ~1.5 h walk with retries.';
  assert.equal(redactString(risk), risk);
  assert.equal(redactString('the secret sauce is per-page persistence'), 'the secret sauce is per-page persistence');
  assert.equal(sanitizeValue({ architecture_risk: risk }).architecture_risk, risk);
});

test('an actual credential is still redacted in every shape that carries one', () => {
  assert.equal(redactString('token=abc123def'), 'token=[REDACTED]');
  assert.equal(redactString('password: hunter2xyz'), 'password: [REDACTED]');
  assert.equal(redactString('--token abc123def'), '--token [REDACTED]');
  assert.equal(redactString('Authorization: Bearer abc.def.ghi'), 'Authorization: Bearer [REDACTED]');
  assert.equal(redactString('leaked ghp_AAAABBBBCCCCDDDD here'), 'leaked [REDACTED] here');
  assert.equal(sanitizeValue({ token: 'survives' }).token, '[REDACTED]', 'a secret-named key is redacted whatever its value looks like');
});

// The Agent Conversation Checkpoint is redacted by pair-state, not pair-store, so the same
// whitespace over-match corrupted every sealed handover independently of the fix above: a real
// checkpoint shipped "assumes the token [REDACTED] a ~1.5 h walk" and "prove the token [REDACTED]
// sent" to the conversation that adopted it.
test('checkpoint redaction keeps prose that merely mentions a credential word', () => {
  const risk = 'Snapshot paging assumes the token survives a ~1.5 h walk with retries.';
  assert.equal(checkpointRedaction.redactString(risk), risk);
  assert.equal(
    checkpointRedaction.redactString('a stub can prove the token is sent, only QSS proves it lands'),
    'a stub can prove the token is sent, only QSS proves it lands',
  );
  assert.equal(checkpointRedaction.redactString('the secret sauce is per-page persistence'), 'the secret sauce is per-page persistence');
});

test('checkpoint redaction still removes an actual credential in every shape that carries one', () => {
  assert.equal(checkpointRedaction.redactString('token=abc123def'), 'token=[REDACTED]');
  assert.equal(checkpointRedaction.redactString('password: hunter2xyz'), 'password: [REDACTED]');
  assert.equal(checkpointRedaction.redactString('--token abc123def'), '--token [REDACTED]');
  assert.equal(checkpointRedaction.redactString('"api_key": "abc123def"'), '"api_key": "[REDACTED]"');
  assert.equal(checkpointRedaction.redactString('leaked ghp_AAAABBBBCCCCDDDD here'), 'leaked [REDACTED] here');
  assert.match(checkpointRedaction.redactString('ACCESS_TOKEN=abc123def'), /\[REDACTED\]/u);
});

// The two redaction layers drifted: pair-state learned quoted assignments, env-var pairs, and JWTs while
// pair-store did not, so the exact shapes a sealed checkpoint refuses were stored verbatim as Pair
// evidence. One rule set, shared by both, is what keeps a future fix from landing on one side only.
test('evidence redaction removes every credential shape checkpoint redaction refuses', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c';
  assert.equal(redactString(`session ${jwt} captured`), 'session [REDACTED] captured');
  assert.equal(redactString('"api_key": "abc123def"'), '"api_key": "[REDACTED]"');
  assert.match(redactString('ACCESS_TOKEN=abc123def'), /\[REDACTED\]/u);
  assert.equal(redactString('cookie: sessionid1234'), 'cookie: [REDACTED]');
});
