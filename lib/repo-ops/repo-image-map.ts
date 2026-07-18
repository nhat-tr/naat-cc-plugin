// repo-image-map — load the user-maintained image->repo mapping file.
//
// The file is optional; when absent, buildPlan falls back to its basename
// heuristic. When present, its entries are authoritative for any image string
// they cover. On-disk shape:
//   {
//     "$comment": "...",
//     "mappings": [ { "group": "Calibration", "repo": "Product", "images": ["calibration-product"] }, ... ]
//   }

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RepoImageMap, RepoImageMapEntry } from "./types.ts";

/** Conventional location of the map at the workspace root. */
export const DEFAULT_MAP_BASENAME = "repo-image-map.json";

export function defaultMapPath(workspaceRoot: string): string {
  return join(workspaceRoot, DEFAULT_MAP_BASENAME);
}

/**
 * Normalize an image repository string for matching. Lowercases and strips a
 * leading registry-host segment (one containing '.' or ':', e.g.
 * `myregistry.azurecr.io` or `localhost:5000`). This makes the map insensitive
 * to whether kube-vuln reports the host-qualified form or the bare path, so a
 * map entry of `calibration/product` matches a reported
 * `myregistry.azurecr.io/calibration/product` and vice versa.
 */
export function normalizeImage(s: string): string {
  const segments = s.trim().toLowerCase().split("/");
  if (segments.length > 1 && (segments[0].includes(".") || segments[0].includes(":"))) {
    segments.shift();
  }
  return segments.join("/");
}

/** Authoritative lookup of a reported image string, host-insensitive. */
export function resolveImage(
  map: RepoImageMap,
  image: string,
): { group: string | null; repo: string } | undefined {
  return map.byImage[normalizeImage(image)];
}

/**
 * Load and index the map at `path`. Returns null when the file does not exist
 * (mapping is optional). Throws a clear error on malformed JSON, a bad shape,
 * or a duplicate image string mapped to two different repos.
 */
export function loadRepoImageMap(path: string): RepoImageMap | null {
  if (!existsSync(path)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`image map at '${path}' is not valid JSON: ${(e as Error).message}`);
  }

  const rawEntries = (parsed as { mappings?: unknown })?.mappings;
  if (!Array.isArray(rawEntries)) {
    throw new Error(`image map at '${path}' must have a "mappings" array`);
  }

  const entries: RepoImageMapEntry[] = [];
  const byImage: Record<string, { group: string | null; repo: string }> = {};

  for (const [i, raw] of rawEntries.entries()) {
    const e = raw as Partial<RepoImageMapEntry>;
    if (typeof e.repo !== "string" || !Array.isArray(e.images)) {
      throw new Error(
        `image map at '${path}': mappings[${i}] must have a string "repo" and an "images" array`,
      );
    }
    const entry: RepoImageMapEntry = {
      group: typeof e.group === "string" ? e.group : null,
      repo: e.repo,
      images: e.images.filter((s): s is string => typeof s === "string"),
    };
    entries.push(entry);
    for (const img of entry.images) {
      const key = normalizeImage(img); // host-insensitive matching on both sides
      const existing = byImage[key];
      if (existing && (existing.repo !== entry.repo || existing.group !== entry.group)) {
        throw new Error(
          `image map at '${path}': image '${img}' is mapped to both ` +
            `${existing.group}/${existing.repo} and ${entry.group}/${entry.repo}`,
        );
      }
      byImage[key] = { group: entry.group, repo: entry.repo };
    }
  }

  return { entries, byImage };
}
