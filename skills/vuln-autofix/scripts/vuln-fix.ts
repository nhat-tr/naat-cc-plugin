#!/usr/bin/env -S node --experimental-strip-types
// vuln-fix — bundled CLI for the vuln-autofix skill.
//
// Composable, deterministic subcommands (Approach A from the design spec). The
// skill (SKILL.md) orchestrates these with judgment and confirmation gates;
// Lane B research is model-driven and lives in the skill, not here.
//
// Usage:
//   vuln-fix discover [--root <workspaceDir>]
//   vuln-fix plan --report <kube-vuln.json> [--root <workspaceDir>] [--map <image-map.json>]
//   vuln-fix fix-worktree --repo <name|bareRepoPath> --branch <name> [--root <dir>]
//   vuln-fix bump --csproj <path> --package <id> --to <version> [--worktree <path>] [--no-build]
//   vuln-fix remove-package --csproj <path> --package <id>
//   vuln-fix reconcile --worktree <path> [--max-rounds <n>]
//   vuln-fix open-pr --repo <bareRepoPath> --repo-name <n> --branch <b> --target <t> \
//                    --title <s> --description <s> [--execute]
//   vuln-fix bump-submodule --consumer <fixWorktreePath> --submodule-path <p> --sha <sha>
//
// open-pr is DRY-RUN unless --execute is passed (Rejection Criterion 2: no
// push/PR without an explicit gate).

import { readFileSync } from "node:fs";
import { discover } from "../../../lib/repo-ops/discover.ts";
import { buildPlan } from "./lib/plan.ts";
import { defaultMapPath, loadRepoImageMap } from "../../../lib/repo-ops/repo-image-map.ts";
import { createFixWorktree } from "../../../lib/repo-ops/worktree.ts";
import { bumpPackageReference, removePackageReference, verifyBuild } from "../../../lib/repo-ops/bump.ts";
import { reconcile } from "../../../lib/repo-ops/reconcile.ts";
import { openPr } from "../../../lib/repo-ops/pr.ts";
import { bumpCommonSubmodule } from "../../../lib/repo-ops/submodule.ts";
import { git } from "../../../lib/repo-ops/sh.ts";
import type { ServiceRepo, Topology } from "../../../lib/repo-ops/types.ts";
import { defaultPolicyPath, loadPolicy } from "./lib/policy.ts";
import type { KubeVulnReport } from "./lib/vuln-types.ts";

type Flags = Record<string, string | boolean>;

function parseFlags(argv: string[]): Flags {
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq !== -1) {
      flags[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        flags[a.slice(2)] = next;
        i++;
      } else {
        flags[a.slice(2)] = true;
      }
    }
  }
  return flags;
}

function req(flags: Flags, name: string): string {
  const v = flags[name];
  if (typeof v !== "string" || v.length === 0) {
    fail(`Missing required flag --${name}`);
  }
  return v as string;
}

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(2);
}

function out(obj: unknown): void {
  console.log(JSON.stringify(obj, null, 2));
}

function readReport(path: string): KubeVulnReport {
  const raw = path === "-" ? readFileSync(0, "utf8") : readFileSync(path, "utf8");
  return JSON.parse(raw) as KubeVulnReport;
}

/** Locate a ServiceRepo by name or by bareRepoPath across the whole topology. */
function findRepo(topo: Topology, key: string): ServiceRepo {
  const all: ServiceRepo[] = [
    ...topo.workspaceRepos,
    ...topo.groups.flatMap((g) => [...(g.commonRepo ? [g.commonRepo] : []), ...g.services]),
  ];
  const hit = all.find((r) => r.name === key || r.bareRepoPath === key);
  if (!hit) fail(`repo '${key}' not found under the workspace root`);
  return hit as ServiceRepo;
}

const USAGE = `vuln-fix — vulnerability auto-fix CLI
Subcommands: discover | plan | fix-worktree | bump | remove-package | reconcile | open-pr | bump-submodule
See the file header for flags. open-pr is dry-run unless --execute.`;

function main(): void {
  const [, , sub, ...rest] = process.argv;
  const flags = parseFlags(rest);
  const root =
    (typeof flags.root === "string" && flags.root) || process.cwd();

  switch (sub) {
    case "discover": {
      out(discover(root));
      return;
    }
    case "plan": {
      const report = readReport(req(flags, "report"));
      const topo = discover(root);
      const mapPath = typeof flags.map === "string" ? flags.map : defaultMapPath(root);
      const imageMap = loadRepoImageMap(mapPath);
      const policyPath = typeof flags.policy === "string" ? flags.policy : defaultPolicyPath(root);
      const policy = loadPolicy(policyPath);
      out(buildPlan(report, topo, imageMap ?? undefined, policy ?? undefined));
      return;
    }
    case "fix-worktree": {
      const topo = discover(root);
      const repo = findRepo(topo, req(flags, "repo"));
      out(createFixWorktree(repo, req(flags, "branch")));
      return;
    }
    case "bump": {
      const csproj = req(flags, "csproj");
      const pkg = req(flags, "package");
      const to = req(flags, "to");
      const { from } = bumpPackageReference(csproj, pkg, to);
      if (flags["no-build"] || typeof flags.worktree !== "string") {
        out({ csprojPath: csproj, package: pkg, from, to, buildOk: null });
        return;
      }
      const build = verifyBuild(flags.worktree as string);
      out({ csprojPath: csproj, package: pkg, from, to, ...build });
      return;
    }
    case "remove-package": {
      const csproj = req(flags, "csproj");
      const pkg = req(flags, "package");
      const { removedVersion } = removePackageReference(csproj, pkg);
      out({ csprojPath: csproj, package: pkg, removedVersion });
      return;
    }
    case "reconcile": {
      const worktree = req(flags, "worktree");
      const maxRounds =
        typeof flags["max-rounds"] === "string" ? Number(flags["max-rounds"]) : undefined;
      out(reconcile(worktree, maxRounds ? { maxRounds } : undefined));
      return;
    }
    case "open-pr": {
      const repoPath = req(flags, "repo");
      // Derive the ADO remote so the PR targets the right org/project/repo
      // (never rely on global `az devops configure --defaults`).
      const remote =
        typeof flags["remote-url"] === "string"
          ? (flags["remote-url"] as string)
          : git(repoPath, ["remote", "get-url", "origin"]).stdout.trim() || undefined;
      out(
        openPr({
          repoPath,
          repoName: req(flags, "repo-name"),
          branch: req(flags, "branch"),
          targetBranch: req(flags, "target"),
          title: req(flags, "title"),
          description: req(flags, "description"),
          remoteUrl: remote,
          dryRun: flags.execute !== true,
        }),
      );
      return;
    }
    case "bump-submodule": {
      out(
        bumpCommonSubmodule(
          req(flags, "consumer"),
          req(flags, "submodule-path"),
          req(flags, "sha"),
        ),
      );
      return;
    }
    default:
      console.log(USAGE);
      process.exit(sub ? 2 : 0);
  }
}

main();
