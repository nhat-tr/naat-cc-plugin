# DR-001: Cold Agent Conversation Handover

- **Schema:** 1
- **Status:** accepted
- **Work ID:** `work-20260722-cold-agent-conversation-handover`
- **Origin Spec:** `docs/work/work-20260722-cold-agent-conversation-handover/spec.md`
- **Acceptance Criteria:** AC-1, AC-2, AC-3, AC-4, AC-5, AC-6, AC-7, AC-8, AC-9, AC-10, AC-11, AC-12, AC-13, AC-14
- **Supersedes:** none
- **Superseded By:** none

## Context

DR-003 bounded Pair-authored Resume Checkpoint input and measured its first resumed turn, but a registered agent conversation idle long enough to be cold can still reconstruct provider-owned history before any post-turn measurement is available. Pair and brainstorming need a deterministic pre-model boundary that preserves bounded semantic state without asking the old model to summarize itself.

## Decision

At `UserPromptSubmit`, classify only registered Codex and Claude Agent Conversations as cold when their last completed Stop boundary is at least 3,600,000 ms old. The Freshness Gate blocks a Cold Agent Conversation before model processing, seals its Agent Conversation Checkpoint into an immutable Agent Conversation Handover, and directs the user to a plain fresh provider-affine conversation.

- `pair-loop --fresh-from <handover-id> --runtime auto` starts that fresh conversation without resume, continue, or fork arguments.
- `pair-loop --adopt-handover <handover-id> --runtime codex|claude` atomically adopts the exact handover and retires the source.
- Cross-provider adoption is explicit; automatic routing stays provider-affine.
- `pair-loop --allow-cold-resume <handover-id> --once --confirm-cost-risk` is the sole one-turn recovery. Its Stop boundary refreshes and seals the checkpoint, then retires the source again.
- Handover state contains only bounded semantic fields, artifact references, and digests. It never stores raw prompts, transcripts, compact summaries, private reasoning, environment maps, credentials, or capability tokens.

## Rationale

Deterministic inactivity is observable before a provider request while cache residency is not. Sealing existing bounded state avoids the cold turn that a model-authored handover would spend. Exact-ID adoption prevents simultaneous conversations from crossing work or brainstorming context.

## Alternatives Rejected

- **Periodic cache warming (2/10):** spends requests without guaranteeing provider cache residency.
- **Always resume the source conversation (3/10):** preserves unbounded provider history after cold inactivity.
- **Persist provider compaction output (1/10):** treats unbounded provider text as recovery state.

## Consequences

- Status, doctor, orientation, and tmux status use one secret-safe freshness projection.
- Missing, corrupt, unsafe, or digest-mismatched handovers fail closed.
- The disabled legacy Stop gate remains disabled; non-blocking activity recording and pre-model freshness enforcement use the dedicated handover hook.

## Evidence

- Canonical specification: `docs/work/work-20260722-cold-agent-conversation-handover/spec.md`
- Existing bounded checkpoint decision: `docs/work/work-20260719-pair-loop-observable-control/decisions/DR-003-bounded-resume-token-strategy.md`
- Hook contract evidence: `hooks/hooks.json` and `skills/pair-v3/tests/handover-gate.integration.test.js`

## Implementation

- Base: Pair v4 runtime engine and brainstorming skill
- Changes: Agent Conversation Checkpoint, Freshness Gate, Agent Conversation Handover, fresh launch, exact-ID adoption, and visible freshness projection

## Outcomes

Fresh handover replaces stale same-agent-conversation continuation for registered conversations only.

## Learning

This Decision supersedes only DR-003's stale same-agent-conversation default. Cross-Work lineage does not mutate DR-003 or encode a local Decision Record supersession relation. It does not supersede DR-003's bounded Resume Checkpoint, telemetry, or prohibition on cache pings.
