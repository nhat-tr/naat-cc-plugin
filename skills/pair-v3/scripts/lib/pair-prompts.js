// Prompt assembly, written in the order a prefix cache reads it.
//
// A cache match starts at byte 0 and ends at the first byte that differs, so anything call-unique in
// front of invariant text makes that invariant text unreachable no matter how many times it repeats.
// Every prompt in this loop used to be built the other way round — the Review Slice id, its outcome and
// the findings first, the never-changing instructions last — so the identical paragraph at the end of
// sixty-two calls never hit once. Each builder here is therefore three parts in one order:
//
//   1. KIND boilerplate — byte-identical for every call of that kind, for the life of the repository.
//   2. slice-stable block — byte-identical for every call about that Review Slice.
//   3. call-variable tail — findings, failures, commits, human direction.
//
// A resumed warm session omits part 2 entirely: the session history already holds it, and re-sending it
// would be paying twice for the thing continuity exists to avoid.

// This session's Bash tool is sandboxed independently of the parent that spawned it, and the sandbox
// denies the socket bind MSBuild's parallel worker nodes need. A parallel build then stalls for
// minutes and reports "Build FAILED" with 0 errors, leaving the session iterating with no diagnostics.
const SANDBOXED_BUILD_NOTE = ' If this repository builds with MSBuild, pass `-m:1` to every `dotnet build` and `dotnet test`; without it a sandboxed build stalls for minutes and then reports `Build FAILED` with 0 errors instead of the real compiler output.';

const KIND_BOILERPLATE = {
  implementation: `Implement one bounded Review Slice.

Read applicable AGENTS.md plus only current code, callers, contracts, and tests needed for this outcome. Before editing, look for a changed or unknown runtime responsibility: owner/lifetime/state, public or data contract, request middleware ordering, remote/distributed boundary, event ordering/idempotency, background-job shutdown, concurrency/transactions/retries, security, replica/load-balancer behavior, deployment topology, or React state ownership. If one exists or remains unknown, do not edit: return design-required with one risk sentence and the compact Design Check. Otherwise return architecture_risk null and implement direct readable code on the Routine Path. Existing code is evidence, not authority. Do not edit Pair files, commit, or run final verification. Return one risk-appropriate Failure Proof; Pair runs exact verification after handoff.${SANDBOXED_BUILD_NOTE}`,

  'design-implementation': `Implement one Architecture-Sensitive Path checkpoint.

Read applicable AGENTS.md and current code at the named seam and callers. Implement the first thin production path through entrypoint, changed boundary, result, and first real usage. Do not expand horizontally, create unused abstractions, copy nearby patterns without matching ownership/lifetime/failure/concurrency, edit Pair files, commit, or run the final verification command. Return completed with the same bounded architecture risk and one risk-appropriate Failure Proof. Pair runs exact verification after handoff.${SANDBOXED_BUILD_NOTE}`,

  correction: `Correct one Review Slice once.

Inspect the current checkpoint and the exact evidence below. Make only the bounded correction that satisfies each finding's claim, plus its pass_condition where one is stated — a finding carries no pass_condition when the human left working out what "addressed" looks like to you. Do not broaden design, edit Pair files, commit, or run final verification. Return completed with the bounded architecture risk and Failure Proof. This is the only automatic correction; another failure pauses for human control.

Before you finish, sweep for the same defect elsewhere. Most findings name one place a rule was broken, not the only place it is breakable: search for every other site that reaches the same behaviour — the other callers of the function you guarded, the other writers of the field you ordered, the other paths into the state you exempted. Fixing one of four such sites is not a bounded correction, it is the same defect three more times, and each one comes back as its own finding later. Correcting the siblings of the defect you were given is in scope; new design is not. Name in your report every sibling you found, and for any you deliberately left, say why.${SANDBOXED_BUILD_NOTE}`,

  review: `Review one immutable checkpoint. Do not edit. Approval must be {"verdict":"approve","findings":[]} with no narrative. Return at most three BLOCKER/MAJOR findings; omit style, preferences, optional hardening, speculative edges, and unsupported architecture claims. Every finding requires a falsifiable claim, reachable scenario, impact, pass condition, and exact checkpoint commit/path/blob/line anchor.

Inspect only changed files, named Design Check callers, and exact contracts needed to test reachable behavior. Existing patterns are evidence only; judge responsibility, ownership, lifetime, state, failure ownership, concurrency, contract compatibility, middleware/event ordering, and replica behavior against this change.${SANDBOXED_BUILD_NOTE}`,

  'post-diff-design': `Inspect one immutable checkpoint. Do not edit.

Inspect the changed seams named by the checkpoint diff below, plus their exact callers. Return design-required with one bounded architecture risk and the compact Design Check grounded in actual code. Use failure_proof null and blocker null.`,
};

// Everything about a Review Slice that is settled before its first call and never changes afterwards.
// The Design Check belongs here rather than in the tail: it is written once per slice and then read
// identically by the implementation that follows it and by every review of the result.
function sliceStableBlock({ slice, criteria, designCheck = null }) {
  const lines = [
    `Review Slice: ${slice.id}`,
    `Outcome: ${slice.outcome}`,
    'Acceptance Criteria:',
    criteria,
  ];
  if (designCheck) lines.push('', 'Design Check for this Review Slice:', designCheck.trim());
  return lines.join('\n');
}

function assemble(kind, stable, tail) {
  const boilerplate = KIND_BOILERPLATE[kind];
  if (!boilerplate) throw new Error(`unknown prompt kind ${kind}`);
  return [boilerplate, stable, tail].filter(part => part && String(part).trim()).join('\n\n');
}

// The exact bytes two calls of one kind are guaranteed to share. Callers assert against this rather than
// re-deriving it, so the guarantee cannot drift away from the assembly that is supposed to provide it.
function promptPrefix(kind, stable = null) {
  return [KIND_BOILERPLATE[kind], stable].filter(part => part && String(part).trim()).join('\n\n');
}

// Human steering is bounded by what a person can reasonably type, not by the 1000-character caps that
// bound model-facing fields — so it is never reflowed or truncated here. It sits last, closest to the
// turn it is steering, and always after the machine's own evidence.
function steeringBlock(steering) {
  const text = String(steering || '').trim();
  return text ? `Human steering for this attempt (binding, written by the human running this loop):\n${text}` : null;
}

function directionBlock(direction) {
  const text = String(direction || '').trim();
  return text ? `Correction Direction (bounded, human-authored, binding for this correction):\n${text}` : null;
}

function implementationPrompt({ slice, criteria, designCheck = null, steering = null, warm = false }) {
  const kind = designCheck ? 'design-implementation' : 'implementation';
  const stable = warm ? null : sliceStableBlock({ slice, criteria, designCheck });
  return assemble(kind, stable, steeringBlock(steering));
}

// `evidence` is the adjudicated findings and any deterministic verification failure, already assembled by
// the caller. Kept out of the evidence array: a Correction Direction is human intent, not a falsifiable
// finding, and conflating the two would let it be read as evidence the checkpoint already contradicts.
function correctionPrompt({ slice, criteria, evidence, direction = null, steering = null, warm = false }) {
  const stable = warm ? null : sliceStableBlock({ slice, criteria });
  const tail = [
    `Human-valid or deterministic evidence:\n${JSON.stringify(evidence)}`,
    directionBlock(direction),
    steeringBlock(steering),
  ].filter(Boolean).join('\n\n');
  return assemble('correction', stable, tail);
}

function postDiffDesignPrompt({ slice, criteria, baseCommit, checkpointCommit }) {
  return assemble('post-diff-design', sliceStableBlock({ slice, criteria }),
    `Base: ${baseCommit}\nCheckpoint: ${checkpointCommit}\nRun git diff ${baseCommit}..${checkpointCommit}.`);
}

// The reviewer re-deriving a diff the coordinator already holds as two commit ids is pure waste — a tool
// call, a round trip, and the whole diff read into context anyway. Inlined when it fits the configured
// cap; over the cap the reviewer is told to derive it, which is exactly what every review did before.
function reviewDiffBlock(baseCommit, checkpointCommit, diff) {
  if (diff === null || diff === undefined) {
    return `Start with git diff ${baseCommit}..${checkpointCommit}.`;
  }
  return `Unified diff ${baseCommit}..${checkpointCommit} (complete; do not re-derive it):\n${diff}`;
}

function reviewPrompt({
  slice, criteria, designCheck = null, baseCommit, checkpointCommit,
  verification, architectureRisk = null, guidance = [], diff = null,
}) {
  const guidanceText = guidance.length > 0
    ? `Applicable approved Review Guidance:\n${guidance.map(item => `- ${item.rule}`).join('\n')}`
    : null;
  const tail = [
    `Base: ${baseCommit}\nCheckpoint: ${checkpointCommit}\nVerification: ${JSON.stringify(verification)}\nArchitecture risk: ${architectureRisk || 'none declared or detected'}`,
    guidanceText,
    reviewDiffBlock(baseCommit, checkpointCommit, diff),
  ].filter(Boolean).join('\n\n');
  return assemble('review', sliceStableBlock({ slice, criteria, designCheck }), tail);
}

module.exports = {
  KIND_BOILERPLATE,
  SANDBOXED_BUILD_NOTE,
  correctionPrompt,
  implementationPrompt,
  postDiffDesignPrompt,
  promptPrefix,
  reviewPrompt,
  sliceStableBlock,
};
