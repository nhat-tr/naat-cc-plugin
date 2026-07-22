#!/usr/bin/env node

const childProcess = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const files = {
  brainstorm: 'skills/brainstorming/tests/handover-checkpoint.integration.test.js',
  contracts: 'skills/pair-v3/tests/pair-contract-docs.test.js',
  gate: 'skills/pair-v3/tests/handover-gate.integration.test.js',
  launch: 'skills/pair-v3/tests/handover-launch.integration.test.js',
  modes: 'skills/pair-v3/tests/loop-modes.test.js',
  pairState: 'skills/pair-v3/tests/pair-state.integration.test.js',
  state: 'skills/pair-v3/tests/handover-state.test.js',
};

const proofs = [
  {
    id: 'AC-1',
    clauses: [
      [files.gate, 'Pair registers the native coordinator identity independently of worker runtime routing'],
      [files.brainstorm, 'brainstorming registers the documented Claude identity and refreshes a bounded semantic checkpoint'],
      [files.gate, 'clean unregistered UserPromptSubmit and Stop are byte-for-byte inert'],
      [files.state, 'brainstorming handover never captures an unrelated active Pair Work reference'],
    ],
  },
  {
    id: 'AC-2',
    clauses: [
      [files.state, 'only a completed Stop advances activity and Pair Stop checkpoints final repository authority'],
      [files.brainstorm, 'brainstorming registers the documented Claude identity and refreshes a bounded semantic checkpoint'],
      [files.launch, 'brainstorming CLI adoption prints the recovered bounded checkpoint without secret or transcript fields'],
      [files.state, 'sealed checkpoint bytes stay within the 32 KiB persistence limit'],
    ],
  },
  {
    id: 'AC-3',
    clauses: [
      [files.gate, 'below exact and above sixty-minute boundary preserves warm continuation then blocks stale continuation'],
      [files.gate, 'blocks before model launch for a stale registered Agent Conversation'],
      [files.gate, 'malformed and future activity time fail closed without creating a handover'],
    ],
  },
  {
    id: 'AC-4',
    clauses: [
      [files.gate, 'native Codex and Claude stale responses use their exact blocking shapes'],
      [files.gate, 'seals one handover on the first stale prompt and records registered Stop activity'],
      [files.gate, 'submitted prompt is never persisted'],
      [files.gate, 'status orientation doctor and hooks agree on the sealed Agent Conversation Handover'],
    ],
  },
  {
    id: 'AC-5',
    clauses: [
      [files.state, 'handover references canonical Work state and persists no duplicate lifecycle authority'],
      [files.pairState, 'one reducer retains Work authority and freshness projection survives restart'],
      [files.launch, 'adoption cannot transfer a sealed handover across a changed current Pair Work'],
    ],
  },
  {
    id: 'AC-6',
    clauses: [
      [files.launch, 'plain provider-affine fresh launch is visible, synchronous, and uses no resume or fork argv'],
      [files.launch, 'explicit cross-provider launch requires an explicit runtime choice'],
      [files.launch, 'manual adoption fallback atomically transfers ownership and cannot cross-adopt'],
      [files.launch, 'manual Pair adoption refuses an active in-flight request without claiming handover or ownership'],
      [files.launch, 'rejects resume and fork argv and rejects nested runtime launch'],
    ],
  },
  {
    id: 'AC-7',
    clauses: [
      [files.state, 'single atomic adopter leaves the source retired after restart and exact one-shot override cannot repeat'],
      [files.launch, 'single atomic adopter and concurrent adoption have one winner'],
      [files.launch, 'auto adoption retry recovers an already adopted handover for the same native conversation'],
      [files.launch, 'concurrent same-adopter retries reconcile exactly one adopted audit event'],
      [files.launch, 'adoption transfer race claims only the sealed Work and never finalizes against its replacement'],
    ],
  },
  {
    id: 'AC-8',
    clauses: [
      [files.state, 'missing corrupt stale traversal and digest mismatch fail closed without changing user files'],
      [files.state, 'path-unsafe or digest-mismatched Pair Work references fail closed during adoption'],
      [files.gate, 'tampered warm registry checkpoint and unknown keys fail closed without another secret-bearing write'],
      [files.launch, 'fresh launch reports nonzero and missing provider failures without claiming success'],
      [files.launch, 'manual Pair adoption refuses an active in-flight request without claiming handover or ownership'],
      [files.launch, 'missing handover events prevent launch and adoption without ownership mutation'],
      [files.launch, 'fresh launch rejects a superseded handover and launches only its current refreshed handover'],
      [files.launch, 'fresh launch rejects an already adopted brainstorming handover before provider spawn'],
    ],
  },
  {
    id: 'AC-9',
    clauses: [
      [files.launch, 'exact one-shot cost-risk override allows one prompt and requires a semantic checkpoint refresh'],
      [files.state, 'one-shot override survives restart and has one atomic prompt winner'],
      [files.state, 'exact one-shot override is mutually exclusive with adoption and refreshes the retired source handover'],
      [files.state, 'Pair Stop records an auditable override refresh when repository semantics are unchanged'],
      [files.gate, 'exact override permits one prompt and blocks Stop until that turn refreshes its checkpoint'],
    ],
  },
  {
    id: 'AC-10',
    clauses: [
      [files.state, 'private permissions and symlink resistance exclude forbidden fields and secret-like values'],
      [files.state, 'unknown secret-bearing registry claim keys fail closed without being rewritten'],
      [files.gate, 'submitted prompt is never persisted'],
      [files.gate, 'PreCompact and PostCompact cannot bypass freshness and compact summary is never persisted'],
      [files.launch, 'known event with an extra secret field makes the handover fail closed before launch or adoption'],
      [files.launch, 'brainstorming CLI adoption prints the recovered bounded checkpoint without secret or transcript fields'],
      [files.modes, 'Pair-authored logs, patches, reviews, reports, and status redact credential canaries'],
    ],
  },
  {
    id: 'AC-11',
    excluded_by_operator: ['tmux warning and attach-output clauses'],
    clauses: [
      [files.gate, 'status orientation doctor and hooks agree on the sealed Agent Conversation Handover'],
      [files.gate, 'human and compact status expose warm age deadline checkpoint digest and next safe action'],
      [files.gate, 'doctor hook inspection rejects missing and broken installs and accepts one coordinated contract'],
      [files.gate, 'doctor treats unavailable Freshness Gate state as failure and healthy cold state as warning'],
      [files.gate, 'Pair registers the native coordinator identity independently of worker runtime routing'],
      [files.brainstorm, 'brainstorming registers CODEX_THREAD_ID and rejects a runtime that lies about the native conversation'],
    ],
  },
  {
    id: 'AC-12',
    clauses: [
      [files.gate, 'PreCompact and PostCompact cannot bypass freshness and compact summary is never persisted'],
      [files.gate, 'PreCompact and PostCompact cannot repair or mutate invalid handover state'],
      [files.gate, 'a corrupt registry blocks only conversations with a private registration marker'],
    ],
  },
  {
    id: 'AC-13',
    clauses: [
      [files.contracts, 'cold agent conversation vocabulary and commands stay aligned without mutating DR-003'],
      [files.contracts, 'Pair CLI help exposes the exact handover launch adoption and one-shot recovery commands'],
      [files.contracts, 'new Decision Record supersedes DR-003 without mutation'],
      [files.brainstorm, 'brainstorming skill requires the executable checkpoint command at material research and decision boundaries'],
    ],
  },
];

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function metric(output, name) {
  const matches = [...output.matchAll(new RegExp(`^# ${name} (\\d+)$`, 'gmu'))];
  return matches.length ? Number(matches.at(-1)[1]) : null;
}

for (const proof of proofs) {
  const titles = proof.clauses.map(([, title]) => title);
  if (new Set(titles).size !== titles.length) {
    throw new Error(`${proof.id} contains a duplicate exact proof title`);
  }
  const pattern = `^(?:${titles.map(escapeRegularExpression).join('|')})$`;
  const proofFiles = [...new Set(proof.clauses.map(([file]) => file))];
  const result = childProcess.spawnSync(process.execPath, [
    '--test',
    '--test-reporter=tap',
    '--test-name-pattern', pattern,
    ...proofFiles,
  ], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  const observed = {
    tests: metric(output, 'tests'),
    pass: metric(output, 'pass'),
    fail: metric(output, 'fail'),
    skipped: metric(output, 'skipped'),
  };
  if (
    result.error ||
    result.status !== 0 ||
    observed.tests !== titles.length ||
    observed.pass !== titles.length ||
    observed.fail !== 0 ||
    observed.skipped !== 0
  ) {
    process.stderr.write(output);
    throw new Error(`${proof.id} exact proof mismatch: expected ${titles.length}, observed ${JSON.stringify(observed)}`);
  }
  process.stdout.write(`handover proof ${proof.id}: ${observed.pass}/${titles.length} exact clauses passed\n`);
  for (const exclusion of proof.excluded_by_operator || []) {
    process.stdout.write(`handover proof ${proof.id}: operator-directed exclusion recorded (${exclusion})\n`);
  }
}

process.stdout.write(`handover proofs: ${proofs.length} acceptance mappings passed with exact title accounting\n`);
