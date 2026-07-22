#!/usr/bin/env -S node --experimental-strip-types
// az-pr — bundled CLI for the az-pr skill.
//
// Deterministic per-repo subcommands over the shared ADO PR module
// (../../../infra/azure-devops/pr.ts). The skill (SKILL.md) supplies the
// judgment: which repos, the ticket, the change bullets, and the single
// approval gate. This CLI just does what it's told, once, per repo.
//
// Usage:
//   az-pr create        --repo <path> [--branch <b>] [--target <t>] --title <s>
//                       --ticket <KEY> (--change <text> [--change ...] | --body <s> | --body-file <path|->)
//                       [--remote-url <u>] [--draft] [--execute]
//   az-pr update        --id <n> [--repo <path> | --org <url>] [--title <s>]
//                       [--ticket <KEY> (--change <text> ... | --body <s> | --body-file <path|->)]
//                       [--target <t>] [--draft | --ready] [--execute]
//   az-pr complete      --id <n> [--repo <path> | --org <url>]
//                       [--no-squash] [--keep-source] [--merge-message <s>] [--execute]
//   az-pr ensure-ticket --id <n> [--repo <path> | --org <url>] --ticket <KEY> [--execute]
//   az-pr status        --id <n> [--repo <path> | --org <url>]   # reports mergeStatus
//   az-pr list          --repo <path> [--branch <b>] [--status active|completed|abandoned|all]
//
// The description always leads with `Ticket <KEY>: <url>`; pass the body as
// terse --change bullets OR a hand-written --body/--body-file (prose is fine) —
// either way the ticket line is guaranteed. `ensure-ticket` backfills that line
// onto an existing PR. Never call `az repos pr create|update` directly: the
// ticket guarantee only holds on this CLI's path.
//
// Every mutating command is DRY-RUN unless --execute is passed. `list` is
// read-only. Output is JSON on stdout so the skill can collect the PR urls.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import {
  completePr,
  createPr,
  ensureTicketLine,
  formatDescription,
  parseAzPrJson,
  parseAzureRemote,
  updatePr,
} from "../../../infra/azure-devops/pr.ts";

// ---------------------------------------------------------------------------
// arg parsing (multi-map: --change repeats, everything else takes the last)
// ---------------------------------------------------------------------------

interface Args {
  get(name: string): string | undefined;
  all(name: string): string[];
  has(name: string): boolean;
  bool(name: string): boolean;
}

function parseArgs(argv: string[]): Args {
  const map = new Map<string, string[]>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq !== -1) {
      push(map, a.slice(2, eq), a.slice(eq + 1));
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      push(map, key, next);
      i++;
    } else {
      flags.add(key);
    }
  }
  return {
    get: (n) => map.get(n)?.at(-1),
    all: (n) => map.get(n) ?? [],
    has: (n) => map.has(n) || flags.has(n),
    bool: (n) => flags.has(n) || map.get(n)?.at(-1) === "true",
  };
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const arr = map.get(key);
  if (arr) arr.push(value);
  else map.set(key, [value]);
}

function req(args: Args, name: string): string {
  const v = args.get(name);
  if (v === undefined || v.length === 0) fail(`missing required flag --${name}`);
  return v;
}

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(2);
}

function out(obj: unknown): void {
  console.log(JSON.stringify(obj, null, 2));
}

// ---------------------------------------------------------------------------
// git helpers (best-effort; a missing repo/remote degrades, never crashes)
// ---------------------------------------------------------------------------

function git(repoPath: string, gitArgs: string[]): string {
  const res = spawnSync("git", ["-C", repoPath, ...gitArgs], { encoding: "utf8" });
  return (res.stdout ?? "").trim();
}

function currentBranch(repoPath: string): string {
  return git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

/** Resolve the repo's default (target) branch from origin/HEAD; fall back to master. */
function defaultBranch(repoPath: string): string {
  const head = git(repoPath, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (head.startsWith("origin/")) return head.slice("origin/".length);
  return "master";
}

function remoteUrlOf(repoPath: string): string | undefined {
  return git(repoPath, ["remote", "get-url", "origin"]) || undefined;
}

/** Derive the ADO org URL for id-addressed update/complete: --org wins, else the repo remote. */
function resolveOrgUrl(args: Args): string | undefined {
  const explicit = args.get("org");
  if (explicit) return explicit;
  const repoPath = args.get("repo");
  if (!repoPath) return undefined;
  const url = remoteUrlOf(repoPath);
  return url ? parseAzureRemote(url)?.orgUrl : undefined;
}

/** A hand-written body from --body (inline) or --body-file (`-` = stdin). */
function readBody(args: Args): string | undefined {
  const inline = args.get("body");
  if (inline !== undefined) return inline;
  const file = args.get("body-file");
  if (file !== undefined) return readFileSync(file === "-" ? 0 : file, "utf8");
  return undefined;
}

/**
 * Description from --ticket plus either repeated --change (terse bullets) or
 * --body/--body-file (a richer hand-written body). Returns undefined only when
 * none is supplied (update may legitimately touch just the title). Either way
 * the ticket line is guaranteed by formatDescription, and a missing/bad ticket
 * throws — the CLI surfaces it so the skill asks the human rather than shipping
 * a linkless PR. This body path is what lets an agent stay inside the CLI for
 * multi-paragraph descriptions instead of bypassing it with raw `az`.
 */
function descriptionFrom(args: Args): string | undefined {
  const ticket = args.get("ticket");
  const changes = args.all("change");
  const body = readBody(args);
  if (!ticket && changes.length === 0 && body === undefined) return undefined;
  return formatDescription({ ticket: ticket ?? "", changes, body });
}

// ---------------------------------------------------------------------------
// PR read helpers (shared by status / ensure-ticket / list)
// ---------------------------------------------------------------------------

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/** `az repos pr show --id` → the raw PR object. Fails cleanly (exit 2) on error. */
function showPr(id: number, orgUrl: string | undefined, repoPath: string | undefined): Record<string, unknown> {
  const argv = ["repos", "pr", "show", "--id", String(id)];
  if (orgUrl) argv.push("--org", orgUrl);
  argv.push("--output", "json");
  const res = spawnSync("az", argv, { cwd: repoPath, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (res.status !== 0) fail(`az repos pr show failed: ${(res.stderr ?? "").trim()}`);
  try {
    return JSON.parse(res.stdout ?? "{}") as Record<string, unknown>;
  } catch {
    fail("could not parse `az repos pr show` output");
  }
}

/**
 * Project a PR object to the fields callers care about. `mergeStatus` is the
 * key one: `conflicts` means the PR can't merge and completing it is pointless
 * until the branch is reconciled — the skill checks this before completing.
 */
function prView(pr: Record<string, unknown>, fallbackId: number): Record<string, unknown> {
  const { pullRequestId, url } = parseAzPrJson(JSON.stringify(pr));
  return {
    id: pullRequestId ?? fallbackId,
    title: str(pr.title),
    status: str(pr.status),
    isDraft: typeof pr.isDraft === "boolean" ? pr.isDraft : null,
    mergeStatus: str(pr.mergeStatus),
    sourceBranch: str(pr.sourceRefName),
    targetBranch: str(pr.targetRefName),
    url,
  };
}

// ---------------------------------------------------------------------------
// subcommands
// ---------------------------------------------------------------------------

function cmdCreate(args: Args): void {
  const repoPath = req(args, "repo");
  const remoteUrl = args.get("remote-url") ?? remoteUrlOf(repoPath);
  const repoName = (remoteUrl && parseAzureRemote(remoteUrl)?.repo) || basename(repoPath);
  const branch = args.get("branch") ?? currentBranch(repoPath);
  const targetBranch = args.get("target") ?? defaultBranch(repoPath);
  const description = descriptionFrom(args);
  if (description === undefined) fail("create needs --ticket and at least one --change");

  out(
    createPr({
      repoPath,
      repoName,
      branch,
      targetBranch,
      title: req(args, "title"),
      description,
      remoteUrl,
      draft: args.bool("draft"),
      dryRun: !args.bool("execute"),
    }),
  );
}

function cmdUpdate(args: Args): void {
  const id = Number(req(args, "id"));
  if (!Number.isInteger(id)) fail("--id must be an integer");
  const description = descriptionFrom(args);
  const title = args.get("title");
  const targetBranch = args.get("target");
  const draft = args.has("draft") ? true : args.has("ready") ? false : undefined;
  if (description === undefined && title === undefined && targetBranch === undefined && draft === undefined) {
    fail("update needs at least one of --title, --ticket/--change, --target, --draft/--ready");
  }

  out(
    updatePr(
      {
        id,
        orgUrl: resolveOrgUrl(args),
        title,
        description,
        targetBranch,
        draft,
        dryRun: !args.bool("execute"),
      },
      args.get("repo"),
    ),
  );
}

function cmdComplete(args: Args): void {
  const id = Number(req(args, "id"));
  if (!Number.isInteger(id)) fail("--id must be an integer");

  out(
    completePr(
      {
        id,
        orgUrl: resolveOrgUrl(args),
        squash: !args.bool("no-squash"),
        deleteSourceBranch: !args.bool("keep-source"),
        mergeMessage: args.get("merge-message"),
        dryRun: !args.bool("execute"),
      },
      args.get("repo"),
    ),
  );
}

function cmdList(args: Args): void {
  const repoPath = req(args, "repo");
  const status = args.get("status") ?? "active";
  const branch = args.get("branch") ?? currentBranch(repoPath);
  const remoteUrl = remoteUrlOf(repoPath);
  const parsed = remoteUrl ? parseAzureRemote(remoteUrl) : null;

  const argv = ["repos", "pr", "list"];
  if (parsed) argv.push("--org", parsed.orgUrl, "--project", parsed.project, "--repository", parsed.repo);
  if (branch) argv.push("--source-branch", `refs/heads/${branch}`);
  if (status !== "all") argv.push("--status", status);
  argv.push("--output", "json");

  const res = spawnSync("az", argv, { cwd: repoPath, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (res.status !== 0) fail(`az repos pr list failed: ${(res.stderr ?? "").trim()}`);

  let list: unknown;
  try {
    list = JSON.parse(res.stdout ?? "[]");
  } catch {
    fail("could not parse `az repos pr list` output");
  }
  const rows = Array.isArray(list) ? list : [];
  out(rows.map((pr) => prView(pr as Record<string, unknown>, -1)));
}

/**
 * Report a single PR's state — chiefly its `mergeStatus`. Read-only, no gate.
 * The skill runs this before completing so it never auto-completes a PR that is
 * in `conflicts` (which would just stall).
 */
function cmdStatus(args: Args): void {
  const id = Number(req(args, "id"));
  if (!Number.isInteger(id)) fail("--id must be an integer");
  out(prView(showPr(id, resolveOrgUrl(args), args.get("repo")), id));
}

/**
 * Backfill the ticket line onto an existing PR: read its current description,
 * prepend `Ticket <KEY>: <url>` if it's missing (idempotent), and update. This
 * is the compliant way to add a forgotten ticket link — no raw `az` needed, so
 * the guarantee can't be bypassed. Reads the PR even in dry-run (a read is
 * safe); only the write is gated by --execute.
 */
function cmdEnsureTicket(args: Args): void {
  const id = Number(req(args, "id"));
  if (!Number.isInteger(id)) fail("--id must be an integer");
  const ticket = req(args, "ticket");
  const orgUrl = resolveOrgUrl(args);
  const repoPath = args.get("repo");

  const pr = showPr(id, orgUrl, repoPath);
  const currentBody = str(pr.description) ?? "";
  const newBody = ensureTicketLine(ticket, currentBody); // throws on a bad ticket

  if (newBody.trim() === currentBody.trim()) {
    out({ action: "ensure-ticket", id, changed: false, note: "ticket line already present" });
    return;
  }
  const result = updatePr({ id, orgUrl, description: newBody, dryRun: !args.bool("execute") }, repoPath);
  out({ ...result, action: "ensure-ticket", changed: true });
}

const USAGE = `az-pr — Azure DevOps PR lifecycle CLI
Subcommands: create | update | complete | ensure-ticket | status | list
Mutating commands are dry-run unless --execute. See the file header for flags.`;

function main(): void {
  const [, , sub, ...rest] = process.argv;
  const args = parseArgs(rest);
  try {
    switch (sub) {
      case "create":
        return cmdCreate(args);
      case "update":
        return cmdUpdate(args);
      case "complete":
        return cmdComplete(args);
      case "ensure-ticket":
        return cmdEnsureTicket(args);
      case "status":
        return cmdStatus(args);
      case "list":
        return cmdList(args);
      default:
        console.log(USAGE);
        process.exit(sub ? 2 : 0);
    }
  } catch (err) {
    // Surface validation/exec failures (e.g. a missing ticket) as a clean
    // one-line error + exit 2, never an uncaught stack trace — the caller
    // parses this to decide whether to ask the human.
    fail(err instanceof Error ? err.message : String(err));
  }
}

main();
