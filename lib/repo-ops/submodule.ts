// submodule — the ordering-(a) follow-up: bump a consumer service's Common
// submodule pointer after that Common fix has merged.
//
// listCommonConsumers enumerates which services in a domain group need the
// follow-up; bumpCommonSubmodule performs it in a single consumer worktree,
// staging only the gitlink. Building/PR-ing is the CLI's job, not this
// module's (buildOk is always returned false here).

import { join } from "node:path";
import { git } from "./sh.ts";
import type { ServiceRepo, SubmoduleBumpResult, Topology } from "./types.ts";

// The real repos wire Common as a submodule over a RELATIVE LOCAL PATH url
// (e.g. `../Hoffmann.Calibration.Common`). Since Git 2.38.1 (CVE-2022-39253)
// the `file` transport is blocked by default for submodule clone/fetch, so any
// transport-touching git call below must opt in explicitly. This only relaxes
// the restriction for the user's own local repos, per-invocation.
const ALLOW_FILE_PROTOCOL = ["-c", "protocol.file.allow=always"];

/** Services in `group` that consume the group's Common repo via a submodule. */
export function listCommonConsumers(topology: Topology, group: string): ServiceRepo[] {
  const domainGroup = topology.groups.find((g) => g.name === group);
  if (!domainGroup) return [];
  return domainGroup.services.filter((service) => service.usesCommonSubmodule === true);
}

/**
 * Moves the `submodulePath` submodule inside `consumerWorktreePath` to
 * `targetSha` and stages the resulting gitlink change. Throws if anything
 * beyond the gitlink (and, at most, `.gitmodules`) ends up staged — that
 * would mean the bump reached beyond the submodule pointer, which this
 * primitive must never do silently.
 */
export function bumpCommonSubmodule(
  consumerWorktreePath: string,
  submodulePath: string,
  targetSha: string,
): SubmoduleBumpResult {
  const submoduleDir = join(consumerWorktreePath, submodulePath);

  // 1. Ensure the submodule is initialized/checked out.
  git(
    consumerWorktreePath,
    [...ALLOW_FILE_PROTOCOL, "submodule", "update", "--init", submodulePath],
    { throwOnError: true },
  );

  // Capture the previously pinned commit before moving it.
  const fromSha = git(submoduleDir, ["rev-parse", "HEAD"], {
    throwOnError: true,
  }).stdout.trim();

  // 2. Move the submodule to the target commit.
  git(submoduleDir, [...ALLOW_FILE_PROTOCOL, "fetch", "origin"], { throwOnError: true });
  git(submoduleDir, ["checkout", targetSha], { throwOnError: true });

  // 3. Stage the new gitlink in the consumer worktree.
  git(consumerWorktreePath, ["add", submodulePath], { throwOnError: true });

  const toSha = targetSha;

  // 5. Verify the staged diff touches only the gitlink (and, at most,
  // .gitmodules if the tracked branch changed).
  const staged = git(consumerWorktreePath, ["diff", "--cached", "--name-only"], {
    throwOnError: true,
  })
    .stdout.split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const allowed = new Set([submodulePath, ".gitmodules"]);
  const unexpected = staged.filter((path) => !allowed.has(path));
  if (unexpected.length > 0 || !staged.includes(submodulePath)) {
    throw new Error(
      `bumpCommonSubmodule: staged diff in '${consumerWorktreePath}' touches more than the ` +
        `'${submodulePath}' gitlink (staged: ${JSON.stringify(staged)}). Refusing to bump.`,
    );
  }

  return {
    consumerRepo: consumerWorktreePath,
    submodulePath,
    fromSha,
    toSha,
    buildOk: false,
  };
}
