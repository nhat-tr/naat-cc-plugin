---
description: Diagnose and fix a bug or issue. Systematically reproduces, isolates, and resolves the root cause. Uses sonnet for fast, structured debugging loops.
---

# Troubleshoot

Follow these steps IN ORDER. Do not skip steps. Do not rewrite the user's problem into specific debugging steps — pass the raw problem to the troubleshooter and let it follow its own process.

## Step 1: Detect issue type and environment

Read the user's message. If it mentions a deployed environment (OAE, QSS, prod, staging, production, cluster, Jaeger, Kibana, logs, traces) — it is a **production issue**. Otherwise it is a **local issue**.

For production issues, **extract the target environment** (oae, qss, or prod) from the user's message. Default to `prod` if they say "production" or "PROD". You MUST include this environment in every subagent prompt in Step 3 — agents will query the wrong environment if you don't pass it explicitly.

## Step 2: Check observability data (all issues)

Check if `.observability/` exists in the project root.

If `.observability/playbooks/index.yaml` exists:
- Read it. Scan triggers for keyword overlap with the user's issue.
- If a playbook matches, read the playbook file. Include its content in the troubleshooter prompt so the agent has domain-specific diagnostic steps.

If `.observability/logs.json` or `.observability/traces.json` exists:
- Read them. Search entries for keywords from the user's issue (class names, method names, error types, feature names).
- Include matching entries in the troubleshooter prompt so the agent knows which files, methods, and instrumentation points are relevant.

## Step 3: Production investigation (production issues only)

For production issues, gather live data BEFORE spawning the troubleshooter:

1. If matching trace entries were found in step 2, use the **jaeger-analyst** agent to search for those span names in the target environment.
2. If matching log entries were found in step 2, use the **kibana-analyst** agent to search for those log templates in the target environment.
3. If no index entries matched, use jaeger-analyst and kibana-analyst with the user's keywords directly.
4. **Cross-tool correlation**: If Kibana results contain trace IDs with errors, pass those trace IDs to the jaeger-analyst for span waterfall analysis. Include both Kibana log context AND Jaeger span analysis in the troubleshooter prompt.

Include the results (or "no results found") in the troubleshooter prompt.

**If an agent spawn is denied:** Do NOT speculate about why. Fall back to calling the CLI tool directly via Bash:
- Kibana: `tsx /Users/nhat.tran/.local/share/my-claude-code/infra/kibana/kibana-search.ts <env> <index> -j '<query>'`
- Jaeger: `tsx /Users/nhat.tran/.local/share/my-claude-code/infra/jaeger/jaeger-search.ts <env> -j '<query>'`
- Grafana: `tsx /Users/nhat.tran/.local/share/my-claude-code/infra/grafana/grafana-query.ts <env> -j '<query>'`

Continue the investigation with direct calls — do not stop or ask the user to debug permissions.

## Step 3.5: Verify investigation completeness (production issues only)

Before spawning the troubleshooter, verify the observability investigation covered the user's request:

1. **Date coverage**: If the user mentioned multiple dates or a date range, verify the Kibana results include data from ALL those dates. If any date is missing, run a targeted kibana-analyst query for that period.
2. **Service coverage**: If the issue mentions multiple services, verify logs were checked in all relevant indices or with service filters.
3. **Trace correlation**: If Kibana results contain identifiers at INFO level but no errors, verify at least one trace was correlated to check for errors on the same request flow.
4. **Error→Context link**: If only errors were found, verify the preceding request logs were checked for the same trace. If only INFO logs were found, verify the trace was correlated.

Emit a structured checklist before proceeding:
```
Step 3.5 checklist:
- Date coverage: [dates with hits] vs [dates requested] → PASS/FAIL
- Service coverage: [indices searched] vs [indices requested] → PASS/FAIL
- Trace correlation: [N traces correlated, errors found: Y/N] → PASS/FAIL
- Error→Context link: [errors linked to requests: Y/N] → PASS/FAIL
```
Do NOT proceed to step 4 until all checks pass.

## Step 4: Decide — report directly or spawn troubleshooter

Evaluate whether the observability findings from Steps 3–3.5 are **conclusive** — meaning ALL of these are true:

1. **Root cause is clear from logs/traces alone**: error messages, HTTP status codes, and response bodies identify the exact failure (e.g., `PropertyNotFound`, `404`, `timeout`).
2. **No code investigation needed**: the fix is already obvious (e.g., the current branch is the hotfix, or a config change is needed), OR the user only asked "what happened" — not "why" or "how to fix."
3. **No ambiguity**: there is only one plausible explanation for the observed errors, not multiple competing hypotheses.

### If conclusive → report directly

Summarize the findings yourself. Do NOT spawn the troubleshooter. Include:
- **Timeline**: what happened, when, with trace IDs
- **Root cause**: the specific error and why it occurred (from log/trace evidence only — do not speculate about code)
- **Impact**: how many traces/requests failed, date range affected
- **Next step**: what action to take (deploy, rollback, config change, manual fix), if obvious from context

This saves ~50k tokens and ~90s vs spawning a troubleshooter that would just confirm what the logs already show.

### If not conclusive → spawn troubleshooter

Launch the **troubleshooter** agent (`subagent_type: "troubleshooter"`) with a prompt containing:

1. The user's original problem description (verbatim — do NOT rewrite it into debugging steps)
2. Any matching playbook content from step 2
3. Any matching index entries from step 2
4. Kibana findings: summary block + relevant log lines + trace correlation results from step 3
5. Jaeger findings: error chain summary (not full waterfall — summarize to error-relevant spans)
6. The environment context (which env, what was observed)
7. **Coverage note**: Which dates, services, and environments were searched

Do NOT tell the troubleshooter which files to read or what order to investigate. Let it follow its own systematic process.

**When in doubt, spawn the troubleshooter.** The escape hatch is for clear-cut cases, not borderline ones.

## Step 5: Do not duplicate work

After spawning the troubleshooter, wait for it to complete. Do NOT continue your own investigation in parallel — that wastes context reading the same files.

If the troubleshooter's findings are incomplete, you may do follow-up investigation or spawn additional agents (kibana, jaeger, grafana) based on what the troubleshooter found.
