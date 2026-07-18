// policy — the "never auto-upgrade" gate for the vuln-autofix skill.
//
// Some packages must never be mechanically bumped (e.g. AutoMapper >= 15 is
// commercially licensed). A workspace-local policy file lists them by NuGet id;
// buildPlan routes any listed finding to Lane B (research/propose only), never
// an automatic Lane A bump. The policy is optional: an absent file yields null,
// which holds nothing.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Workspace policy for the vuln-autofix skill. */
export interface VulnPolicy {
  /** NuGet package ids that must never be auto-bumped (matched case-insensitively). */
  neverUpgrade: string[];
}

/** Conventional filename for the workspace-local policy file. */
export const DEFAULT_POLICY_BASENAME = ".vuln-autofix-policy.json";

/** Absolute path to the conventional policy file under a workspace root. */
export function defaultPolicyPath(workspaceRoot: string): string {
  return join(workspaceRoot, DEFAULT_POLICY_BASENAME);
}

/**
 * Load the policy from `path`. Returns null when the file does not exist (the
 * policy is optional). Throws a clear error when the file exists but is not
 * valid JSON, or when `neverUpgrade` is not an array of strings.
 */
export function loadPolicy(path: string): VulnPolicy | null {
  if (!existsSync(path)) return null;

  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`vuln-autofix policy at ${path} is not valid JSON`, { cause });
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(
      `vuln-autofix policy at ${path} must be a JSON object with a "neverUpgrade" array`,
    );
  }

  const neverUpgrade = (parsed as Record<string, unknown>).neverUpgrade;
  if (!Array.isArray(neverUpgrade) || !neverUpgrade.every((x) => typeof x === "string")) {
    throw new Error(
      `vuln-autofix policy at ${path}: "neverUpgrade" must be an array of package-name strings`,
    );
  }

  return { neverUpgrade };
}

/** Case-insensitive membership test: is `pkg` on the policy's neverUpgrade list? */
export function isHeld(policy: VulnPolicy | null | undefined, pkg: string): boolean {
  if (!policy) return false;
  const lower = pkg.toLowerCase();
  return policy.neverUpgrade.some((held) => held.toLowerCase() === lower);
}
