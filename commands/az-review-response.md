---
description: Fetch all active comment threads from an Azure DevOps PR review, read the relevant code in context, and produce a structured analysis with a proposed response for each thread (fix, challenge, alternative, or clarify). Use when the user says things like "there are comments on my PR", "someone reviewed my PR", "respond to PR comments", "analyze review feedback", or provides a PR ID and wants to deal with incoming reviewer comments.
---

Delegate now via the Agent tool with `subagent_type: "az-review-response"`, passing the PR id (or "detect from branch") and any user instructions verbatim in the prompt. The multi-thread triage runs in the subagent's own context — do NOT execute it inline. Relay the subagent's overview and per-thread drafts back to the user unchanged.
