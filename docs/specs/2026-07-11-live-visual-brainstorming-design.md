# Spec: Live Visual Brainstorming Session

## Purpose

Turn the optional brainstorming visual companion into a live interview surface where a user can select and annotate generated visual components, add free-form chat, and receive agent responses or revised visuals without leaving the active Claude or Codex working session.

## Rejection Criteria

- Do not create or resume a second agent process and present it as the current session.
- Do not allow a browser submission to bypass the active runtime's normal permissions or trust boundary.
- Do not lose annotations, chat turns, or agent replies when the visual page reloads.

## Contrasts

- Not a general-purpose design editor or Figma replacement.
- Not a vendor-specific Claude Remote Control or Codex app-server client.
- Not production application code; visual artifacts remain disposable brainstorming aids.

## Constraints

- Preserve the existing dependency-free Node.js and HTML companion.
- Support self-contained HTML and React-rendered DOM through event delegation rather than React coupling.
- Keep localhost as the default bind target and authenticate the visual session with an ephemeral capability cookie.
- Keep wait operations bounded so an inactive browser cannot strand an agent tool call indefinitely.

## Decisions

- Persist one append-only session event log containing browser turns and agent replies.
- Let the browser queue choices, element annotations, and an optional message, then submit them as one `user.turn` event.
- Deliver the next unacknowledged browser turn through a deterministic `session-bridge` wait command invoked by the current agent.
- Publish agent responses through the same bridge and acknowledge the corresponding browser turn only after the response is queued.
- Require stable `data-brainstorm-id` attributes on generated meaningful components; use a DOM selector fallback only for unmarked HTML.
- Inject the review/chat shell into both framed fragments and full HTML/React documents.
- Scope authentication cookies to an unguessable per-session URL path, keep scratch state private, and refuse plaintext non-loopback binding unless risk acceptance is explicit.
- Make one agent reply per browser turn retry-idempotent, including recovery after an interrupted cursor update.
- Give each decision a stable choice-group identity so a single-choice decision cannot submit contradictory values.

## Acceptance Criteria

- [ ] AC-1: A user can select any marked visual component, add an annotation, and see it queued with the component identity.
- [ ] AC-2: A browser submission persists one structured turn containing its message, queued annotations, and selected choices.
- [ ] AC-3: The current agent's bounded wait command receives the oldest unacknowledged browser turn without starting another agent process.
- [ ] AC-4: Publishing an agent reply acknowledges its browser turn and makes the reply visible in the browser conversation.
- [ ] AC-5: Conversation history and pending feedback survive screen reloads and visual revisions.
- [ ] AC-6: The companion works for framed HTML fragments and full HTML/React-rendered documents.
- [ ] AC-7: Unauthenticated session API and WebSocket access is rejected.
- [ ] AC-8: Two simultaneous localhost sessions do not overwrite each other's authentication, malformed cookies do not terminate the server, and capability-bearing scratch state is private.
- [ ] AC-9: Retrying publication for the same browser turn returns the original reply without duplicating the transcript.
- [ ] AC-10: Selecting a new option in a single-choice group replaces the previous pending choice; deselection removes it.
- [ ] AC-11: In Codex or Claude, the visual server remains attached to a foreground execution even when a caller requests background mode, so the command harness cannot reap it after startup.
- [ ] AC-12: Restart guidance treats the previous capability URL as invalid and requires sharing the newly returned URL before waiting for browser input.

## Verification

- AC-1: Browser test selects a marked component, queues an annotation, and inspects the pending-feedback chip.
- AC-2: Integration test submits chat plus annotation through the real server and reads the persisted session record.
- AC-3: Integration test runs `session-bridge wait` against that session and observes the submitted event.
- AC-4: Integration test publishes a reply, observes cursor acknowledgement, and reads the reply through the session API.
- AC-5: Browser test reloads after a new screen and observes the same conversation and pending feedback.
- AC-6: Browser tests cover a framed fragment and a full document whose DOM is rendered after helper injection.
- AC-7: HTTP and WebSocket integration tests omit or alter the capability cookie and receive rejection.
- AC-8: Integration tests assert unique cookie paths, reject a malformed cookie while the server remains available, and verify session-directory/log permissions plus token-free logs.
- AC-9: Store test removes the cursor after a persisted reply, retries publication, and observes one reply with restored acknowledgement.
- AC-10: Browser test selects, replaces, and deselects grouped choices before submitting the turn.
- AC-11: Launcher integration test requests `--background` with `CODEX_CI=1`, observes a still-running launcher and server, then performs a live authenticated GET after the startup call has yielded.
- AC-12: Skill contract test requires new-link and immediate-wait instructions after a restart.

## Out of Scope

- Background agent spawning when no Claude or Codex turn is active.
- Multi-user collaboration, database storage, accounts, or remote deployment.
- Arbitrary production code editing directly from browser annotations.
