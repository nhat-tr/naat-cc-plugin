#!/usr/bin/env -S node --experimental-strip-types
// get-vulns — bundled with the kube-vuln skill.
//
// Reads Trivy Operator VulnerabilityReport CRDs from the current kubectl context/namespace,
// deduplicates CVEs across services, and emits structured JSON for agent analysis.
//
// Usage: ~/.local/share/my-claude-code/skills/kube-vuln/scripts/get-vulns.ts [--severity HIGH,CRITICAL]
//
// Output JSON shape:
//   { context, services[], highAndCritical[] }

import { execSync } from "node:child_process";

type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";

interface KubeVulnItem {
  metadata: { name: string };
  report: {
    artifact: { repository: string; tag: string };
    summary: {
      criticalCount: number;
      highCount: number;
      mediumCount: number;
      lowCount: number;
      unknownCount: number;
    };
    vulnerabilities: Array<{
      vulnerabilityID: string;
      severity: Severity;
      resource: string;
      installedVersion: string;
      fixedVersion?: string;
      title?: string;
      description?: string;
      links?: string[];
    }>;
  };
}

interface CveEntry {
  id: string;
  severity: Severity;
  resource: string;
  installedVersion: string;
  fixedVersion: string;
  title: string;
  links: string[];
  affectedServices: string[];
}

function run(cmd: string): string {
  return execSync(cmd, { encoding: "utf-8" }).trim();
}

function parseArgs(): { severities: Severity[] } {
  const sevArg = process.argv.find((a) => a.startsWith("--severity="))?.split("=")[1];
  const severities: Severity[] = sevArg
    ? (sevArg.split(",").map((s) => s.trim().toUpperCase()) as Severity[])
    : ["CRITICAL", "HIGH"];
  return { severities };
}

const { severities } = parseArgs();

// Gather context
const cluster = (() => {
  try { return run("kubectl config current-context"); } catch { return "unknown"; }
})();
const namespace = (() => {
  try {
    return run("kubectl config view --minify --output jsonpath={.contexts[0].context.namespace}") || "default";
  } catch { return "default"; }
})();

// Fetch reports
let raw: string;
try {
  raw = run("kubectl get vuln -o json");
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("No resources found") || msg.includes("the server doesn't have a resource type")) {
    console.log(JSON.stringify({
      error: "no_reports",
      detail: "No VulnerabilityReport CRDs found. Trivy Operator may not be installed, or no scans have run yet.",
      context: { cluster, namespace },
    }, null, 2));
    process.exit(0);
  }
  throw err;
}

const items: KubeVulnItem[] = JSON.parse(raw).items ?? [];

// Service summary
const services = items.map((item) => ({
  name: item.metadata.name,
  repository: item.report.artifact.repository,
  tag: item.report.artifact.tag,
  critical: item.report.summary.criticalCount,
  high: item.report.summary.highCount,
  medium: item.report.summary.mediumCount,
  low: item.report.summary.lowCount,
  unknown: item.report.summary.unknownCount,
}));

// Deduplicate CVEs by ID across services
const cveMap = new Map<string, CveEntry>();
for (const item of items) {
  const repo = item.report.artifact.repository;
  for (const v of item.report.vulnerabilities ?? []) {
    if (!severities.includes(v.severity)) continue;
    if (!cveMap.has(v.vulnerabilityID)) {
      const firstSentence = (v.title ?? v.description ?? "").split(/\.\s/)[0].replace(/\n/g, " ").trim();
      cveMap.set(v.vulnerabilityID, {
        id: v.vulnerabilityID,
        severity: v.severity,
        resource: v.resource,
        installedVersion: v.installedVersion,
        fixedVersion: v.fixedVersion ?? "",
        title: firstSentence,
        links: v.links ?? [],
        affectedServices: [],
      });
    }
    const entry = cveMap.get(v.vulnerabilityID)!;
    if (!entry.affectedServices.includes(repo)) {
      entry.affectedServices.push(repo);
    }
  }
}

// Sort: CRITICAL before HIGH, then most-affected services first
const severityOrder: Record<string, number> = { CRITICAL: 0, HIGH: 1 };
const highAndCritical = [...cveMap.values()].sort((a, b) => {
  const sevDiff = (severityOrder[a.severity] ?? 9) - (severityOrder[b.severity] ?? 9);
  if (sevDiff !== 0) return sevDiff;
  return b.affectedServices.length - a.affectedServices.length;
});

console.log(
  JSON.stringify(
    {
      context: { cluster, namespace },
      services,
      highAndCritical,
      meta: {
        totalServices: services.length,
        totalUniqueCves: highAndCritical.length,
        fixable: highAndCritical.filter((c) => c.fixedVersion).length,
        noFixYet: highAndCritical.filter((c) => !c.fixedVersion).length,
      },
    },
    null,
    2,
  ),
);
