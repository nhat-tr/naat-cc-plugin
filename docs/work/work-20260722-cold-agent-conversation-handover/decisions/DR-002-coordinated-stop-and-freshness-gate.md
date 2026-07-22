# DR-002: Coordinated Stop and Freshness Gate

- **Schema:** 1
- **Status:** accepted
- **Work ID:** `work-20260722-cold-agent-conversation-handover`
- **Origin Spec:** `docs/work/work-20260722-cold-agent-conversation-handover/spec.md`
- **Acceptance Criteria:** `AC-1`, `AC-2`, `AC-3`, `AC-7`, `AC-9`, `AC-11`, `AC-13`, `AC-14`
- **Supersedes:** `DR-001-cold-agent-conversation-handover`
- **Superseded By:** none

## Context

Implementation evidence established that matching Stop hooks can execute concurrently and that both Codex and Claude require runtime-native blocking responses for Pair continuation. DR-001 correctly selected a pre-model Freshness Gate but its disabled-Stop consequence cannot atomically record completed-turn activity, capture the final bounded Pair checkpoint, and preserve the existing owning-conversation continuation contract.

## Decision

Install exactly one managed UserPromptSubmit hook and one coordinated managed Stop hook per runtime. UserPromptSubmit exclusively enforces the sixty-minute Freshness Gate before model processing. The coordinated Stop hook records registered activity and the latest bounded checkpoint, then emits Pair continuation only for the native Agent Conversation that owns active Pair Work. Native Agent Conversation runtime and identity remain independent from worker/model runtime routing.

This record supersedes DR-001 within this Work because it corrects the Stop-hook consequence while preserving the approved handover design. As a cross-Work architectural outcome, it supersedes only DR-003's stale same-agent-conversation default for a registered Cold Agent Conversation. It preserves DR-003's bounded Resume Checkpoint, telemetry, prohibition on cache pings, and immutable record bytes; no cross-Work reverse-link metadata is forged into DR-003.

## Rationale

One coordinated Stop owner removes concurrent ordering ambiguity and gives activity, checkpoint refresh, and Pair continuation one atomic policy boundary. Keeping freshness at UserPromptSubmit retains the required deterministic pre-model hard gate. Separating native coordinator identity from worker routing ensures that the installed provider hook looks up the exact registration it created.

## Alternatives Rejected

- **Keep the Stop gate disabled (2/10):** cannot observe completed-turn activity or preserve Pair's existing continuation behavior.
- **Run handover and Pair continuation as separate Stop hooks (3/10):** concurrent provider execution leaves ordering and response precedence undefined.
- **Use worker runtime as conversation identity (1/10):** cross-provider worker routing registers a source key that the native provider hook can never find.

## Consequences

- UserPromptSubmit has one managed `handover-gate.sh`; Stop has one managed `stop-gate.sh`.
- The Stop adapter records activity and checkpoint evidence before deciding whether the owning Pair conversation must continue.
- Unregistered conversations remain byte-for-byte inert, and registered corrupt state fails closed.
- Codex and Claude installations must carry the exact matching `PAIR_HOOK_RUNTIME` prefix and executable gate paths.

## Evidence

- `hooks/hooks.json`
- `scripts/ci/validate-hooks.js`
- `skills/pair-v3/tests/handover-gate.integration.test.js`
- `skills/pair-v3/tests/stop-gate.integration.test.js`
- `skills/pair-v3/tests/pair-contract-docs.test.js`
- `scripts/ci/validate-handover-proofs.js`
- `docs/work/work-20260722-cold-agent-conversation-handover/evidence/EVD-001-exact-acceptance-proofs.json`

## Implementation

- `hooks/handover-gate.sh` and `hooks/stop-gate.sh`
- `skills/pair-v3/scripts/pair-handover-adapter` and `skills/pair-v3/scripts/pair-stop-adapter`
- `skills/pair-v3/scripts/lib/handover-state.js`
- `skills/pair-v3/scripts/pair-task`
- `scripts/ci/validate-handover-proofs.js` provides exact-title AC-1 through AC-13 accounting; the evidence record preserves the user's explicit tmux-test exclusion without claiming that clause was executed.
