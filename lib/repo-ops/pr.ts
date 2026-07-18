// pr — Azure DevOps PR creation via `az repos pr create` (spec D7).
//
// Rejection Criterion 2: no push/PR without an explicit confirmation gate.
// That gate lives in the skill; this module enforces the mechanical half —
// `openPr` performs zero process execution when `dryRun` is true.

import { run } from "./sh.ts";
import type { PrResult } from "./types.ts";

export interface OpenPrArgs {
  repoPath: string;
  repoName: string;
  branch: string;
  targetBranch: string;
  title: string;
  description: string;
  dryRun: boolean;
  /** ServiceRepo.remoteUrl, if known. Used to derive --org/--project/--repository
   * so the PR lands in the repo's own Azure DevOps org/project rather than
   * whatever `az devops configure --defaults` happens to point at. */
  remoteUrl?: string;
}

/**
 * Parse an Azure DevOps git remote URL into the addressing Azure CLI needs:
 * organization URL, project name, and repository name. Handles the three
 * remote forms the workspace's repos actually use:
 *   - SSH v3:                 <user>@vs-ssh.visualstudio.com:v3/<org>/<project>/<repo>
 *   - HTTPS dev.azure.com:    https://[<user>@]dev.azure.com/<org>/<project>/_git/<repo>
 *   - HTTPS *.visualstudio.com: https://<org>.visualstudio.com/<project>/_git/<repo>
 * Project and repo segments are URL-decoded (e.g. `%20` -> space). Returns
 * null when the URL doesn't look like an Azure DevOps remote at all.
 */
export function parseAzureRemote(url: string): { orgUrl: string; project: string; repo: string } | null {
  const trimmed = url.trim();

  const sshV3 = /^[^@\s]+@vs-ssh\.visualstudio\.com:v3\/([^/]+)\/([^/]+)\/([^/]+)\/?$/.exec(trimmed);
  if (sshV3) {
    const [, org, project, repo] = sshV3;
    return {
      orgUrl: `https://dev.azure.com/${org}`,
      project: decodeURIComponent(project),
      repo: decodeURIComponent(repo),
    };
  }

  const httpsDevAzure =
    /^https:\/\/(?:[^@/\s]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+)\/?$/.exec(trimmed);
  if (httpsDevAzure) {
    const [, org, project, repo] = httpsDevAzure;
    return {
      orgUrl: `https://dev.azure.com/${org}`,
      project: decodeURIComponent(project),
      repo: decodeURIComponent(repo),
    };
  }

  const httpsVisualStudio = /^https:\/\/([^./\s]+)\.visualstudio\.com\/([^/]+)\/_git\/([^/]+)\/?$/.exec(trimmed);
  if (httpsVisualStudio) {
    const [, org, project, repo] = httpsVisualStudio;
    return {
      orgUrl: `https://dev.azure.com/${org}`,
      project: decodeURIComponent(project),
      repo: decodeURIComponent(repo),
    };
  }

  return null;
}

/**
 * Build the argv (without the leading `az`) for `az repos pr create`. The
 * CVE-bearing title/description must survive verbatim. Org/project/repository
 * addressing is derived explicitly from `args.remoteUrl` (the repo's own git
 * remote) via `parseAzureRemote`, so a PR never gets misdirected to whatever
 * org/project `az devops configure --defaults` happens to have set globally.
 * When `remoteUrl` is absent or doesn't parse as an Azure DevOps remote, falls
 * back to the previous behavior (no --org/--project, --repository from
 * `args.repoName`) rather than crashing.
 */
export function buildAzArgs(args: OpenPrArgs): string[] {
  const parsed = args.remoteUrl ? parseAzureRemote(args.remoteUrl) : null;

  const argv = ["repos", "pr", "create"];

  if (parsed) {
    argv.push("--org", parsed.orgUrl, "--project", parsed.project, "--repository", parsed.repo);
  } else {
    argv.push("--repository", args.repoName);
  }

  argv.push(
    "--source-branch",
    args.branch,
    "--target-branch",
    args.targetBranch,
    "--title",
    args.title,
    "--description",
    args.description,
    "--output",
    "json",
  );

  return argv;
}

/**
 * Extract `pullRequestId` and a web URL from `az repos pr create`'s JSON
 * output. Defensive: az may return `url` directly, or only
 * `repository.webUrl` (in which case the PR URL is derived from it plus the
 * id). Returns nulls rather than throwing when fields are absent/malformed.
 */
export function parseAzPrJson(stdout: string): { pullRequestId: number | null; url: string | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { pullRequestId: null, url: null };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { pullRequestId: null, url: null };
  }
  const obj = parsed as Record<string, unknown>;
  const pullRequestId = typeof obj.pullRequestId === "number" ? obj.pullRequestId : null;

  if (typeof obj.url === "string") {
    return { pullRequestId, url: obj.url };
  }

  const repository = obj.repository;
  if (repository && typeof repository === "object") {
    const webUrl = (repository as Record<string, unknown>).webUrl;
    if (typeof webUrl === "string" && pullRequestId !== null) {
      return { pullRequestId, url: `${webUrl}/pullrequest/${pullRequestId}` };
    }
  }

  return { pullRequestId, url: null };
}

/**
 * Open (or dry-run) an Azure DevOps PR. When `dryRun` is true this performs
 * NO process execution — it only echoes back what would have been done.
 */
export function openPr(args: OpenPrArgs): PrResult {
  if (args.dryRun) {
    return {
      repo: args.repoName,
      branch: args.branch,
      targetBranch: args.targetBranch,
      pullRequestId: null,
      url: null,
      dryRun: true,
    };
  }

  const argv = buildAzArgs(args);
  const result = run("az", argv, { cwd: args.repoPath, timeoutMs: 60_000, throwOnError: true });
  const { pullRequestId, url } = parseAzPrJson(result.stdout);
  return {
    repo: args.repoName,
    branch: args.branch,
    targetBranch: args.targetBranch,
    pullRequestId,
    url,
    dryRun: false,
  };
}
