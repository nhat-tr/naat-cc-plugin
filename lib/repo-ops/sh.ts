// sh — shared, dependency-free process + git helpers.
//
// Uses spawnSync with argument arrays (no shell) so repo paths and refs can never
// be shell-interpreted. Every implementation module should route git/az/dotnet
// invocations through here for consistent error handling and testability.

import { spawnSync } from "node:child_process";
import type { Worktree } from "./types.ts";

export interface RunResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  /** Milliseconds. dotnet build defaults higher; git/az default 60s. */
  timeoutMs?: number;
  /** When true, a non-zero exit throws instead of returning ok:false. */
  throwOnError?: boolean;
  env?: NodeJS.ProcessEnv;
}

/** Run a command as an argv array (no shell). Never rejects unless throwOnError. */
export function run(cmd: string, args: string[], opts: RunOptions = {}): RunResult {
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd,
    timeout: opts.timeoutMs ?? 60_000,
    encoding: "utf8",
    env: opts.env ?? process.env,
    maxBuffer: 32 * 1024 * 1024,
  });
  const result: RunResult = {
    ok: res.status === 0,
    code: res.status ?? -1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? (res.error ? String(res.error.message) : ""),
  };
  if (opts.throwOnError && !result.ok) {
    throw new Error(
      `Command failed (${result.code}): ${cmd} ${args.join(" ")}\n${result.stderr}`,
    );
  }
  return result;
}

/** Convenience wrapper: `git -C <repoPath> <args...>`. */
export function git(repoPath: string, args: string[], opts: RunOptions = {}): RunResult {
  return run("git", ["-C", repoPath, ...args], opts);
}

/** Last N lines of a (possibly large) output blob — for build diagnostics. */
export function tail(text: string, lines = 40): string {
  const arr = text.split("\n");
  return arr.slice(Math.max(0, arr.length - lines)).join("\n");
}

/**
 * Hard guard for Rejection Criterion 1: fix work must never touch a protected
 * worktree (base/master, Work*, Review). Throws if the target is protected.
 */
export function assertNotProtected(wt: Worktree): void {
  if (wt.isProtected) {
    throw new Error(
      `Refusing to perform fix work in protected worktree '${wt.name}' (role=${wt.role}). ` +
        `Fix work is only allowed in a fresh SecFix-* worktree.`,
    );
  }
}
