const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { buildReviewSliceManifest } = require('../../pair-v3/scripts/review-index.cjs');
const { validPairPlan } = require('../../pair-v3/tests/support/pair-plan-fixture');
const { createScratchDirectory } = require('./test-support');

const scoutCli = path.resolve(__dirname, '../scripts/evidence-scout.cjs');

function createHarness(t, purpose) {
  const scratch = createScratchDirectory(t, purpose);
  const root = path.join(scratch, 'repo');
  const sharedSource = path.join(root, 'src', 'shared.js');
  const eventLog = path.join(scratch, 'worker-events.jsonl');
  const fakeCodex = path.join(scratch, 'fake-codex.cjs');
  fs.mkdirSync(path.dirname(sharedSource), { recursive: true });
  fs.writeFileSync(sharedSource, 'module.exports = { shared: true };\n');
  fs.writeFileSync(fakeCodex, `#!/usr/bin/env node
const crypto = require('node:crypto');
const fs = require('node:fs');
const args = process.argv.slice(2);
const prompt = args.at(-1);
const output = args[args.indexOf('--output-last-message') + 1];
const packetKey = crypto.createHash('sha256').update(prompt).digest('hex').slice(0, 12);
function event(type) {
  fs.appendFileSync(process.env.SCOUT_TEST_EVENT_LOG, JSON.stringify({
    type,
    pid: process.pid,
    at: Date.now(),
    args,
    prompt,
  }) + '\\n');
}
event('start');
if (process.env.SCOUT_TEST_MODE === 'failed') {
  process.stderr.write('observed fake worker failure');
  event('end');
  process.exit(43);
}
if (process.env.SCOUT_TEST_MODE === 'timed_out') {
  setTimeout(() => {}, 60_000);
  return;
}
setTimeout(() => {
  fs.writeFileSync(output, JSON.stringify({
    version: 2,
    summary: 'Observed the shared boundary.',
    evidence: [{
      evidence_key: 'boundary:shared',
      kind: 'symbol',
      path: 'src/shared.js',
      startLine: 1,
      endLine: 1,
      observation: 'Observed by packet ' + packetKey + '.',
    }],
    unknowns: [],
  }));
  event('end');
  process.stdout.write(JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 20, cached_input_tokens: 10, output_tokens: 8 },
  }) + '\\n');
}, 80);
`, { mode: 0o700 });

  return { scratch, root, eventLog, fakeCodex };
}

function git(root, ...args) {
  const result = childProcess.spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  return result.stdout.trim();
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function write(root, relativePath, content) {
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function canonicalManifestFixture(t, options = {}) {
  const harness = createHarness(t, options.purpose || 'scout-canonical-manifest');
  git(harness.root, 'init', '-q');
  git(harness.root, 'config', 'user.email', 'scout@example.test');
  git(harness.root, 'config', 'user.name', 'Scout Test');
  const plan = options.plan || validPairPlan();
  write(harness.root, 'src/greeting.js', 'module.exports = () => "hello";\n');
  write(harness.root, 'tests/greeting.test.js', '// base unit evidence\n');
  write(harness.root, 'tests/greeting.integration.test.js', '// base integration evidence\n');
  git(harness.root, 'add', '.');
  git(harness.root, 'commit', '-qm', 'base');
  const baseTree = git(harness.root, 'rev-parse', 'HEAD^{tree}');

  write(harness.root, 'src/greeting.js', options.source || [
    "import { SessionStore } from './session-store.js';",
    'export function createGreeting(name) {',
    '  return `hello ${name}`;',
    '}',
    '',
  ].join('\n'));
  write(harness.root, 'tests/greeting.test.js', options.testSource || '// verifies named greeting\n');
  git(harness.root, 'add', '.');
  git(harness.root, 'commit', '-qm', 'head');
  const headTree = git(harness.root, 'rev-parse', 'HEAD^{tree}');
  const result = buildReviewSliceManifest({
    repositoryRoot: harness.root,
    workId: 'work-20260712-visual-companion-vnext',
    plan,
    baseTree,
    headTree,
    planDigest: sha256(plan),
    indexerVersion: 'review-index.v1',
  });
  return { ...harness, manifest: result.manifest, baseTree, headTree };
}

function runCanonicalBatch(harness, options = {}) {
  const manifestFile = path.join(harness.scratch, 'canonical-manifest.json');
  const output = options.output || path.join(harness.scratch, 'canonical-result.json');
  fs.writeFileSync(manifestFile, JSON.stringify(harness.manifest));
  const result = childProcess.spawnSync(process.execPath, [
    scoutCli,
    'run-batch',
    '--manifest', manifestFile,
    '--root', harness.root,
    '--output', output,
    '--runtime', 'codex',
    '--model', options.model || 'gpt-5.4-mini',
    '--effort', 'low',
    '--timeout-ms', String(options.timeoutMs || 5_000),
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_SCRATCH_DIR: options.scratchRoot || harness.scratch,
      BRAINSTORM_SCOUT_CODEX_BIN: harness.fakeCodex,
      SCOUT_TEST_EVENT_LOG: harness.eventLog,
      SCOUT_TEST_MODE: options.mode || '',
    },
  });
  return { result, output };
}

function reviewSlice(index, changedFiles = 1, changedLines = 300) {
  return {
    review_slice_id: `slice-${String(index).padStart(3, '0')}`,
    acceptance_criteria: [`AC-${index}`],
    changed_files: Array.from({ length: changedFiles }, (_value, fileIndex) => ({
      path: `src/slice-${String(index).padStart(3, '0')}-${String(fileIndex).padStart(3, '0')}.js`,
      changed_lines: changedLines,
      public_symbols: [`symbol_${index}_${fileIndex}`],
      boundary_crossings: fileIndex === 0 ? [`boundary_${index}`] : [],
      tests: fileIndex === 0 ? [`test_${index}`] : [],
      unknowns: fileIndex === 0 ? [`unknown_${index}`] : [],
    })),
  };
}

function runBatch(harness, name, reviewSlices) {
  const manifest = path.join(harness.scratch, `${name}-manifest.json`);
  const output = path.join(harness.scratch, `${name}-result.json`);
  fs.writeFileSync(manifest, JSON.stringify({
    version: 1,
    work_id: 'work-20260712-visual-companion-vnext',
    review_slices: reviewSlices,
  }));

  const processResult = childProcess.spawnSync(process.execPath, [
    scoutCli,
    'run-batch',
    '--manifest', manifest,
    '--root', harness.root,
    '--output', output,
    '--runtime', 'codex',
    '--model', 'gpt-5.4-mini',
    '--effort', 'low',
    '--timeout-ms', '5000',
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      BRAINSTORM_SCOUT_CODEX_BIN: harness.fakeCodex,
      SCOUT_TEST_EVENT_LOG: harness.eventLog,
    },
  });

  assert.equal(processResult.status, 0, processResult.stderr);
  assert.ok(fs.existsSync(output), 'run-batch must write its merged evidence result');
  return JSON.parse(fs.readFileSync(output, 'utf8'));
}

function packetProjection(result) {
  return result.packets.map(packet => ({
    packet_digest: packet.packet_digest,
    review_slice_ids: packet.review_slice_ids,
    changed_file_count: packet.changed_file_count,
    changed_line_count: packet.changed_line_count,
    oversized_review_slices: packet.oversized_review_slices,
  }));
}

function readEvents(eventLog) {
  return fs.readFileSync(eventLog, 'utf8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function maximumConcurrency(events) {
  const ordered = [...events].sort((left, right) => left.at - right.at || (left.type === 'end' ? -1 : 1));
  let active = 0;
  let maximum = 0;
  for (const event of ordered) {
    active += event.type === 'start' ? 1 : -1;
    maximum = Math.max(maximum, active);
  }
  return maximum;
}

test('scout budget creates deterministic packets capped by Review Slices, files, and changed lines', t => {
  const firstHarness = createHarness(t, 'scout-budget-deterministic-first');
  const secondHarness = createHarness(t, 'scout-budget-deterministic-second');
  const slices = Array.from({ length: 7 }, (_value, index) => reviewSlice(index + 1));
  const first = runBatch(firstHarness, 'seven-slices', slices);
  const second = runBatch(secondHarness, 'seven-slices', [...slices].reverse());

  assert.deepEqual(packetProjection(first), packetProjection(second));
  assert.equal(first.packets.length, 2);
  for (const packet of first.packets) {
    assert.ok(packet.review_slice_ids.length <= 4);
    assert.ok(packet.changed_file_count <= 40);
    assert.ok(packet.changed_line_count <= 1_200);
    assert.ok(packet.brief_bytes <= 4_000);
    assert.ok(packet.packet_bytes <= 6_000);
  }
});

test('scout budget limits low-tier execution to three concurrent scouts, two waves, and six calls', t => {
  const harness = createHarness(t, 'scout-budget-orchestration');
  const slices = Array.from({ length: 24 }, (_value, index) => {
    const fileCount = index < 12 ? 13 : 12;
    return reviewSlice(index + 1, fileCount, 1);
  });
  const result = runBatch(harness, 'three-hundred-files', slices);
  const events = readEvents(harness.eventLog);
  const starts = events.filter(event => event.type === 'start');

  assert.equal(slices.flatMap(slice => slice.changed_files).length, 300);
  assert.equal(starts.length, 6);
  assert.ok(maximumConcurrency(events) <= 3);
  assert.deepEqual([...new Set(result.calls.map(call => call.wave))], [1, 2]);
  assert.ok(result.packets.every(packet => packet.changed_file_count <= 40));
  assert.ok(result.deferred_review_slice_ids.length > 0);

  for (const event of starts) {
    assert.ok(event.args.includes('read-only'));
    assert.ok(!event.args.includes('workspace-write'));
    assert.match(event.prompt, /Do not edit.*delegate.*(?:propose|select) architecture/is);
  }

  assert.equal(result.evidence_by_key['boundary:shared'].length, 6);
  assert.equal(new Set(result.evidence_by_key['boundary:shared'].map(item => item.observation)).size, 6);
});

test('an oversized Review Slice sends a deterministic shortlist and never sends its raw giant diff', t => {
  const firstHarness = createHarness(t, 'scout-budget-oversized-first');
  const secondHarness = createHarness(t, 'scout-budget-oversized-second');
  const rawMarker = 'RAW_GIANT_DIFF_MUST_NOT_REACH_SCOUT';
  const oversized = reviewSlice(1, 1, 5_000);
  oversized.changed_files[0] = {
    ...oversized.changed_files[0],
    raw_diff: `${rawMarker}\n${'changed line\n'.repeat(5_000)}`,
    public_symbols: ['createSession', 'resumeSession'],
    boundary_crossings: ['SessionStore -> AgentConversationDelivery'],
    tests: ['session-delivery.test.js'],
    unknowns: ['Runtime acknowledgement order is unverified'],
  };

  const first = runBatch(firstHarness, 'oversized', [oversized]);
  const second = runBatch(secondHarness, 'oversized', [oversized]);
  const firstPacket = packetProjection(first)[0];
  const secondPacket = packetProjection(second)[0];
  const sentPrompts = readEvents(firstHarness.eventLog)
    .filter(event => event.type === 'start')
    .map(event => event.prompt);

  assert.deepEqual(firstPacket, secondPacket);
  assert.equal(firstPacket.oversized_review_slices.length, 1);
  assert.deepEqual(firstPacket.oversized_review_slices[0].shortlist.public_symbols, [
    'createSession',
    'resumeSession',
  ]);
  assert.deepEqual(firstPacket.oversized_review_slices[0].shortlist.boundary_crossings, [
    'SessionStore -> AgentConversationDelivery',
  ]);
  assert.ok(sentPrompts.every(prompt => !prompt.includes(rawMarker)));
  assert.ok(sentPrompts.every(prompt => !prompt.includes('changed line')));
});

test('run-batch consumes the canonical review-index manifest and derives exact changed lines from Git', t => {
  const harness = canonicalManifestFixture(t);
  const { result, output } = runCanonicalBatch(harness);

  assert.equal(result.status, 0, result.stderr);
  const batch = JSON.parse(fs.readFileSync(output, 'utf8'));
  const numstat = git(
    harness.root,
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--no-renames',
    '--numstat',
    harness.baseTree,
    harness.headTree,
    '--',
  );
  const expectedChangedLines = numstat.split(/\r?\n/).filter(Boolean).reduce((total, line) => {
    const [added, deleted] = line.split('\t');
    return total + Number(added) + Number(deleted);
  }, 0);

  assert.equal(batch.work_id, harness.manifest.work_id);
  assert.equal(batch.packets.reduce((total, packet) => total + packet.changed_line_count, 0), expectedChangedLines);
  assert.deepEqual(
    batch.packets.flatMap(packet => packet.review_slice_ids).sort(),
    harness.manifest.review_slices.filter(slice => slice.actual_changes.length > 0).map(slice => slice.task_id).sort(),
  );
});

test('canonical oversized Review Slice derives a useful local shortlist without caller annotations', t => {
  const filler = Array.from({ length: 1_250 }, (_value, index) => `// changed-${index}`).join('\n');
  const plan = validPairPlan();
  const harness = canonicalManifestFixture(t, {
    purpose: 'scout-canonical-oversized',
    plan,
    source: [
      "import { SessionStore } from './session-store.js';",
      'export class AgentConversationDelivery {}',
      'export function createSession() { return new SessionStore(); }',
      filler,
      '',
    ].join('\n'),
    testSource: "test('createSession delivers once', () => {});\n",
  });
  const { result, output } = runCanonicalBatch(harness);

  assert.equal(result.status, 0, result.stderr);
  const batch = JSON.parse(fs.readFileSync(output, 'utf8'));
  const oversized = batch.packets.flatMap(packet => packet.oversized_review_slices)
    .find(item => item.review_slice_id === '1.1');
  assert.ok(oversized);
  assert.deepEqual(oversized.shortlist.public_symbols, [
    'AgentConversationDelivery',
    'createSession',
  ]);
  assert.ok(oversized.shortlist.boundary_crossings.some(item => item.includes('./session-store.js')));
  assert.ok(oversized.shortlist.tests.some(item => item.includes('tests/greeting.test.js')));
  assert.ok(oversized.shortlist.unknowns.length > 0);
  const prompts = readEvents(harness.eventLog).filter(event => event.type === 'start').map(event => event.prompt);
  assert.ok(prompts.every(prompt => !prompt.includes('changed-1249')));
});

test('a failed scout call is counted and persisted atomically instead of aborting the batch artifact', t => {
  const harness = canonicalManifestFixture(t, { purpose: 'scout-failed-artifact' });
  const { result, output } = runCanonicalBatch(harness, { mode: 'failed' });

  assert.equal(result.status, 1);
  assert.ok(fs.existsSync(output), result.stderr);
  const batch = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(batch.calls.length, 1);
  assert.equal(batch.calls[0].status, 'failed');
  assert.match(batch.calls[0].error, /fake worker failure/i);
  assert.deepEqual(batch.deferred_review_slice_ids, []);
});

test('a timed-out scout call is persisted and run-batch rejects output outside CLAUDE_SCRATCH_DIR', t => {
  const harness = canonicalManifestFixture(t, { purpose: 'scout-timeout-artifact' });
  const timedOut = runCanonicalBatch(harness, { mode: 'timed_out', timeoutMs: 50 });
  assert.equal(timedOut.result.status, 1);
  assert.ok(fs.existsSync(timedOut.output), timedOut.result.stderr);
  const batch = JSON.parse(fs.readFileSync(timedOut.output, 'utf8'));
  assert.equal(batch.calls[0].status, 'timed_out');

  const allowedScratch = path.join(harness.scratch, 'allowed');
  const outsideOutput = path.join(harness.scratch, 'outside', 'result.json');
  const rejected = runCanonicalBatch(harness, {
    output: outsideOutput,
    scratchRoot: allowedScratch,
  });
  assert.equal(rejected.result.status, 1);
  assert.match(rejected.result.stderr, /CLAUDE_SCRATCH_DIR|scratch/i);
  assert.equal(fs.existsSync(outsideOutput), false);
});

test('canonical packet evidence is invariant when local Git attributes classify text as binary', t => {
  const harness = canonicalManifestFixture(t, { purpose: 'scout-git-attribute-invariance' });
  const before = runCanonicalBatch(harness, {
    output: path.join(harness.scratch, 'before-attributes.json'),
  });
  assert.equal(before.result.status, 0, before.result.stderr);

  const infoAttributes = path.join(harness.root, '.git', 'info', 'attributes');
  fs.mkdirSync(path.dirname(infoAttributes), { recursive: true });
  fs.writeFileSync(infoAttributes, '*.js binary\n');
  git(harness.root, 'config', 'diff.hostile-driver.command', 'false');
  git(harness.root, 'config', 'diff.algorithm', 'histogram');
  git(harness.root, 'config', 'diff.indentHeuristic', 'true');
  const after = runCanonicalBatch(harness, {
    output: path.join(harness.scratch, 'after-attributes.json'),
  });
  assert.equal(after.result.status, 0, after.result.stderr);

  const beforeBatch = JSON.parse(fs.readFileSync(before.output, 'utf8'));
  const afterBatch = JSON.parse(fs.readFileSync(after.output, 'utf8'));
  assert.deepEqual(packetProjection(afterBatch), packetProjection(beforeBatch));
});
