---
description: Seed .claude-loop.md (goal, acceptance criteria, task checkboxes) so the stop-gate guards a long /loop run, then print the recommended /loop invocation.
---

# Loop Plan — gate-protected long runs

`.claude-loop.md` is the state file the Stop hook (`stop-gate.sh`) watches: while
it contains unchecked `- [ ]` tasks, the agent cannot end its turn as "done".
This command seeds it from the current task so a `/loop` run is self-driving
AND self-verifying, and survives context compaction (state lives in the file,
not the conversation).

## Steps

1. Derive from the current conversation (or `$ARGUMENTS`): the goal, concrete
   acceptance criteria, and a task breakdown. If the task is too vague to
   write acceptance criteria, STOP and ask — a loop without a done-condition
   burns iterations (do not invent criteria silently).
2. Write `.claude-loop.md` in the repo root:

   ```markdown
   # Goal: <one sentence>

   ## Acceptance Criteria
   - [ ] <observable criterion — a test passes, a page renders, a command outputs X>
   - [ ] Tests pass; no new lint errors

   ## Tasks
   <!-- TDD order: failing tests first, implementation after, integration test mandatory -->
   - [ ] write failing tests for <behavior> — files: `tests/...`
   - [ ] implement <task> to make the tests pass — files: `path/to/file`
   - [ ] integration test: <end-to-end scenario> — files: `tests/...`

   ## Log
   <!-- one line per wakeup: what was done, what is next -->
   ```

3. Keep state files out of version control: if `.git/info/exclude` does not
   already list it, append `.claude-loop.md` to `.git/info/exclude`.
4. Report to the user, then print BOTH start commands with this guidance:

   **Riding token limits** (expecting to exhaust quota and resume when it
   refreshes — overnight runs): use the interval form. Interval wakeups are
   harness timers, independent of model availability — ticks during the outage
   are no-ops, and the first tick after the quota refresh re-reads
   `.claude-loop.md` and continues exactly where it left off:

   ```
   /loop 1h work through .claude-loop.md: re-read it first, do the next
   unchecked task, mark finished tasks [x], append one Log line, and stop only
   when every box is checked and the acceptance criteria hold.
   ```

   **Actively working within quota** (no limit expected): the self-pacing form
   (`/loop` without an interval) wastes fewer wakeups — but a hard quota cutoff
   can break its chain, since the model must be able to run to schedule its own
   next wakeup. Do not use it for runs meant to outlive a limit.

   In both forms the stop-gate blocks premature "done" between wakeups.

## Rules for the looping agent

- Re-read `.claude-loop.md` at the START of every wakeup — it is the source of
  truth, not conversation memory (which may have been compacted).
- Never game the gate: no checking boxes without the work, no editing tests or
  weakening criteria to pass. "No change needed" is recorded as a note, not
  fake work.
- If blocked on something only the human can decide, write the question under
  the task, check nothing, and ask — the gate's no-progress cap (5) will
  eventually allow a stop rather than looping forever.
