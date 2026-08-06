#!/usr/bin/env node
//
// Optional, human-run, and never part of `node --test`: this spends real money on real sessions.
//
//   PAIR_SMOKE_LIVE=1 node skills/pair-v3/tests/live-resume-smoke.js [--runtime claude|codex] [--model <id>]
//
// What the unit tests cannot prove is that the CLI on this machine, at this version, actually composes
// resume with structured output and remembers turn 1. It asks the session for a nonce, resumes, and asks
// it to repeat the nonce back — a recall failure is unambiguous, and a resume failure is louder still.
// Both turns use the same one-property schema, so a shape change shows up as a parse failure rather than
// as a plausible-looking answer.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runProviderSession } = require('../scripts/lib/provider-runtime');

if (process.env.PAIR_SMOKE_LIVE !== '1') {
  console.log('live resume smoke skipped: set PAIR_SMOKE_LIVE=1 to spend two real provider sessions.');
  process.exit(0);
}

function option(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? fallback : process.argv[index + 1];
}

const runtime = option('--runtime', 'claude');
const model = option('--model', runtime === 'claude' ? 'claude-opus-5' : 'gpt-5');
const scratch = fs.mkdtempSync(path.join(process.env.CLAUDE_SCRATCH_DIR || path.join(os.homedir(), '.claude-scratch'), 'live-resume-'));
const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['answer'],
  properties: { answer: { type: 'string', maxLength: 80 } },
};
const schemaPath = path.join(scratch, 'schema.json');
fs.writeFileSync(schemaPath, JSON.stringify(schema));

const nonce = `pair-${process.pid}-${Math.floor(Date.now() / 1000)}`;
const common = {
  runtime,
  mode: 'implementation',
  root: scratch,
  schemaPath,
  schema,
  outputPath: path.join(scratch, 'result.json'),
  model,
  effort: 'low',
  persistSession: true,
};

try {
  const first = runProviderSession({ ...common, prompt: `Remember this token exactly: ${nonce}. Return it as "answer". Do not read or write any file.` });
  assert.ok(first.session_id, `${runtime} reported no session id, so nothing could be resumed`);
  console.log(`turn 1  session=${first.session_id}  answer=${first.output.answer}  context=${first.usage.context_tokens}  cost=${first.usage.cost_usd}`);

  const second = runProviderSession({ ...common, resumeSessionId: first.session_id, prompt: 'Return the token I asked you to remember, as "answer". Do not read or write any file.' });
  console.log(`turn 2  session=${second.session_id}  answer=${second.output.answer}  context=${second.usage.context_tokens}  cache_read=${second.usage.cached_input_tokens}  cost=${second.usage.cost_usd}`);

  assert.equal(second.resumed, true);
  assert.match(String(second.output.answer), new RegExp(nonce, 'u'), 'the resumed session did not recall turn 1');
  assert.ok(second.usage.cached_input_tokens > 0, 'a resumed turn that reads nothing from cache is not continuity');
  console.log('\nlive resume smoke PASSED: resume composes with structured output and recalls turn 1.');
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
