// Tests for policy.ts — the never-auto-upgrade gate loader. Uses a hermetic
// per-run temp dir (node:test convention); no dependency on the real workspace.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_POLICY_BASENAME,
  defaultPolicyPath,
  isHeld,
  loadPolicy,
  type VulnPolicy,
} from "./policy.ts";

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "vuln-policy-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("loadPolicy_WhenFileDoesNotExist_ThenReturnsNull", () => {
  withTempDir((dir) => {
    assert.equal(loadPolicy(join(dir, "absent.json")), null);
  });
});

test("loadPolicy_WhenWellFormed_ThenReturnsNeverUpgradeList", () => {
  withTempDir((dir) => {
    const path = join(dir, DEFAULT_POLICY_BASENAME);
    writeFileSync(path, JSON.stringify({ neverUpgrade: ["AutoMapper", "MediatR"] }));
    assert.deepEqual(loadPolicy(path), { neverUpgrade: ["AutoMapper", "MediatR"] });
  });
});

test("loadPolicy_WhenJsonIsMalformed_ThenThrows", () => {
  withTempDir((dir) => {
    const path = join(dir, DEFAULT_POLICY_BASENAME);
    writeFileSync(path, "{ not: valid json ");
    assert.throws(() => loadPolicy(path), /not valid JSON/);
  });
});

test("loadPolicy_WhenNeverUpgradeIsNotAnArray_ThenThrows", () => {
  withTempDir((dir) => {
    const path = join(dir, DEFAULT_POLICY_BASENAME);
    writeFileSync(path, JSON.stringify({ neverUpgrade: "AutoMapper" }));
    assert.throws(() => loadPolicy(path), /neverUpgrade/);
  });
});

test("loadPolicy_WhenNeverUpgradeContainsNonString_ThenThrows", () => {
  withTempDir((dir) => {
    const path = join(dir, DEFAULT_POLICY_BASENAME);
    writeFileSync(path, JSON.stringify({ neverUpgrade: ["AutoMapper", 15] }));
    assert.throws(() => loadPolicy(path), /neverUpgrade/);
  });
});

test("isHeld_WhenPackageMatchesCaseInsensitively_ThenTrue", () => {
  const policy: VulnPolicy = { neverUpgrade: ["automapper"] };
  assert.equal(isHeld(policy, "AutoMapper"), true);
  assert.equal(isHeld(policy, "Newtonsoft.Json"), false);
});

test("isHeld_WhenPolicyIsNullOrUndefined_ThenFalse", () => {
  assert.equal(isHeld(null, "AutoMapper"), false);
  assert.equal(isHeld(undefined, "AutoMapper"), false);
});

test("defaultPolicyPath_ThenJoinsWorkspaceRootWithBasename", () => {
  assert.equal(defaultPolicyPath("/ws"), join("/ws", DEFAULT_POLICY_BASENAME));
});
