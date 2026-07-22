# Spec: Cold Agent-Conversation Handover

- **Work ID:** `work-20260722-cold-agent-conversation-handover`

## Purpose

Long-running agent conversations can accumulate a large context and then become cold after hours of inactivity. Returning can require expensive reconstruction of that entire accumulated context, regardless of how much context-window capacity remains.

The worst case combines a large cold context with little remaining capacity, causing costly reconstruction followed by compaction. Users should be able to continue from durable, bounded state in a fresh agent conversation across Pair implementation and pre-plan brainstorming, for both Codex and Claude Code.

## Rejection Criteria

- The cold agent conversation must not need another model turn to prepare its own handover.
- Active conversations must not be displaced merely because they are long-running or context-heavy.
- The design must not depend on undocumented, provider-specific cache or context signals unavailable to either Codex or Claude.

## Contrasts

- Not cache-warming, because it spends tokens merely to preserve cache residency.
- Not ordinary pause/resume, because resume currently continues the same owning agent conversation.
- Not only a low-remaining-context safeguard, because a cold conversation with abundant remaining capacity can still be very expensive.
- Not only a Pair implementation-loop feature, because brainstorming can accumulate substantial research before `.pair/plan.md` exists.

## Constraints

- Use a deterministic idle policy of 60 minutes from the last completed registered turn; this is an operator policy, not a claim that a provider cache is present or absent.
- Apply the Freshness Gate only to agent conversations explicitly registered by Pair or the brainstorming skill. Unrelated conversations remain inert.
- Run the Freshness Gate at `UserPromptSubmit` before model processing. A stale registered conversation may not fall through when usage or cache telemetry is unavailable.
- Preserve the existing provider-affine default. Cross-provider adoption requires an explicit `--runtime codex|claude` choice and never occurs as automatic fallback.
- Never use provider `resume`, `continue`, `fork`, or `--fork-session` for a fresh handover launch.
- Keep handover runtime state under ignored `.pair/handovers/`. Keep canonical approved semantics and Decision Records under `docs/work/`.
- Keep the initial bootstrap at or below 8,192 UTF-8 bytes and the semantic Agent Conversation Checkpoint at or below 32 KiB.
- Omit raw prompts, transcripts, private reasoning, provider-generated compact summaries, environment maps, credentials, capability tokens, and secret-like values from checkpoints, events, status, reports, hook output, and tests.
- Preserve unrelated dirty work. Handover sealing, adoption, retirement, and overrides never restore, discard, or rewrite user files.
- Use Node.js built-ins, the existing Pair reducer and checkpoint code, installed hooks, and tmux. No new runtime dependency is justified.
- Treat hooks as the enforcement boundary when installed. `pair-loop --doctor` must report a failing supported-runtime hook contract before dispatch rather than claiming protection is active.

## Existing Capability Baseline

- `skills/pair-v3/scripts/pair-stop-adapter` already emits native Codex and Claude Stop responses for only the owning agent conversation, but it has no activity-age decision.
- `skills/pair-v3/scripts/lib/pair-control.js` already persists pause checkpoints and transfers continuation ownership, but `resumeWork` continues the saved phase without a freshness decision.
- `skills/pair-v3/scripts/lib/resume-checkpoint.js` already enforces an 8,192-byte secret-safe checkpoint and records post-turn cache telemetry, but post-turn telemetry arrives after cold reconstruction cost.
- `skills/pair-v3/scripts/pair-orient` already injects repository state at SessionStart, but it helps only after a fresh conversation has been opened.
- `skills/pair-v3/scripts/lib/tmux-host.js` already owns the visible three-pane host, but it does not display agent-conversation age or handover state.
- `skills/brainstorming/SKILL.md` already preserves a confirmed Core Anchor and bounded research discipline in the live workflow, but terminal brainstorming has no durable semantic checkpoint before design approval.
- `hooks/hooks.json` and `scripts/install-runtime.js` already install shared hooks for Claude and Codex. Current official contracts place `UserPromptSubmit` before model processing and support a blocking result: [Claude Code hooks](https://code.claude.com/docs/en/hooks) and [Codex hooks](https://learn.chatgpt.com/docs/hooks.md).
- `docs/work/work-20260719-pair-loop-observable-control/decisions/DR-003-bounded-resume-token-strategy.md` intentionally chose same-agent-conversation resume by default and post-turn measurement. This Work supersedes that default for stale registered conversations without editing the prior Decision Record.

## Decisions

### D-1: Classify coldness by deterministic inactivity

- **Decision:** A registered agent conversation becomes a Cold Agent Conversation when `now - last_active_at >= 3,600,000 ms`, measured at `UserPromptSubmit` from the last completed Stop boundary.
- **Why:** Neither runtime exposes a guaranteed provider-cache lifetime or a portable pre-turn cache-hit signal. Wall-clock inactivity is observable before spending model tokens.
- **Consequences:** A prompt submitted below the boundary proceeds normally. A prompt submitted at or above the boundary enters handover-required state before model processing. Future-dated or malformed timestamps fail safe with an explicit diagnostic rather than silently classifying the conversation as warm.

### D-2: Maintain semantic state while the conversation is warm

- **Decision:** Every registered Stop boundary updates activity deterministically. Pair derives its Agent Conversation Checkpoint from repository authority; brainstorming refreshes its checkpoint after each material research or decision boundary and before asking the next question.
- **Why:** A cold conversation cannot cheaply summarize itself after the user returns. Material-boundary writes preserve meaning without rewriting unchanged content on every turn.
- **Consequences:** The checkpoint records the confirmed Core Anchor, evidence-backed findings and references, confirmed choices, rejected alternatives, current direction, unresolved decisions, next action, and artifact digests. It excludes transcripts and private reasoning. A Stop boundary with no semantic change updates only activity.

### D-3: Seal a bounded Agent Conversation Handover without a model call

- **Decision:** On the first stale prompt, the Freshness Gate validates and atomically seals the latest checkpoint into an immutable Agent Conversation Handover, records the transition, and blocks the prompt using the runtime-native response shape.
- **Why:** Sealing existing bounded state is deterministic and cheap; asking the old model to create a handover would incur the cost being prevented.
- **Consequences:** The blocked prompt is not persisted or copied. Hook output contains the idle age, opaque handover ID, validation status, and exact fresh-start instruction. Subsequent prompts in the source conversation remain blocked.

### D-4: Keep Work authority and handover authority separate

- **Decision:** `.pair/handovers/<opaque-id>/` owns only agent-conversation activity, checkpoint revision, sealing, adoption, retirement, and override evidence. Existing Pair Work events and reducer state remain authoritative for Work, phase, attempt, patch, verification, and review state.
- **Why:** Handover must also exist before a Work ID or plan exists, but duplicating Work lifecycle into a second registry would create disagreement.
- **Consequences:** `manifest.json`, `checkpoint.md`, and `events.jsonl` use private permissions and atomic writes. Pair handovers reference Work artifacts by repository-relative path and digest. Brainstorming handovers may later attach their lineage to the approved Work ID.

### D-5: Start a genuinely fresh provider-affine conversation

- **Decision:** `pair-loop --fresh-from <handover-id> --runtime auto` launches a plain new Codex or Claude conversation with only the bounded bootstrap; manual surfaces use `Resume Pair handover <handover-id>` in a newly opened conversation.
- **Why:** Resuming or forking can carry the source history and recreate the same unbounded input cost. Provider affinity preserves current routing unless the user explicitly changes it.
- **Consequences:** The launcher rejects nested agent execution, active in-flight requests, unsafe paths, invalid handovers, and any generated command containing resume or fork flags. The manual path is behaviorally equivalent after adoption.

### D-6: Adopt exactly once and retire the source conversation

- **Decision:** A fresh conversation atomically validates the handover digest, claims it once, transfers continuation ownership, and permanently marks the source agent conversation Retired.
- **Why:** A repository may contain several simultaneous conversations; a repository-wide latest pointer or reusable handover could cross-wire unrelated work.
- **Consequences:** Adoption uses the exact opaque handover ID. Concurrent adoption has one winner. Old and unrelated conversations cannot claim or advance the handover. The Retired source remains blocked even after files or processes restart.

### D-7: Fail closed with one explicit recovery escape hatch

- **Decision:** Missing, corrupt, path-unsafe, digest-mismatched, or outdated handovers block automatic continuation and adoption. `pair-loop --allow-cold-resume <handover-id> --once --confirm-cost-risk` authorizes exactly one old-conversation turn.
- **Why:** Silent fallback would exchange correctness or token cost without user consent, while a permanent no-override policy could strand unique brainstorming knowledge after a checkpoint defect.
- **Consequences:** The override is exact-ID, auditable, and one-shot. Its permitted Stop boundary must refresh and seal the checkpoint, after which the source returns to Retired. It never disables future Freshness Gates or warms a cache.

### D-8: Make freshness visible before the safety gate fires

- **Decision:** Pair status, JSON status, tmux status, attach output, orientation, and doctor expose secret-safe freshness state from the same projection.
- **Why:** A user should normally see that an agent conversation is approaching or past its deadline before submitting a prompt; the hard block remains the final safety boundary.
- **Consequences:** Surfaces show status, age, deadline, checkpoint revision and digest, handover ID when sealed, and the next safe command. They never show prompt content or transcript paths.

### D-9: Do not treat provider compaction as recovery state

- **Decision:** PreCompact and PostCompact may record that compaction occurred, but Pair does not persist `compact_summary`, parse transcripts, or use provider compaction output to construct a handover.
- **Why:** Compaction may already incur the expensive cold turn and produces provider-owned text outside the approved bounded semantic contract.
- **Consequences:** Active warm compaction remains provider-controlled. A stale return is intercepted at UserPromptSubmit before compaction or model processing can begin.

### D-10: Add explicit cross-runtime vocabulary

- **Decision:** Add Cold Agent Conversation, Agent Conversation Checkpoint, Agent Conversation Handover, Freshness Gate, and Retired Agent Conversation to `UBIQUITOUS_LANGUAGE.md`.
- **Why:** The current glossary distinguishes an agent conversation from a Visual Session but has no canonical terms for freshness or transfer.
- **Consequences:** Runtime state, CLI output, skills, tests, and documentation use these terms verbatim. Provider `session_id` remains only the native field name, not the domain name for an agent conversation.

## Engineering Quality Contract

### Always-on obligations

- **EQC-INTENT — Intent fit:** Every path prevents an automatic stale continuation before model processing while preserving ordinary warm continuation and unrelated conversations. Owner: Pair runtime owner. Exclusion authority: user.
- **EQC-SCOPE — Maintainable scope:** Deepen the existing Pair state, checkpoint, hook, runtime-selection, and tmux modules. Add a shared handover module only for behavior consumed by both Pair and brainstorming; do not add pass-through provider abstractions. Owner: implementer. Exclusion authority: plan reviewer.
- **EQC-TRACE — Traceable verification:** Every lifecycle transition is append-only or atomically projected, every Acceptance Criterion has an exact proof command, and the final complete patch receives independent cumulative review. Owner: Pair coordinator. Exclusion authority: independent reviewer.
- **EQC-SECURITY — Repository security baseline:** Preserve private permissions, path containment, symlink resistance, atomic replacement, secret redaction, unrelated dirty work, and the ban on raw conversation content. Owner: runtime owner. Exclusion authority: user.

### Fact-activated obligations

- **EQC-HOOK — Runtime hook changes:** Changing UserPromptSubmit, Stop, SessionStart, PreCompact, or PostCompact activates installed Codex and Claude integration tests proving native input/output shapes, pre-model blocking, owner isolation, and inert unrelated conversations. Owner: runtime adapter owner. Exclusion authority: user.
- **EQC-TIME — Time-based policy:** Reading persisted time activates injected-clock unit tests for below, exact, above, malformed, future, and process-restart cases. Production tests may not sleep for the 60-minute boundary. Owner: handover-state owner. Exclusion authority: test reviewer.
- **EQC-PRIVATE — Private runtime persistence:** Adding `.pair/handovers/` activates permission, traversal, symlink, digest, concurrent append, interrupted atomic write, and recovery tests on supported platforms. Owner: persistence owner. Exclusion authority: security reviewer.
- **EQC-PROCESS — Fresh runtime launch:** Spawning Codex or Claude activates argv contract tests proving a plain new conversation, provider affinity, explicit cross-provider choice, nested-runtime refusal, and absence of every resume or fork flag. Owner: runtime-selection owner. Exclusion authority: user.
- **EQC-UX — tmux and status changes:** Changing host or status output activates integration tests for early warning, stale state, headless status, absent tmux, and multiple handovers without pane replacement. Owner: host owner. Exclusion authority: user.
- **EQC-LANGUAGE — Domain vocabulary:** Adding the approved terms activates documentation contract tests that reject the ambiguous use of unqualified session for an agent conversation and keep skill, CLI, status, and glossary wording aligned. Owner: documentation owner. Exclusion authority: user.

## Acceptance Criteria

- [ ] AC-1: Only explicitly registered Pair and brainstorming agent conversations receive freshness state or blocking behavior; unrelated conversations remain unchanged even in the same repository.
- [ ] AC-2: Pair and brainstorming maintain a bounded, secret-safe Agent Conversation Checkpoint while warm, with material brainstorming research and confirmed decisions recoverable without a transcript.
- [ ] AC-3: A registered prompt below 60 minutes proceeds, while a prompt at or above exactly 60 minutes is blocked before any model subprocess or provider request starts.
- [ ] AC-4: Stale Codex and Claude prompts receive their exact native blocking responses, a sealed handover ID, and a fresh-start instruction without persisting the submitted prompt.
- [ ] AC-5: Pair handovers reference the existing Work reducer, plan, patch, verification, and review evidence without creating a second authority for Work phase or attempt state.
- [ ] AC-6: The fresh launcher starts a plain provider-affine Codex or Claude conversation from the bounded bootstrap, supports explicit provider change, and has a behaviorally equivalent manual fallback.
- [ ] AC-7: Exact-ID adoption succeeds once, transfers continuation ownership, retires the source conversation across process restart, and cannot cross-adopt another simultaneous conversation.
- [ ] AC-8: Missing, corrupt, stale, path-unsafe, or digest-mismatched handovers fail closed without changing user files, launching a model, or weakening the source gate.
- [ ] AC-9: The exact confirmation command permits one auditable cold turn, requires checkpoint refresh at its Stop boundary, and restores Retired status without disabling later gates.
- [ ] AC-10: Handover files, events, status, reports, and hook output enforce private permissions and contain no prompt, transcript, private reasoning, compact summary, environment map, credential, capability token, or secret-like value.
- [ ] AC-11: Human and JSON status, tmux warning and attach output, SessionStart orientation, and doctor agree on freshness, deadline, checkpoint, handover, and next safe action for both runtimes.
- [ ] AC-12: Automatic or manual compaction cannot create, repair, adopt, or bypass an Agent Conversation Handover, and provider compact summaries are never persisted.
- [ ] AC-13: The approved glossary terms, Pair v4 skill, brainstorming skill, CLI help, and documentation agree; a new immutable Decision Record supersedes the stale-resume part of DR-003 without editing it.
- [ ] AC-14: Complete repository validation and an independent cumulative review pass for the full implementation patch.

## Verification

### AC-1

- **Proof:** `node --test skills/pair-v3/tests/handover-gate.integration.test.js skills/brainstorming/tests/handover-checkpoint.integration.test.js --test-name-pattern "registered Pair and brainstorming conversations|unrelated conversations remain inert|simultaneous conversations stay isolated"`

### AC-2

- **Proof:** `node --test skills/pair-v3/tests/handover-state.test.js skills/brainstorming/tests/handover-checkpoint.integration.test.js --test-name-pattern "bounded warm checkpoint|material research and decisions survive|checkpoint excludes conversation content"`

### AC-3

- **Proof:** `node --test skills/pair-v3/tests/handover-gate.integration.test.js --test-name-pattern "below exact and above sixty-minute boundary|blocks before model launch|malformed and future activity time"`

### AC-4

- **Proof:** `node --test skills/pair-v3/tests/handover-gate.integration.test.js --test-name-pattern "native Codex and Claude stale responses|seals one handover|submitted prompt is never persisted"`

### AC-5

- **Proof:** `node --test skills/pair-v3/tests/handover-state.test.js skills/pair-v3/tests/pair-state.integration.test.js --test-name-pattern "handover references canonical Work state|one reducer retains Work authority|freshness projection survives restart"`

### AC-6

- **Proof:** `node --test skills/pair-v3/tests/handover-launch.integration.test.js --test-name-pattern "plain provider-affine fresh launch|explicit cross-provider launch|manual adoption fallback|rejects resume and fork argv"`

### AC-7

- **Proof:** `node --test skills/pair-v3/tests/handover-state.test.js skills/pair-v3/tests/handover-launch.integration.test.js --test-name-pattern "single atomic adopter|source remains retired after restart|cannot cross-adopt|concurrent adoption has one winner"`

### AC-8

- **Proof:** `node --test skills/pair-v3/tests/handover-state.test.js skills/pair-v3/tests/handover-gate.integration.test.js --test-name-pattern "missing corrupt stale traversal and digest mismatch fail closed|failure preserves repository files|failure never launches model"`

### AC-9

- **Proof:** `node --test skills/pair-v3/tests/handover-gate.integration.test.js --test-name-pattern "exact one-shot cost-risk override|override refreshes checkpoint|override returns source to retired|override cannot disable later gate"`

### AC-10

- **Proof:** `node --test skills/pair-v3/tests/handover-state.test.js skills/pair-v3/tests/handover-gate.integration.test.js --test-name-pattern "private permissions and symlink resistance|forbidden fields and secret-like values are redacted|hook output is secret-safe"`

### AC-11

- **Proof:** `node --test skills/pair-v3/tests/handover-gate.integration.test.js skills/pair-v3/tests/tmux-host.integration.test.js skills/pair-v3/tests/pair-contract-docs.test.js --test-name-pattern "status orientation doctor and hooks agree|tmux warns before stale prompt|absent tmux preserves headless status|Codex and Claude hook installation"`

### AC-12

- **Proof:** `node --test skills/pair-v3/tests/handover-gate.integration.test.js --test-name-pattern "PreCompact and PostCompact cannot bypass freshness|compact summary is never persisted|compaction cannot repair invalid handover"`

### AC-13

- **Proof:** `node --test skills/pair-v3/tests/pair-contract-docs.test.js --test-name-pattern "cold agent conversation vocabulary and commands stay aligned|new Decision Record supersedes DR-003 without mutation"`

### AC-14

- **Proof:** `npm run validate`

## Out of Scope

- Guaranteeing or extending provider prompt-cache retention.
- Cache-warming requests, periodic model pings, or background summarization agents.
- Proactively replacing a warm active conversation solely because its remaining context is low.
- Intercepting unregistered ordinary Codex or Claude conversations.
- Automatically killing or replacing an interactive provider process.
- Persisting or parsing provider transcripts or compact summaries.
- Automatic cross-provider fallback.
- Changing Visual Session lifecycle, Session Store semantics, or Feedback Batch delivery beyond referencing their existing durable artifacts from a handover.
