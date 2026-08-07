# Spec: the loop observes only a program it can prove is its own

- **Work ID:** `work-20260807-runtime-ownership`

## Purpose

`work-20260807-runtime-observation` gave the loop the ability to start a program and ask it questions, and that part works: the program is started once per Work, probed after each slice's tests pass, and torn down at completion, at block, and after an abnormal exit. What it never settled is who the running program *belongs to*.

Readiness is currently taken as proof of ownership. `ensureRuntimeReady` treats a green `ready` as sufficient — the comment states the agnosticism as a feature, "for a runtime this run started, one an earlier run started, or one the human already had up." But `ready` only answers whether something is listening on a port. Because the runtime binds fixed host ports and only one instance can exist, that something is routinely a different Work's parked instance or the human's own stack, and the probe then reports on a worktree nobody asked about. Slice `S-02-the-program-is-always-stopped` blocked four times because each review found another hole in the claim bookkeeping used as a stand-in for ownership; a proxy cannot be patched into a guarantee.

After this Work, a run observes a program only when it can prove that program is serving this Work's code, and says so plainly when it cannot.

## Rejection Criteria

- It is wrong if a run can observe a runtime it cannot prove is serving this Work's worktree. Silently answering about the wrong code is the failure the whole runtime-observation effort exists to remove.
- It is wrong if a teardown obligation is discharged by a command that could not have reached the instance. A `down` run somewhere else exiting 0 is not evidence. *[evidence-derived: the repository-root fallback introduced in `work-20260807-runtime-observation` and rejected by review]*
- It is wrong if a human pressing Ctrl-C is recorded as a verification failure or spends a correction.
- It is wrong if a repository that declares no runtime is affected in any way.

## Contrasts

- **Not "more claim bookkeeping."** Four rounds of corrections each closed one hole in the claim proxy and each revealed another. The claim is a useful record of what is owed; it was never capable of being the proof.
- **Not "require every repository to expose its identity."** A repository that cannot report which worktree it serves should get an honest refusal, not be locked out of the loop entirely.
- **Not a re-run of the previous Work.** Starting the program, probing per slice, completion observing the probe set, and teardown at completion/block/abnormal-exit are already implemented and tested on this branch. This Work settles ownership and closes the three findings that blocked S-02.

## Constraints

- **One instance, fixed ports.** Service endpoints are unproxied and Postgres binds host port 5432 with a persistent container lifetime, so the loop can never start a second instance beside an existing one. Refusing is therefore a real outcome, not a fallback to "start my own."
- **A Work outlives the process driving it.** `pair-loop run` returns to the shell at the action cap, a block, a hitl gate, or an interrupt, so no process is long-lived enough to hold a handle. Every rule here must survive being evaluated fresh by an unrelated later process.
- **Identity must not require the loop to trust itself.** A token the loop writes and later reads back is another proxy. The identity command must report what the *running instance* is serving.
- **Carried forward, not rebuilt.** This Work opens from the `pair/work-20260807-runtime-observation` branch, so `S-01`'s accepted implementation and `S-02`'s teardown checkpoints are the base.

## Decisions

### D-1: Identity is authoritative when declared

- **Decision:** A repository may declare an optional `identity` command in `.pair/runtime.json`. When it is declared, its output is compared against the Work's worktree, and only a match permits observation.
- **Why:** It is the only rule that answers the question actually being asked — is this instance serving this Work's code — rather than a question that correlates with it. It closes the other-Work parked case, the other-Work dead case, and the human's-own-stack case with one check instead of three.
- **Consequences:** How the instance reports its identity is the repository's business: an info endpoint, a startup line, or a file the program itself writes. The loop only runs the command and compares the result.

### D-2: Without identity, claims must be exclusive and ambiguity refuses

- **Decision:** When no `identity` is declared, a green runtime is adopted only when no other Work holds an outstanding claim of any kind. Otherwise the other Work's claim is resolved first, and a green runtime that no Work claims is refused with a message naming what was found.
- **Why:** Adoption without proof is exactly the silent wrong answer this Work removes. Refusing is honest and actionable; the human can stop their stack or declare an identity command.
- **Consequences:** A human with their own AppHost running will be refused until they stop it or declare identity. That is a deliberate cost, and the message must say which of the two to do.

### D-3: Reconciliation covers parked claims belonging to other Works

- **Decision:** Before any observation, every Work's claim is reconciled. A dead-pid claim is torn down. A parked claim held by a Work other than the one being driven is torn down too.
- **Why:** Parking exists so the Work that parked an instance can pick it up again. It says nothing to any *other* Work, and treating it as untouchable is what lets Work B adopt Work A's instance.
- **Consequences:** A parked instance survives only for its own Work. Switching Works costs one restart, which is the correct price for knowing what is being observed.

### D-4: An obligation is discharged only by a `down` that could have reached the instance

- **Decision:** A claim is cleared only when `down` ran against the worktree the claim records. If that worktree is gone, the claim is kept and reported unresolved rather than deleted.
- **Why:** The previous Work introduced a repository-root fallback so that a removed worktree would not block teardown. Review showed the fallback is worse than the gap: the no-op exits 0, the claim is deleted, and the only durable evidence that an instance is still running disappears.
- **Consequences:** An unresolved claim is a visible, human-actionable state. It must appear in `pair-loop status`, not only in the event log.

### D-5: A termination signal is a human act, not a failure

- **Decision:** A verification or probe child terminated by SIGINT or SIGTERM is classified as a human interrupt. No correction is spent and no terminal lifecycle is written once a termination signal has arrived.
- **Why:** The teardown handlers added in the previous Work replace Node's default termination, so a Ctrl-C now kills the child while the parent survives and scores the signal death as a red verification.
- **Consequences:** The interrupt path already exists for provider attempts; this extends the same meaning to verification and probe children.

## Engineering Quality Contract

- **Always-on obligations:** Every change traces to an acceptance criterion here. New behavior lands with a test in `skills/pair-v3/tests/`. `npm run test:pair` passes before completion. A repository with no runtime declaration is untouched on every path. No probe or identity output is persisted verbatim.
- **Fact-activated obligations:**
  - *The runtime declaration schema changes* → a declaration written for the previous Work still validates, and its test asserts that. Owner: implementation session.
  - *Adoption or refusal logic changes* → the refusal message names the two actions a human can take, and a test asserts the message content rather than only the exit path. Owner: implementation session.
  - *Signal handling changes* → a test proves the loop still dies on the second signal, so the handler cannot swallow a human's Ctrl-C. Owner: implementation session; exclusion requires human authority.

## Acceptance Criteria

- [ ] AC-1: `.pair/runtime.json` accepts an optional `identity` command, and a declaration written without one still validates unchanged.
- [ ] AC-2: When `identity` is declared and its output matches the Work's worktree, a green runtime is observed without running `up`.
- [ ] AC-3: When `identity` is declared and its output does not match, the runtime is not probed; a claim held by another Work is torn down first, and with no such claim the run refuses.
- [ ] AC-4: When no `identity` is declared, a green runtime is observed only if no other Work holds an outstanding claim.
- [ ] AC-5: A run refused for unprovable ownership reports what it found and names both ways forward, and spends no correction.
- [ ] AC-6: Before any observation, a parked claim held by a Work other than the one being driven is torn down.
- [ ] AC-7: A claim whose recorded worktree no longer exists is kept, reported unresolved in `pair-loop status`, and never cleared by a `down` run elsewhere.
- [ ] AC-8: A verification or probe child killed by SIGINT or SIGTERM is recorded as a human interrupt, spends no correction, and writes no terminal lifecycle.
- [ ] AC-9: A second termination signal still terminates the loop, so the handler cannot swallow a human's Ctrl-C.
- [ ] AC-10: A Work in a repository with no runtime declaration performs no identity, reconciliation, or refusal step.

## Verification

### AC-1
- **Proof:** `node --test skills/pair-v3/tests/runtime-declaration.test.js` — a declaration with `identity` validates, one without it validates unchanged, and a non-string `identity` is rejected naming the field.

### AC-2
- **Proof:** `node --test skills/pair-v3/tests/runtime-ownership.test.js` — a fake runtime answers `ready` green and `identity` with the Work's worktree; the recorded phases contain no `up` and the probe runs.

### AC-3
- **Proof:** Same suite — identity returns another worktree: with a foreign claim present the phases show `down` before any probe; with no claim present the run refuses and no probe phase is recorded.

### AC-4
- **Proof:** Same suite — with no `identity` declared, a green runtime plus a foreign outstanding claim does not reach a probe; the same green runtime with no foreign claim does.

### AC-5
- **Proof:** Same suite — the refusal message contains both the stop-your-instance and declare-identity directions, and the slice's correction count is unchanged.

### AC-6
- **Proof:** Same suite — a claim parked at pid `null` under a different work id is torn down before the driven Work observes anything, and the `runtime-reclaimed` event is recorded against the parked Work.

### AC-7
- **Proof:** Same suite — a claim whose worktree has been removed survives a run, `down` is never invoked outside that worktree, and `pair-loop status` output names the unresolved claim.

### AC-8
- **Proof:** `node --test skills/pair-v3/tests/runtime-observation.test.js` — a verification child reporting a SIGINT signal leaves the slice's correction count unchanged and its lifecycle non-terminal.

### AC-9
- **Proof:** Same suite — after the handler runs once, a second signal terminates the process rather than being absorbed.

### AC-10
- **Proof:** `npm run test:pair` — the existing no-declaration test passes unchanged, and a fixture Work without a declaration records no identity, reconciliation, or refusal phase.

## Out of Scope

- Starting a second runtime instance beside an existing one. Fixed host ports and a persistent Postgres container make it impossible; refusal is the designed outcome.
- Any change to how the program is started, probed per slice, or observed at completion. That is implemented and tested on the base branch.
- Teardown at completion, at block, and after an abnormal exit. Already implemented; only the two defects named in D-4 and D-5 are in scope.
- Changes to `LocalDevInfra` or to any application, including adding an identity endpoint. This Work defines the contract; a repository adopts it when it chooses to.
- Probes that drive an LLM path.
