---
name: az-pr
description: "Use this skill WHENEVER the user wants to create, update, or complete/finish a pull request in Azure DevOps (ADO) — across one repo or several. Trigger phrases: 'open a PR', 'raise a PR for this', 'create PRs for these repos', 'publish my PR', 'update the PR description/title', 'set the PR to auto-complete', 'complete/finish/merge my PR', 'squash and complete'. It writes concise bullet-point descriptions that always link the Jira ticket, and returns just the PR URLs. Delegates the mechanical `az repos pr` work to a cheap-model subagent, so it is safe to use even from an expensive Opus/Fable session. NOT for reviewing a PR or responding to review comments (use az-pr-review / az-review-response), and NOT for the vulnerability batch-fix flow (use vuln-autofix)."
---

# az-pr — Azure DevOps PR lifecycle

Create / update / complete PRs in Azure DevOps. The mechanical work — reading
diffs, writing the description, running `az repos pr` — runs on the **`az-pr`
subagent (sonnet)**, not here. Your job in this (main) session is only the two
things a subagent can't do: get the **ticket** and get the **one approval**.
That keeps an expensive Opus/Fable session off rote work.

## Delegate the work

Do **not** run the `az`/CLI commands yourself. Spawn the `az-pr` agent
(`subagent_type: "az-pr"`, model sonnet) with a standalone brief: the action,
the target repos+branches (or PR ids), the ticket key, and whether it may
`--execute` or must preview. The bundled CLI lives at
`scripts/az-pr.ts` (see the agent for its flags). Sonnet is the default because
the agent reads diffs and writes the change bullets; if you're handing it the
bullets ready-made, haiku is enough.

For several repos, spawn one agent per repo in a single message so they run in
parallel.

## The two things you own

**1. The ticket (auto-detect, else ASK HUMAN).** Every PR description must link
its Jira ticket: `https://hoffmann-group-digital.atlassian.net/browse/<KEY>`.
Find the key (pattern `[A-Z]+-\d+`, e.g. `SCD-28`) in this order: the user's
message → the branch name → recent commit messages. If none of those yield a
ticket, **stop and ask the user for it** — never fabricate one, and never open
the PR without it. (The CLI enforces this too: it errors when the ticket is
missing, and the agent reports `NEED_TICKET` back to you.)

**2. The one approval gate.** Before any PR is created or completed, the agent
previews in dry-run (proposed repo, title, bullets). Show that set and get a
single "go" for the whole batch. If the user's request already clearly
authorized it (e.g. "create and complete the PRs for SCD-28"), treat that as the
go and skip the extra round-trip. Do not re-ask per repo once approved.

## The description contract

Concise. Prefer **one `- ` bullet per change**, imperative. When a PR genuinely
needs more (context prose, a submodule SHA, a related-PR reference), a
hand-written body is fine — pass it through the CLI's `--body-file`, not by
hand. Either way the `Ticket <KEY>: <url>` line is prepended automatically.

**The ticket line is only guaranteed on the CLI's path.** So the agent must
never run `az repos pr create|update` directly or hand-write a `--description` —
that silently drops the ticket link (it happened on the first live run). If a PR
is found missing the link, backfill it with `az-pr ensure-ticket --id <n>
--ticket <KEY>` rather than raw `az`.

## No completing over a conflict

Before completing, the agent checks each PR's `mergeStatus` (`az-pr status
--id <n>`). Auto-complete on a conflicted PR just stalls, so if any PR shows
`conflicts`, **surface it to the user instead of completing** — with the
diagnosis when it's the common *false submodule conflict* (both `origin/master`
and the branch advanced the `Common` gitlink along a linear history, so the
descendant pin is the safe resolution). Resolving a conflict rewrites the
developer's branch, so it needs an explicit go — never resolve-and-push silently.

## Completion defaults

"Complete"/"finish" a PR means **auto-complete + squash + delete source branch**
(`az-pr complete --id <n> --execute`). Auto-complete merges the PR once required
approvals and branch policies pass — it is not a forced merge, so it is safe on
protected branches. Override only if the user asks (`--no-squash`,
`--keep-source`, `--merge-message`).

## Output contract

When done, return **only the list of PR URLs** — one per line, no explanation,
no summary table. That is the entire deliverable the user asked for.
