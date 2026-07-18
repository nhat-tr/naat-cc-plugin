// reconcile — auto-resolve NuGet "package downgrade" restore failures.
//
// Runs `dotnet restore` in a worktree; if it fails with a NU1605-style
// "Detected package downgrade: X from A to B" error, that means the graph
// wants X at the higher version A but some direct reference pins it at the
// lower B, so we raise the offending PackageReference to A and retry. Any
// other failure (or a downgrade we can't locate a csproj for) is reported
// as-is — this loop only ever fixes downgrades, never masks other errors.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { run, tail } from "./sh.ts";
import { bumpPackageReference, nonInteractiveEnv } from "./bump.ts";

const SKIP_DIRS = new Set([".git", "bin", "obj", "node_modules"]);

function findCsprojFiles(dir: string): string[] {
  const results: string[] = [];
  const walk = (d: string): void => {
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(join(d, e.name));
      } else if (e.isFile() && e.name.endsWith(".csproj")) {
        results.push(join(d, e.name));
      }
    }
  };
  walk(dir);
  return results;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Find the first csproj under `worktreePath` with a direct PackageReference
 * Include matching `pkg` (case-insensitive), in either element form. */
function findCsprojDeclaring(worktreePath: string, pkg: string): string | null {
  const includeRe = new RegExp(
    `<PackageReference\\b[^>]*\\bInclude\\s*=\\s*["']${escapeRegExp(pkg)}["']`,
    "i",
  );
  for (const csproj of findCsprojFiles(worktreePath)) {
    let content: string;
    try {
      content = readFileSync(csproj, "utf8");
    } catch {
      continue;
    }
    if (includeRe.test(content)) return csproj;
  }
  return null;
}

interface Downgrade {
  package: string;
  requiredVersion: string; // the higher version NuGet wants (the "from" version)
}

const VERSION = String.raw`\d+(?:\.\d+){1,3}(?:-[0-9A-Za-z.]+)?`;
const DOWNGRADE_RE = new RegExp(
  `Detected package downgrade:\\s*(\\S+)\\s+from\\s+(${VERSION})\\s+to\\s+(${VERSION})`,
  "i",
);

/**
 * Parse a NuGet "Detected package downgrade: X from A to B" message (NU1605)
 * out of restore output. NuGet's own wording is "from <higher, wanted> to
 * <lower, resolved>", so the required fix version is the "from" value.
 */
function parseDowngrade(output: string): Downgrade | null {
  const m = DOWNGRADE_RE.exec(output);
  if (!m) return null;
  return { package: m[1], requiredVersion: m[2] };
}

function defaultRestoreRunner(worktreePath: string): { ok: boolean; output: string } {
  const res = run("dotnet", ["restore", "--nologo"], {
    cwd: worktreePath,
    timeoutMs: 600_000,
    env: nonInteractiveEnv(),
  });
  return { ok: res.ok, output: res.stdout + res.stderr };
}

export interface ReconcileResult {
  ok: boolean;
  rounds: number;
  actions: string[];
  outputTail: string;
}

export interface ReconcileOptions {
  maxRounds?: number;
  runner?: (wt: string) => { ok: boolean; output: string };
}

/**
 * Repeatedly run `dotnet restore` in `worktreePath`, auto-bumping any
 * PackageReference NuGet reports as downgraded, up to `maxRounds` (default
 * 6) attempts. Returns as soon as restore succeeds; returns ok:false with
 * the failing output's tail as soon as a failure isn't an actionable
 * downgrade (or no declaring csproj can be found for one).
 */
export function reconcile(worktreePath: string, opts: ReconcileOptions = {}): ReconcileResult {
  const maxRounds = opts.maxRounds ?? 6;
  const runner = opts.runner ?? defaultRestoreRunner;
  const actions: string[] = [];
  let lastOutput = "";

  for (let round = 1; round <= maxRounds; round++) {
    const { ok, output } = runner(worktreePath);
    lastOutput = output;
    if (ok) {
      return { ok: true, rounds: round, actions, outputTail: tail(output, 40) };
    }

    const downgrade = parseDowngrade(output);
    if (!downgrade) {
      return { ok: false, rounds: round, actions, outputTail: tail(output, 40) };
    }

    const csprojPath = findCsprojDeclaring(worktreePath, downgrade.package);
    if (!csprojPath) {
      return { ok: false, rounds: round, actions, outputTail: tail(output, 40) };
    }

    const { from, to } = bumpPackageReference(csprojPath, downgrade.package, downgrade.requiredVersion);
    actions.push(`Bumped ${downgrade.package} ${from} -> ${to} in ${csprojPath} (resolve NuGet downgrade)`);
  }

  // Ran out of rounds — every attempt kept hitting an actionable downgrade;
  // report the last attempt's tail without spending an extra restore call.
  return { ok: false, rounds: maxRounds, actions, outputTail: tail(lastOutput, 40) };
}
