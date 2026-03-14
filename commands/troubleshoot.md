---
description: Diagnose and fix a bug or issue. Systematically reproduces, isolates, and resolves the root cause. Uses sonnet for fast, structured debugging loops.
---

# Troubleshoot

Follow these steps IN ORDER. Do not skip steps. Do not rewrite the user's problem into specific debugging steps — pass the raw problem to the troubleshooter and let it follow its own process.

## Step 1: Detect issue type

Read the user's message. If it mentions a deployed environment (OAE, QSS, prod, staging, production, cluster, Jaeger, Kibana, logs, traces) — it is a **production issue**. Otherwise it is a **local issue**.

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

Include the results (or "no results found") in the troubleshooter prompt.

## Step 4: Spawn troubleshooter

Launch the **troubleshooter** agent (`subagent_type: "troubleshooter"`) with a prompt containing:

1. The user's original problem description (verbatim — do NOT rewrite it into debugging steps)
2. Any matching playbook content from step 2
3. Any matching index entries from step 2
4. Any Kibana/Jaeger results from step 3
5. The environment context (which env, what was observed)

Do NOT tell the troubleshooter which files to read or what order to investigate. Let it follow its own systematic process.

## Step 5: Do not duplicate work

After spawning the troubleshooter, wait for it to complete. Do NOT continue your own investigation in parallel — that wastes context reading the same files.

If the troubleshooter's findings are incomplete, you may do follow-up investigation or spawn additional agents (kibana, jaeger, grafana) based on what the troubleshooter found.
