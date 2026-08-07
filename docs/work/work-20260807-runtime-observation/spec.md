# Spec: pair-loop observes the running program

- **Work ID:** `work-20260807-runtime-observation`

## Purpose

Today a Work can finish with every Review Slice verified green, and then the first manual run of the program fails on something trivial — the service doesn't start, a route isn't reachable, a tool is still advertised after its registration was removed. The loop's verification never launches the program, so the human is the integration test.

This is measurable, not anecdotal. `work-20260807-article-resolver` decomposed into ten Review Slices carrying **three distinct verify commands**, all `dotnet test` with different category filters. The service under test was never started at any point in the Work, including its own cumulative completion gate. The repository has a purpose-built deterministic HTTP surface — `POST /gateway/direct/lookup`, documented as resolving an exact article number against the live catalog with zero LLM involvement — and not one slice touched it.

After this Work, completion means the program was observed running, and each slice observes it as soon as that slice is done, while the code is still cheap to change.

## Rejection Criteria

- It is wrong if it invalidates the prefix-cache byte ordering in `pair-prompts.js`. That ordering is a paid-for optimization: prompt assembly is deliberately boilerplate → slice-stable → call-variable so a cache match survives, and the file's own header records what it cost to get there. *[evidence-derived: `skills/pair-v3/scripts/lib/pair-prompts.js:1-14`]*
- It is wrong if completion can still be reached without the program having been executed at least once.
- It is wrong if a design artifact a human must approve is bounded by a model-output token cap rather than by what a person can read.
- It is wrong if the harness writes to a human-owned shared configuration file to point a runtime at a worktree.

## Contrasts

- **Not "make prompts smaller."** Cost is dominated by rework and by defects escaping to the human, not by prompt bytes. Measured on this repository's real payloads, switching structured output from JSON to XML costs 9.2% *more*, and would additionally require replacing today's schema validation with a parser.
- **Not "add an end-to-end test suite requirement."** The obligation is to *observe the program running*, which for a service with an existing HTTP surface is one request — not a browser suite.
- **Not "make Review Slices vertical."** They already are: the article-resolver's first slice traverses article number → Product DataHub → named result → rendered entity card. The brainstorming rule that every outcome be behavioral already prevents layered slicing. The tracer bullet was fired; nothing observed where it landed.

## Constraints

- **One runtime instance, not one per Work.** The AppHost registers service endpoints with `IsProxied = false` and binds Postgres to host port 5432 with `ContainerLifetime.Persistent`. Ports are fixed and containers are shared, so a second concurrent instance is impossible. The harness drives the single local AppHost. *(`LocalDevInfra/Hoffmann.LocalDev.AppHost/Program.cs:33-42,241-246`)*
- **Worktree targeting already exists.** `ResolveProjectPath` substitutes a per-service worktree name from the `Worktree` configuration section into the project path template. .NET binds configuration from environment variables, so pointing the AppHost at a Work's worktree needs no file edit and no change to LocalDevInfra. *(`Program.cs:26-31`)*
- **The runtime may live outside the Work's repository.** ParagonAgent contains no AppHost; the host that runs it lives in a sibling repository. The runtime declaration must therefore be able to name an out-of-repo command.
- **Probes must be deterministic.** A probe that drives an LLM path is flaky and would make the loop iterate on nondeterminism. Probes target deterministic surfaces.
- **Secrets stay out.** A runtime declaration names where credentials come from; it never contains them, and no probe output that could carry one is persisted verbatim.

## Decisions

### D-1: The Review Slice Manifest is a design artifact, not scheduling metadata

- **Decision:** Remove the framing that calls the manifest scheduling metadata. Each slice's `verify`, `probe`, and `hitl` are design decisions. The brainstorming skill presents the manifest to the human in readable form and gets approval before publishing it, in the same approval that covers the specification.
- **Why:** `skills/brainstorming/SKILL.md:166` currently states "The Review Slice Manifest is scheduling metadata, not an implementation design." That sentence is the licence under which the entire verification contract of a Work — ten no-op commands, in the observed case — was authored and published without the human ever reading it. `pair-loop open` only consumes the manifest; it never generates it.
- **Consequences:** Brainstorming gains one approval gate it did not have. The manifest's `verify` and `probe` values must be presented as commands a human can evaluate, not as JSON to skim.

### D-2: A repository declares its runtime once; a slice declares a probe

- **Decision:** Add `.pair/runtime.json` with `up`, `ready`, `down`, and an `env` map. Add an optional `probe` command to each Review Slice. A slice that declares no probe must carry a `probe_waived` reason.
- **Why:** The two concerns have different lifetimes. How to start the program is a property of the repository and changes almost never; what to ask the running program is a property of the slice. Splitting them means the expensive part is declared once and the cheap part varies per slice.
- **Consequences:** `runtime.json` is a new repository-level file. A repository without one runs exactly as it does today, so this is additive and no existing Work breaks.

### D-3: The runtime boots once per Work and is held

- **Decision:** The engine runs `up` once when the first probe of a Work is due, polls `ready`, holds the instance across every subsequent slice, and runs `down` at completion, block, or abort. The Work's worktree name is exported into the `up` environment.
- **Why:** Only one instance can exist, so booting per slice would restart the human's development stack once per slice. Booting once amortises the cost and has a useful side effect: while a Work runs, the local environment points at that Work's worktree, so manual poking exercises the code being built.
- **Consequences:** Running a Work commandeers the local development environment for its duration. This is stated in `pair-loop status` rather than left for the human to discover. Teardown must survive an abnormal exit, or a stale instance is left pointing at a worktree.

### D-4: Completion observes, and `depends_on` must be earned

- **Decision:** Cumulative completion runs the distinct set of `probe` commands in addition to the distinct set of `verify` commands. Separately, each `depends_on` entry carries a one-line justification, and manifest validation reports chain depth and maximum parallel width.
- **Why:** Completion currently re-runs `[...new Set(slices.map(s => s.verify))]`, so it cannot catch anything no slice already covered — a gate that is a no-op by construction. On the observed Work, the dependency graph was 7 levels deep across 10 slices with a maximum parallel width of 2, and **all 6** single-parent slices named as parent exactly the slice holding the previous acceptance-criterion block. Dependencies were spec reading order, not causality.
- **Consequences:** A false dependency cannot be detected mechanically, so this makes it visible and costly to write rather than pretending to catch it. Requiring a justification is the enforcement; the depth report is the signal.

### D-5: The Slice Design is written for the human who must approve it

- **Decision:** Replace the six-label Design Check with a Markdown document that states what is changing, what is unresolved, the shape as type and method signatures in a fenced code block, the call order, and a closing list of decisions to answer. Remove the 2 KiB cap. Produce it before implementation for the root slice and any architecture-sensitive slice.
- **Why:** The current Design Check is prose *about* code containing no signatures, compressed by a 2 KiB budget into garden-path sentences, and organised by the schema's categories rather than the reader's questions. A design the human cannot verify provides no steering, which is the entire justification for producing it early. The 2 KiB cap is a model-output budget applied to a human-read artifact.
- **Consequences:** Design output roughly doubles in size, against hours of manual debugging per escaped defect. `sliceStableBlock` already places a `designCheck` in the byte-stable prefix-cached region, so producing it *before* implementation increases cache reuse — today the first implementation call cannot carry a design that does not yet exist. No new gate is introduced: the existing per-slice `hitl` flag and auto mode decide who waits.

## Engineering Quality Contract

- **Always-on obligations:** Every change traces to an acceptance criterion in this specification. New behavior lands with a test in `skills/pair-v3/tests/`. `npm run validate` passes before completion. No credential, probe output, or runtime environment value is persisted verbatim. Existing Works without `.pair/runtime.json` continue to run unchanged.
- **Fact-activated obligations:**
  - *Manifest schema changes* → `review-slice-manifest.js` validation and its tests are updated together, and a manifest written before this Work still validates. Owner: implementation session.
  - *Process lifecycle is introduced* → teardown is proven to run on abnormal exit, not only on the success path. Owner: implementation session; exclusion requires human authority.
  - *Prompt assembly is touched* → the prefix-cache assertion in the prompt tests must still hold. Owner: implementation session.
  - *A skill's rule text changes* → the doc test pinning that phrase is updated in the same slice. Owner: implementation session.

## Acceptance Criteria

- [ ] AC-1: The brainstorming skill presents the Review Slice Manifest for human approval before publishing it, and no longer describes it as scheduling metadata.
- [ ] AC-2: A repository can declare `.pair/runtime.json` with `up`, `ready`, `down`, and `env`; an invalid declaration is rejected with a message naming the offending field.
- [ ] AC-3: A Review Slice accepts an optional `probe` command, and a slice without one is rejected unless it carries a `probe_waived` reason.
- [ ] AC-4: The engine runs `up` once per Work, polls `ready` until it succeeds or times out, and does not run `up` again for a later slice in the same Work.
- [ ] AC-5: The Work's worktree name is present in the environment of the `up` command, and no file outside the Work's own `.pair/` directory is written to target the runtime.
- [ ] AC-6: After a slice's `verify` succeeds, its `probe` runs against the live runtime, and a failing probe blocks the slice exactly as a failing verify does.
- [ ] AC-7: Cumulative completion verification runs the distinct set of probe commands in addition to the distinct set of verify commands.
- [ ] AC-8: `down` runs at completion, at block, and on abnormal termination, leaving no instance pointing at the Work's worktree.
- [ ] AC-9: Every waived probe is listed with its reason in the completion report.
- [ ] AC-10: Each `depends_on` entry carries a justification, and manifest validation reports chain depth and maximum parallel width.
- [ ] AC-11: The Slice Design is emitted as Markdown containing a fenced signature block, an explicit call order, and a closing decision list, and is not truncated by a byte cap.
- [ ] AC-12: The Slice Design for the root slice is produced before its implementation call, and appears in that call's slice-stable prompt region.
- [ ] AC-13: A Work whose repository has no `.pair/runtime.json` and whose slices declare no probe runs exactly as it did before this Work.

## Verification

### AC-1
- **Proof:** `node --test skills/brainstorming/tests/*.test.js` — a doc test asserts `SKILL.md` no longer contains "scheduling metadata" and does contain the manifest-approval step.

### AC-2
- **Proof:** `node --test skills/pair-v3/tests/runtime-declaration.test.js` — a valid declaration parses; each of a missing `up`, a missing `ready`, and a non-string `down` is rejected with the field named in the error.

### AC-3
- **Proof:** `node --test skills/pair-v3/tests/review-slice-manifest.test.js` — a slice with a probe validates; a slice with neither `probe` nor `probe_waived` is rejected.

### AC-4
- **Proof:** `node --test skills/pair-v3/tests/runtime-observation.test.js` — a fake runtime records invocations; a two-slice Work yields exactly one `up` and one `ready` poll sequence.

### AC-5
- **Proof:** Same suite — the recorded `up` invocation's environment contains the worktree name, and a filesystem snapshot taken before and after shows no write outside `.pair/`.

### AC-6
- **Proof:** Same suite — a slice whose probe exits non-zero reaches `blocked`, and the event log records `probe-finished` with a non-zero status.

### AC-7
- **Proof:** `node --test skills/pair-v3/tests/completion-and-index.test.js` — a manifest with two distinct probes and one shared verify command produces three completion executions, and the recorded commands include both probes.

### AC-8
- **Proof:** `node --test skills/pair-v3/tests/runtime-observation.test.js` — `down` is recorded on the completion path, on the blocked path, and when the engine is terminated mid-Work.

### AC-9
- **Proof:** Same suite — a Work with one waived slice produces a completion report containing that slice's id and its stated reason.

### AC-10
- **Proof:** `node --test skills/pair-v3/tests/review-slice-manifest.test.js` — an unjustified `depends_on` is rejected; a 7-deep fixture graph reports depth 7 and width 2.

### AC-11
- **Proof:** `node --test skills/pair-v3/tests/pair-vnext-engine.test.js` — a produced Slice Design contains a fenced code block, a call-order line, and a decision list, and a design exceeding 2 KiB is preserved intact.

### AC-12
- **Proof:** Same suite — for a root slice, the design is produced before the implementation call, and `promptPrefix` for that call contains the design text.

### AC-13
- **Proof:** `npm run test:pair` — the pre-existing suite passes unchanged, and an end-to-end fixture Work with no runtime declaration completes without any runtime invocation.

## Out of Scope

- Numeric metric targets per slice and any iterate-until-a-number loop.
- Reformatting prompts or model output from JSON or prose to XML. Measured at +9.2% on this repository's real payloads, and it would replace schema validation with a hand-written parser.
- Changes to `LocalDevInfra`. Worktree targeting already exists there and is driven entirely by environment.
- Probes that drive an LLM path. Search and answer quality is a separate concern with a different, nondeterministic harness.
- Compaction and session freshness. Already solved by warm-session rotation and always-fresh reviews.
- Any change to how many corrections a slice may spend.
