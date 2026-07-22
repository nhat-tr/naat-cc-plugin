// pr — Azure DevOps pull-request lifecycle via the `az repos pr` CLI.
//
// Single home for the ADO PR mechanics shared across skills (vuln-autofix's
// batch fixer and the az-pr lifecycle skill). Three operations:
//   - create   → `az repos pr create`
//   - update   → `az repos pr update` (title / description / target / draft)
//   - complete → `az repos pr update --auto-complete` (squash + delete source)
//
// Self-contained on purpose: only `node:child_process`, so any tool can import
// it without pulling in the repo-ops workspace model. Every mutating function
// performs ZERO process execution when `dryRun` is true — the confirmation gate
// lives in the consuming skill; this module enforces the mechanical half.

import { spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Process helper (argv array, never a shell — refs/paths can't be interpreted)
// ---------------------------------------------------------------------------

interface RunResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[], cwd?: string): RunResult {
  const res = spawnSync(cmd, args, {
    cwd,
    timeout: 60_000,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const result: RunResult = {
    ok: res.status === 0,
    code: res.status ?? -1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? (res.error ? String(res.error.message) : ""),
  };
  if (!result.ok) {
    throw new Error(`Command failed (${result.code}): ${cmd} ${args.join(" ")}\n${result.stderr}`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Jira ticket → PR description
// ---------------------------------------------------------------------------

/** Base URL of the team's Jira. Ticket keys hang off `/browse/<KEY>`. */
export const JIRA_BASE_URL = "https://hoffmann-group-digital.atlassian.net";

/** A Jira ticket key: an uppercase project prefix + number, e.g. `SCD-28`. */
const TICKET_KEY = /^[A-Z][A-Z0-9]*-\d+$/;

/**
 * Turn a ticket key like `SCD-28` into its browse URL. Throws on anything that
 * isn't a well-formed key so a typo can never ship a dead link in a PR. The
 * key is the caller's responsibility to source (branch name, commit, or the
 * human) — this function never invents one.
 */
export function ticketUrl(ticket: string): string {
  const key = ticket.trim().toUpperCase();
  if (!TICKET_KEY.test(key)) {
    throw new Error(
      `'${ticket}' is not a Jira ticket key (expected e.g. SCD-28). ` +
        `Ask the human for the ticket rather than guessing.`,
    );
  }
  return `${JIRA_BASE_URL}/browse/${key}`;
}

/** The canonical first line linking a PR to its ticket. */
function ticketLine(ticket: string): string {
  const key = ticket.trim().toUpperCase();
  return `Ticket ${key}: ${ticketUrl(ticket)}`; // ticketUrl throws on a bad key
}

/**
 * Guarantee a PR body leads with the ticket line. Idempotent: a body that
 * already opens with a `Ticket <KEY>:` line for this ticket is returned
 * untouched; otherwise the canonical line + a blank line are prepended.
 *
 * This is the single choke point every description flows through, so no
 * authoring path — flat bullets OR a hand-written multi-paragraph body — can
 * ship a PR without the ticket link. (The first live run bypassed the CLI and
 * wrote raw descriptions; centralising here + accepting a `--body` removes the
 * reason to bypass.) Throws via `ticketUrl` when the ticket is missing or
 * malformed, so the caller must stop and ask the human, never open a linkless PR.
 */
export function ensureTicketLine(ticket: string, body: string): string {
  const line = ticketLine(ticket);
  const key = ticket.trim().toUpperCase();
  const trimmed = body.trim();
  const firstLine = trimmed.split("\n", 1)[0]?.trim() ?? "";
  const alreadyLinked = new RegExp(`^ticket\\s+${key}\\s*:`, "i").test(firstLine);
  if (alreadyLinked) return trimmed;
  return trimmed.length === 0 ? line : `${line}\n\n${trimmed}`;
}

export interface DescriptionParts {
  /** Jira ticket key, e.g. `SCD-28`. Required — the description must link it. */
  ticket: string;
  /** One concise bullet per change. The terse default for simple PRs. */
  changes?: string[];
  /** A hand-written body (prose, sub-bullets, cross-refs) for richer PRs. When
   * set it wins over `changes`; the ticket line is still guaranteed. */
  body?: string;
}

/**
 * Render a PR description with a guaranteed ticket line. Two authoring modes:
 *   - `body`    — a freeform body of any shape; the ticket line is prepended.
 *   - `changes` — the terse default: ticket line + one `- ` bullet per change.
 * `body` wins when both are given. Throws when the ticket is missing/malformed,
 * or (bullet mode) when there are no real changes — a PR never opens without a
 * ticket link and a changelog.
 */
export function formatDescription({ ticket, changes, body }: DescriptionParts): string {
  if (body !== undefined && body.trim().length > 0) {
    return ensureTicketLine(ticket, body);
  }
  const bullets = (changes ?? [])
    .map((c) => c.trim())
    .filter((c) => c.length > 0)
    .map((c) => `- ${c}`);
  if (bullets.length === 0) {
    throw new Error("A PR description needs at least one change bullet, or a --body.");
  }
  return ensureTicketLine(ticket, bullets.join("\n"));
}

// ---------------------------------------------------------------------------
// Azure DevOps remote URL → org / project / repo addressing
// ---------------------------------------------------------------------------

/**
 * Parse an Azure DevOps git remote URL into the addressing the Azure CLI needs:
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

// ---------------------------------------------------------------------------
// az argv builders
// ---------------------------------------------------------------------------

export interface CreatePrArgs {
  repoPath: string;
  repoName: string;
  branch: string;
  targetBranch: string;
  title: string;
  description: string;
  dryRun: boolean;
  /** The repo's own git remote. Used to derive --org/--project/--repository so
   * the PR lands in the repo's Azure DevOps org/project rather than whatever
   * `az devops configure --defaults` happens to point at. */
  remoteUrl?: string;
  /** Open as a draft PR (default false). */
  draft?: boolean;
}

/**
 * Build the argv (without the leading `az`) for `az repos pr create`. The
 * title/description survive verbatim. Org/project/repository addressing is
 * derived explicitly from `args.remoteUrl` via `parseAzureRemote`, so a PR
 * never gets misdirected to global `az devops configure --defaults`. When
 * `remoteUrl` is absent or doesn't parse, falls back to `--repository
 * <repoName>` with no --org/--project rather than crashing.
 */
export function buildCreateArgs(args: CreatePrArgs): string[] {
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

  if (args.draft) argv.push("--draft", "true");

  return argv;
}

export interface UpdatePrArgs {
  id: number;
  dryRun: boolean;
  /** Org URL for `--org`; derive from the repo remote when addressing by id. */
  orgUrl?: string;
  title?: string;
  description?: string;
  targetBranch?: string;
  draft?: boolean;
}

/**
 * Build the argv for `az repos pr update` editing PR fields. A PR id is
 * globally unique within an org, so this addresses by `--id` (+ optional
 * `--org`) — no project/repository needed. Only the fields the caller set are
 * emitted, so an update touches nothing it wasn't asked to.
 */
export function buildUpdateArgs(args: UpdatePrArgs): string[] {
  const argv = ["repos", "pr", "update", "--id", String(args.id)];
  if (args.orgUrl) argv.push("--org", args.orgUrl);
  if (args.title !== undefined) argv.push("--title", args.title);
  if (args.description !== undefined) argv.push("--description", args.description);
  if (args.targetBranch !== undefined) argv.push("--target-branch", args.targetBranch);
  if (args.draft !== undefined) argv.push("--draft", String(args.draft));
  argv.push("--output", "json");
  return argv;
}

export interface CompletePrArgs {
  id: number;
  dryRun: boolean;
  orgUrl?: string;
  /** Mark for auto-complete (merge once policies/approvals pass). Default true. */
  autoComplete?: boolean;
  /** Squash-merge. Default true. */
  squash?: boolean;
  /** Delete the source branch on completion. Default true. */
  deleteSourceBranch?: boolean;
  /** Optional merge commit message. */
  mergeMessage?: string;
}

/**
 * Build the argv for completing a PR. The default is auto-complete (not a
 * forced merge): the PR is flagged to merge itself once required approvals and
 * branch policies pass, so this never bulldozes a protected branch. Squash and
 * delete-source-branch default on, matching the team's feature-branch flow.
 */
export function buildCompleteArgs(args: CompletePrArgs): string[] {
  const autoComplete = args.autoComplete ?? true;
  const squash = args.squash ?? true;
  const deleteSourceBranch = args.deleteSourceBranch ?? true;

  const argv = ["repos", "pr", "update", "--id", String(args.id)];
  if (args.orgUrl) argv.push("--org", args.orgUrl);
  argv.push("--auto-complete", String(autoComplete));
  argv.push("--squash", String(squash));
  argv.push("--delete-source-branch", String(deleteSourceBranch));
  if (args.mergeMessage !== undefined) argv.push("--merge-commit-message", args.mergeMessage);
  argv.push("--output", "json");
  return argv;
}

// ---------------------------------------------------------------------------
// az JSON output → { id, url }
// ---------------------------------------------------------------------------

/**
 * Extract `pullRequestId` and a web URL from `az repos pr create|update` JSON.
 * Defensive: az may return `url` directly, or only `repository.webUrl` (in
 * which case the PR URL is derived from it plus the id). Returns nulls rather
 * than throwing when fields are absent/malformed.
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

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export interface CreatePrResult {
  repo: string;
  branch: string;
  targetBranch: string;
  pullRequestId: number | null;
  url: string | null;
  dryRun: boolean;
}

export interface MutatePrResult {
  action: "update" | "complete";
  id: number;
  url: string | null;
  dryRun: boolean;
}

/**
 * Create (or dry-run) an Azure DevOps PR. When `dryRun` is true this performs
 * NO process execution — it only echoes back what would have been done.
 */
export function createPr(args: CreatePrArgs): CreatePrResult {
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

  const result = run("az", buildCreateArgs(args), args.repoPath);
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

/** Update (or dry-run) a PR's editable fields. Dry-run performs no execution. */
export function updatePr(args: UpdatePrArgs, cwd?: string): MutatePrResult {
  if (args.dryRun) {
    return { action: "update", id: args.id, url: null, dryRun: true };
  }
  const result = run("az", buildUpdateArgs(args), cwd);
  const { url } = parseAzPrJson(result.stdout);
  return { action: "update", id: args.id, url, dryRun: false };
}

/** Complete (or dry-run) a PR via auto-complete. Dry-run performs no execution. */
export function completePr(args: CompletePrArgs, cwd?: string): MutatePrResult {
  if (args.dryRun) {
    return { action: "complete", id: args.id, url: null, dryRun: true };
  }
  const result = run("az", buildCompleteArgs(args), cwd);
  const { url } = parseAzPrJson(result.stdout);
  return { action: "complete", id: args.id, url, dryRun: false };
}
