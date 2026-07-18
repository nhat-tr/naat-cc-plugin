// bump — csproj PackageReference version bump + build verification (spec D6).
//
// Text-splice, not an XML rewrite: we locate the exact character range of the
// Version token (attribute value or child-element text) and replace only that
// range, so every other byte of the .csproj (formatting, ordering, comments,
// unrelated attributes) is preserved untouched.

import { readFileSync, writeFileSync } from "node:fs";
import { run, tail } from "./sh.ts";
import type { BumpResult } from "./types.ts";

// A RegExpExecArray produced by a regex with the `d` (hasIndices) flag also
// carries `.indices`, one [start, end] pair per capture group. TS's default
// lib doesn't type this consistently across targets, so we assert it locally.
type ExecWithIndices = RegExpExecArray & { indices: Array<[number, number] | undefined> };

interface Attr {
  name: string;
  value: string;
  /** Character offsets of the value (excluding quotes), relative to the text the attrs were parsed from. */
  valueStart: number;
  valueEnd: number;
}

/** Parse `name="value"` / `name='value'` pairs out of a tag's attribute text, in whatever order they appear. */
function parseAttrs(text: string): Attr[] {
  const attrs: Attr[] = [];
  const re = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gd;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const withIndices = m as ExecWithIndices;
    const dq = m[2];
    const isDouble = dq !== undefined;
    const value = isDouble ? dq : (m[3] as string);
    const range = isDouble ? withIndices.indices[2] : withIndices.indices[3];
    if (!range) continue;
    attrs.push({ name: m[1], value, valueStart: range[0], valueEnd: range[1] });
  }
  return attrs;
}

interface VersionLocation {
  from: string;
  start: number; // absolute offset into the full document text
  end: number;
}

/**
 * Find the Version token for the PackageReference whose Include matches
 * `pkg` (case-insensitive). Handles both the self-closing attribute form and
 * the child-element `<Version>` form, in any attribute order / quote style.
 */
function locateVersion(text: string, pkg: string): VersionLocation | null {
  const tagRe = /<PackageReference\b([^>]*)>/gi;
  const wanted = pkg.trim().toLowerCase();
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(text)) !== null) {
    const tagStart = m.index;
    const rawAttrsText = m[1];
    const selfClosing = /\/\s*$/.test(rawAttrsText);
    const attrsText = selfClosing ? rawAttrsText.replace(/\/\s*$/, "") : rawAttrsText;
    const attrsOffset = tagStart + "<PackageReference".length;
    const attrs = parseAttrs(attrsText);

    const includeAttr = attrs.find((a) => a.name.toLowerCase() === "include");
    if (!includeAttr || includeAttr.value.trim().toLowerCase() !== wanted) {
      continue;
    }

    // Attribute form: <PackageReference Include="X" Version="Y" ... />
    const versionAttr = attrs.find((a) => a.name.toLowerCase() === "version");
    if (versionAttr) {
      return {
        from: versionAttr.value,
        start: attrsOffset + versionAttr.valueStart,
        end: attrsOffset + versionAttr.valueEnd,
      };
    }

    if (selfClosing) {
      // Matching Include but no Version to bump on this element — keep scanning
      // in case another PackageReference element also matches.
      continue;
    }

    // Child-element form: <PackageReference Include="X"><Version>Y</Version></PackageReference>
    const tagEnd = tagStart + m[0].length;
    const rest = text.slice(tagEnd);
    const closeMatch = /<\/PackageReference\s*>/i.exec(rest);
    if (!closeMatch) continue;
    const content = rest.slice(0, closeMatch.index);
    const versionChildRe = /<Version>([^<]*)<\/Version>/id;
    const vMatch = versionChildRe.exec(content) as ExecWithIndices | null;
    if (!vMatch) continue;
    const range = vMatch.indices[1];
    if (!range) continue;
    return {
      from: vMatch[1],
      start: tagEnd + range[0],
      end: tagEnd + range[1],
    };
  }
  return null;
}

/**
 * Bump the `Version` of a direct `<PackageReference Include="pkg" .../>` (or
 * its child-element form) inside `csprojPath` to `toVersion`. Only the
 * version token is rewritten; all other bytes of the file are untouched.
 * Throws if no matching PackageReference/Version is found.
 */
export function bumpPackageReference(
  csprojPath: string,
  pkg: string,
  toVersion: string,
): { from: string; to: string } {
  const original = readFileSync(csprojPath, "utf8");
  const found = locateVersion(original, pkg);
  if (!found) {
    throw new Error(
      `bumpPackageReference: no <PackageReference Include="${pkg}" .../> with a Version was found in ${csprojPath}`,
    );
  }
  const updated = original.slice(0, found.start) + toVersion + original.slice(found.end);
  writeFileSync(csprojPath, updated, "utf8");
  return { from: found.from, to: toVersion };
}

interface ElementLocation {
  version: string;
  start: number; // absolute offset of the opening "<PackageReference"
  end: number; // absolute offset right after the closing "/>" or "</PackageReference>"
}

/**
 * Find the whole `<PackageReference Include="pkg" ... />` element (or its
 * open/child-element/close form), case-insensitive on Include. Returns the
 * element's byte span plus whatever Version it carried (attribute or child).
 */
function locateElement(text: string, pkg: string): ElementLocation | null {
  const tagRe = /<PackageReference\b([^>]*)>/gi;
  const wanted = pkg.trim().toLowerCase();
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(text)) !== null) {
    const tagStart = m.index;
    const rawAttrsText = m[1];
    const selfClosing = /\/\s*$/.test(rawAttrsText);
    const attrsText = selfClosing ? rawAttrsText.replace(/\/\s*$/, "") : rawAttrsText;
    const attrs = parseAttrs(attrsText);

    const includeAttr = attrs.find((a) => a.name.toLowerCase() === "include");
    if (!includeAttr || includeAttr.value.trim().toLowerCase() !== wanted) {
      continue;
    }

    const versionAttr = attrs.find((a) => a.name.toLowerCase() === "version");
    const tagEnd = tagStart + m[0].length;

    if (selfClosing) {
      return { version: versionAttr?.value ?? "", start: tagStart, end: tagEnd };
    }

    const rest = text.slice(tagEnd);
    const closeMatch = /<\/PackageReference\s*>/i.exec(rest);
    if (!closeMatch) continue;
    const content = rest.slice(0, closeMatch.index);
    const versionChildMatch = /<Version>([^<]*)<\/Version>/i.exec(content);
    const elementEnd = tagEnd + closeMatch.index + closeMatch[0].length;
    return {
      version: versionAttr?.value ?? versionChildMatch?.[1] ?? "",
      start: tagStart,
      end: elementEnd,
    };
  }
  return null;
}

/**
 * Remove the `<PackageReference Include="pkg" .../>` element (self-closing or
 * child-element form) from `csprojPath` entirely — used to drop a redundant
 * direct reference that a shared Common project already provides. Trims the
 * element's own line (leading indentation + trailing newline) so no blank
 * line is left behind; every other byte of the file is untouched. Throws if
 * no matching element is found. Returns the version that was removed.
 */
export function removePackageReference(csprojPath: string, pkg: string): { removedVersion: string } {
  const original = readFileSync(csprojPath, "utf8");
  const found = locateElement(original, pkg);
  if (!found) {
    throw new Error(
      `removePackageReference: no <PackageReference Include="${pkg}" .../> was found in ${csprojPath}`,
    );
  }
  let { start, end } = found;
  const lineStart = original.lastIndexOf("\n", start - 1) + 1;
  const prefix = original.slice(lineStart, start);
  if (/^\s*$/.test(prefix)) {
    start = lineStart;
    if (original.startsWith("\r\n", end)) {
      end += 2;
    } else if (original[end] === "\n") {
      end += 1;
    }
  }
  const updated = original.slice(0, start) + original.slice(end);
  writeFileSync(csprojPath, updated, "utf8");
  return { removedVersion: found.version };
}

/**
 * Env vars merged over `process.env` for every `dotnet restore`/`dotnet
 * build` invocation so unattended runs never block on an interactive NuGet
 * credential prompt (the confirmed root cause of a real hang) and stay quiet.
 */
export function nonInteractiveEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NUGET_CREDENTIALPROVIDER_DISABLEINTERACTIVE: "1",
    DOTNET_CLI_TELEMETRY_OPTOUT: "1",
    DOTNET_NOLOGO: "1",
  };
}

/** Result of running the build command(s); `output` feeds `buildOutputTail`. */
export interface BuildRunResult {
  ok: boolean;
  output: string;
}

function defaultBuildRunner(worktreePath: string, env: NodeJS.ProcessEnv): BuildRunResult {
  const restore = run("dotnet", ["restore", "--nologo"], {
    cwd: worktreePath,
    timeoutMs: 600_000,
    env,
  });
  const restoreOutput = restore.stdout + restore.stderr;
  if (!restore.ok) {
    return { ok: false, output: restoreOutput };
  }
  const build = run("dotnet", ["build", "--nologo"], {
    cwd: worktreePath,
    timeoutMs: 600_000,
    env,
  });
  return { ok: build.ok, output: restoreOutput + build.stdout + build.stderr };
}

/**
 * Run `dotnet restore && dotnet build` in `worktreePath` (via `sh.run`) and
 * report the outcome. Always runs with `nonInteractiveEnv()` so a missing
 * NuGet credential provider can never block on a prompt. `runner` is
 * injectable (and receives that env) so tests never have to invoke a real
 * toolchain.
 */
export function verifyBuild(
  worktreePath: string,
  runner: (wt: string, env: NodeJS.ProcessEnv) => BuildRunResult = defaultBuildRunner,
): { buildOk: boolean; buildOutputTail: string } {
  const { ok, output } = runner(worktreePath, nonInteractiveEnv());
  return { buildOk: ok, buildOutputTail: tail(output, 40) };
}

/** Compose the bump and the build-verify step into a single BumpResult (spec D6). */
export function bumpAndBuild(
  csprojPath: string,
  pkg: string,
  toVersion: string,
  worktreePath: string,
  runner?: (wt: string, env: NodeJS.ProcessEnv) => BuildRunResult,
): BumpResult {
  const { from, to } = bumpPackageReference(csprojPath, pkg, toVersion);
  const { buildOk, buildOutputTail } = verifyBuild(worktreePath, runner);
  return { csprojPath, package: pkg, from, to, buildOk, buildOutputTail };
}
