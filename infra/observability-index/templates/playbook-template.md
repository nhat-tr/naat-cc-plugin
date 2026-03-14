---
name: <short-identifier>
title: <human-readable title>
triggers:
  - <keyword or phrase the agent matches against>
  - <another trigger>
services: [<service-names this applies to>]
tools: [kibana, jaeger, grafana]  # which tools are used
---

# <Title>

## Symptoms
<What the user reports or what alerts fire>

## Investigation Steps

### Step 1: <action>
**Tool:** kibana | jaeger | grafana
**Query:** <exact query or template>
**Look for:** <what to check in the results>
**If found:** <next action or conclusion>
**If not found:** <alternative path>

### Step 2: Correlate by traceId
**Tool:** kibana
**Query:** Search for all logs matching the traceId from Step 1
**Look for:** <preceding errors, state transitions, timing>

### Step 3: <action>
...

## Root Causes
| Pattern | Cause | Fix |
|---------|-------|-----|
| <what you see> | <why it happens> | <what to do> |

## Notes
<Additional context, edge cases, related playbooks>
