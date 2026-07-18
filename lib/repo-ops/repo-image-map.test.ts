import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRepoImageMap, normalizeImage, resolveImage } from "./repo-image-map.ts";
import type { RepoImageMap } from "./types.ts";

function withMap(json: string, fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "vuln-repo-image-map-"));
  try {
    const p = join(dir, "repo-image-map.json");
    writeFileSync(p, json);
    fn(p);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("normalizeImage_WhenHostQualified_ThenStripsHostAndLowercases", () => {
  assert.equal(normalizeImage("MyRegistry.azurecr.io/Calibration/Product"), "calibration/product");
  assert.equal(normalizeImage("localhost:5000/foo/bar"), "foo/bar");
});

test("normalizeImage_WhenBarePath_ThenUnchangedExceptCase", () => {
  assert.equal(normalizeImage("calibration/product"), "calibration/product");
  assert.equal(normalizeImage("calibration-product"), "calibration-product");
});

test("loadRepoImageMap_WhenFileMissing_ThenReturnsNull", () => {
  assert.equal(loadRepoImageMap(join(tmpdir(), "definitely-not-here-vuln-map.json")), null);
});

test("loadRepoImageMap_WhenMalformedJson_ThenThrows", () => {
  withMap("{ not json", (p) => assert.throws(() => loadRepoImageMap(p), /not valid JSON/));
});

test("loadRepoImageMap_WhenNoMappingsArray_ThenThrows", () => {
  withMap(JSON.stringify({ foo: [] }), (p) =>
    assert.throws(() => loadRepoImageMap(p), /must have a "mappings" array/),
  );
});

test("loadRepoImageMap_WhenDuplicateImageToDifferentRepos_ThenThrows", () => {
  withMap(
    JSON.stringify({
      mappings: [
        { group: "Calibration", repo: "Product", images: ["calibration/product"] },
        { group: "Regrinding", repo: "Product", images: ["myreg.io/calibration/product"] },
      ],
    }),
    (p) => assert.throws(() => loadRepoImageMap(p), /mapped to both/),
  );
});

test("loadRepoImageMap_WhenValid_ThenIndexesNormalizedKeys", () => {
  withMap(
    JSON.stringify({
      mappings: [
        { group: "Calibration", repo: "Product", images: ["MyReg.io/Calibration/Product"] },
        { repo: "Infra", images: ["infra"] },
      ],
    }),
    (p) => {
      const map = loadRepoImageMap(p) as RepoImageMap;
      assert.equal(map.entries.length, 2);
      assert.deepEqual(map.byImage["calibration/product"], { group: "Calibration", repo: "Product" });
      assert.equal(map.byImage["Infra"], undefined); // key is normalized (lowercased)
      assert.deepEqual(map.byImage["infra"], { group: null, repo: "Infra" });
    },
  );
});

test("resolveImage_WhenReportedFormDiffersFromMapForm_ThenStillMatches", () => {
  withMap(
    JSON.stringify({ mappings: [{ group: "Calibration", repo: "Product", images: ["calibration/product"] }] }),
    (p) => {
      const map = loadRepoImageMap(p) as RepoImageMap;
      // map stored bare path; reported string carries a registry host -> matches
      assert.deepEqual(resolveImage(map, "myregistry.azurecr.io/calibration/product"), {
        group: "Calibration",
        repo: "Product",
      });
      // and the exact bare form matches too
      assert.deepEqual(resolveImage(map, "calibration/product"), { group: "Calibration", repo: "Product" });
      assert.equal(resolveImage(map, "something/else"), undefined);
    },
  );
});
