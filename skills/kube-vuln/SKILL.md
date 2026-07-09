---
name: kube-vuln
description: "Use this skill WHENEVER the user wants to check, inspect, triage, or understand container image vulnerabilities in a Kubernetes namespace — even if they don't say 'vulnerability' or 'CVE'. Trigger phrases: 'check vulns', 'what CVEs do we have', 'security scan results', 'which services have HIGH issues', 'fix the vulnerabilities in <namespace>', 'what's vulnerable in <env>', 'show me the security report', 'trivy report', 'vuln report', 'are we clean on CVEs'. Always delegate to a subagent with model=haiku. The subagent runs the bundled get-vulns.ts script, then analyzes the output and produces an actionable triage report."
---

# Kube Vulnerability Skill

Reads Trivy Operator `VulnerabilityReport` CRDs via the bundled `get-vulns.ts` script and produces an actionable triage report.

## Always delegate to a subagent

Spawn an Agent immediately:
- `model`: `haiku`
- `description`: `Kubernetes vulnerability triage`

Pass the following as the subagent prompt, substituting context from the conversation where shown.

---

## Subagent prompt template

```
## Context
ENV from conversation (QSS or PROD, if specified): {{ENV}}
Namespace from conversation (if specified): {{NAMESPACE}}

## Step 1 — Switch context if requested

If the user specified an ENV, run:
  kubectl dsp env {{ENV}}

If the user specified a namespace, run:
  kubectl dsp component {{NAMESPACE}}

Skip this step entirely if neither was specified — use the current context as-is.

## Step 2 — Run the data collection script

Run the bundled script with its full path — do not use a shell variable:
  ~/.local/share/my-claude-code/skills/kube-vuln/scripts/get-vulns.ts

Capture stdout. If the JSON contains `"error": "no_reports"`, report that Trivy Operator
is not installed or no scans have run yet, and stop.

## Step 3 — Analyze the JSON output and produce the report

The script outputs JSON with these top-level fields:
  context        — { cluster, namespace }
  services[]     — one entry per VulnerabilityReport (name, repository, tag, critical, high, medium, low, unknown)
  highAndCritical[] — deduplicated CVEs filtered to HIGH/CRITICAL only, sorted CRITICAL-first then by # affected services
  meta           — { totalServices, totalUniqueCves, fixable, noFixYet }

Produce the following report in markdown:

### Cluster & namespace
State the cluster and namespace from `context`.

### Service summary
Markdown table:
| SERVICE | TAG | CRITICAL | HIGH | MEDIUM | LOW | UNKNOWN |
One row per entry in `services[]`. Omit the UNKNOWN column if all values are 0.
Highlight (bold) any row with CRITICAL > 0.

### HIGH & CRITICAL CVEs — deduplicated
Markdown table:
| CVE | SEVERITY | PACKAGE | INSTALLED | FIXED IN | AFFECTED SERVICES |

For `FIXED IN`: if `fixedVersion` is empty, write `— no fix yet`.
For `AFFECTED SERVICES`: list the short service names (last path segment of repository), comma-separated.

### Remediation

**Fixable now** (`fixedVersion` non-empty):
For each CVE in this group, write:
  - `<CVE-ID>` — upgrade `<resource>` from `<installedVersion>` → `<fixedVersion>`
    Affects: <service list>

If multiple CVEs share the same package and fix version, merge them into one bullet:
  - Upgrade `<package>` to `<fixedVersion>` — fixes <CVE list> in <service list>

**No upstream fix yet** (`fixedVersion` empty):
For each CVE in this group, write:
  - `<CVE-ID>` (`<severity>`) — `<resource>` `<installedVersion>` — monitor: <links[0] or "no link">

### Prioritised action list

Numbered steps, most impactful first:
1. CRITICAL fixes (if any)
2. HIGH fixes with available fix versions, ordered by number of affected services
3. HIGH with no fix yet — monitor
4. Recommend rebuilding base images if multiple CVEs are in OS-level packages (glibc, openssl, libssl, zlib, etc.)
```

---

## After the subagent returns

Present the report directly to the user. If they ask to drill into a specific CVE or service, spawn a second subagent (same model) with the raw JSON output and the targeted question — do not re-run the script unless the user asks for a fresh scan.
