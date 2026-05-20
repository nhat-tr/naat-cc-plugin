---
description: Search and filter service logs from Elastic Cloud / Elasticsearch. Translates natural language queries to ES Query DSL and displays results.
---

Always delegate this request to the `kibana-analyst` subagent using the Agent tool with `subagent_type: kibana-analyst`. Pass the user's full log search request as the task. Do NOT follow the kibana instructions inline — always spawn the subagent.
