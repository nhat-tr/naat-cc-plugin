---
name: az-pr-fix
description: "Use this skill WHENEVER the user wants to act on review comments left on their own Azure DevOps PR — specifically the ones they have triaged with a thumb-up (👍) reaction. Trigger phrases: 'fix the PR comments', 'fix the ones I thumbed up', 'check the open comments and fix them', 'apply the reviewer feedback', 'I liked the comments I agree with, do them'. The thumb-up IS the work order: the user reads the review in the browser (or nvim), likes the comments they accept, and this skill turns exactly those into code changes. NOT for creating/completing PRs (use az-pr), NOT for reviewing someone else's PR (use az-pr-review), and NOT for drafting written replies without code changes (use az-review-response)."
---

# az-pr-fix — fix the PR comments you thumbed up

The user triages review feedback by reacting 👍 to the comments they accept.
Everything else — comments they disagree with, questions already answered in
chat, Sonar noise — stays unliked and is **not** your work. Your job is to turn
the liked set, and only the liked set, into code changes.

## Step 1: Pull the comments

`az-pr-comments` is on PATH (it is the same script nvim's `<leader>nf` shells
out to, so the data matches what the user sees in their notes buffer):

```bash
az-pr-comments --detect --format json    # detects the PR from the current branch
az-pr-comments <PR_ID> --format json     # or pass the id explicitly
```

It returns `activeThreads` (unresolved) and `resolvedThreads`, each comment
carrying `author`, `content`, and **`likedBy`** — the display names who reacted
👍. Sonar/bot threads are excluded by default and reported as a count under
`hidden`; leave them out unless the user asks (`--include-sonar`).

## Step 2: Filter to the liked, unresolved threads

```bash
az-pr-comments --detect --format json | jq '[
  .activeThreads[]
  | select(any(.comments[]; (.likedBy | length) > 0))
  | { threadId, filePath, line,
      liked: [.comments[] | select((.likedBy | length) > 0) | {author, content, likedBy}],
      thread: [.comments[] | {author, content}] }
]'
```

Three rules that decide what you actually implement:

- **Unresolved only.** A thread already marked `fixed`/`closed` is done, even if
  it is liked. Work from `activeThreads`.
- **The liked comment is the instruction; the rest of the thread is context.**
  Threads run long — a reviewer's follow-up may soften, widen, or merely explain
  the original ask. Implement what the *liked* comment says, and read the
  unliked replies only to disambiguate it. When a later unliked reply clearly
  supersedes the liked one, say so and ask rather than guessing.
- **Check who liked it.** Normally it is the PR author doing their own triage.
  If `likedBy` names someone else, or different threads have different likers,
  surface that instead of assuming it is a work order.

If the filter comes back empty, do not fall back to "fix all the open comments"
— report that nothing is liked and ask which threads to take.

## Step 3: Fix them

Report the matched set first — one line per thread (`T:<id> <file>:<line> —
<gist>`) — so the user can see their triage was read correctly. Then work each
one.

Comments point at a line, not at a root cause. `filePath`/`line` are the
reviewer's cursor position on the diff, and are frequently stale or one file
away from the real fix; treat them as a starting point and confirm against the
current code before editing. Two recurring shapes:

- **A missing-translation / missing-string comment** is rarely a one-file fix —
  the key has to exist in *every* locale bundle, not just the one the reviewer
  screenshotted. Find how sibling keys are registered and match that.
- **A "this is the wrong pattern" comment** (drop the effect, move it into the
  handler, delete the noise) means the pattern goes, not that it gets renamed.
  Do the removal the reviewer asked for; do not leave a shim behind.

A thread whose liked comment is a *question* rather than an instruction has no
code change to make. Answer it in the report and leave the code alone.

**Leave no comment behind when the fix is done.** Do not annotate your own work:
no `// fixed per review`, no note naming the reviewer, the thread, or a review
finding (`see F3 in the PR review`), no comment whose only job is to explain the
change you just made. Those read as useful while the diff is open and as noise
forever after — the reviewer is reading the diff, and everyone after them is
reading the code. Explain the change in the report, not in the source.

The same restraint applies to the code you write to *implement* a fix. A comment
earns its place by carrying what the code cannot: an external contract being
mirrored, a business rule with no local expression, a non-obvious trap the next
edit would walk into. Delete anything that restates the line below it, narrates
what changed, or argues for a decision that is already visible. When a comment
is genuinely needed, one sentence usually does it.

## Step 4: Report, then let the user close the loop

Report per thread: what changed, at `file:line`, and anything you deliberately
did not do. Threads that need a decision go at the top, not buried.

Do **not** post replies or resolve threads on your own — the user owns their PR
conversation. Replies go through the bundled script when they ask for them:

```bash
echo "Fixed in <commit/file>" | tsx ~/.local/share/my-claude-code/infra/azure-devops/reply-pr-comment.ts \
  --pr <PR_ID> --thread <THREAD_ID>
```

Same for committing and pushing — only when asked.
