import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  bumpPackageReference,
  removePackageReference,
  verifyBuild,
  bumpAndBuild,
  nonInteractiveEnv,
} from "./bump.ts";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "bump-test-"));
  tmpDirs.push(dir);
  return dir;
}

function writeCsproj(content: string): string {
  const dir = makeTmpDir();
  const path = join(dir, "Test.csproj");
  writeFileSync(path, content, "utf8");
  return path;
}

/** Assert `updated` differs from `original` in exactly one line, and that on
 * that line the only difference is `fromToken` -> `toToken`. */
function assertOnlyVersionChanged(original: string, updated: string, fromToken: string, toToken: string): void {
  const origLines = original.split("\n");
  const newLines = updated.split("\n");
  assert.equal(newLines.length, origLines.length, "line count must be unchanged");
  let changedLines = 0;
  for (let i = 0; i < origLines.length; i++) {
    if (origLines[i] !== newLines[i]) {
      changedLines++;
      assert.equal(
        newLines[i].split(toToken).join(fromToken),
        origLines[i],
        `line ${i} must differ only by the version token`,
      );
    }
  }
  assert.equal(changedLines, 1, "exactly one line should differ");
}

test("bumpPackageReference_WhenSelfClosingAttributeForm_ThenReplacesOnlyVersionValue", () => {
  const original = [
    '<Project Sdk="Microsoft.NET.Sdk">',
    "  <PropertyGroup>",
    "    <TargetFramework>net10.0</TargetFramework>",
    "  </PropertyGroup>",
    "  <ItemGroup>",
    '    <PackageReference Include="System.Text.Json" Version="8.0.0" />',
    "  </ItemGroup>",
    "</Project>",
    "",
  ].join("\n");
  const path = writeCsproj(original);

  const result = bumpPackageReference(path, "System.Text.Json", "8.0.5");

  assert.deepEqual(result, { from: "8.0.0", to: "8.0.5" });
  const updated = readFileSync(path, "utf8");
  assertOnlyVersionChanged(original, updated, "8.0.0", "8.0.5");
});

test("bumpPackageReference_WhenAttributeOrderReversedAndSingleQuoted_ThenStillFound", () => {
  const original = [
    "<Project>",
    "  <ItemGroup>",
    "    <PackageReference Version='2.0.0' Include='Newtonsoft.Json' />",
    "  </ItemGroup>",
    "</Project>",
    "",
  ].join("\n");
  const path = writeCsproj(original);

  const result = bumpPackageReference(path, "Newtonsoft.Json", "2.0.1");

  assert.deepEqual(result, { from: "2.0.0", to: "2.0.1" });
  const updated = readFileSync(path, "utf8");
  assertOnlyVersionChanged(original, updated, "2.0.0", "2.0.1");
});

test("bumpPackageReference_WhenIncludeCasingDiffersFromRequestedPackage_ThenMatchesCaseInsensitively", () => {
  const original = '<PackageReference Include="MyPkg.Thing" Version="1.0.0" />\n';
  const path = writeCsproj(original);

  const result = bumpPackageReference(path, "mypkg.thing", "1.2.3");

  assert.deepEqual(result, { from: "1.0.0", to: "1.2.3" });
});

test("bumpPackageReference_WhenChildElementForm_ThenReplacesOnlyVersionElementText", () => {
  const original = [
    "<Project>",
    "  <ItemGroup>",
    '    <PackageReference Include="Foo.Bar">',
    "      <Version>1.0.0</Version>",
    "    </PackageReference>",
    "  </ItemGroup>",
    "</Project>",
    "",
  ].join("\n");
  const path = writeCsproj(original);

  const result = bumpPackageReference(path, "Foo.Bar", "1.0.1");

  assert.deepEqual(result, { from: "1.0.0", to: "1.0.1" });
  const updated = readFileSync(path, "utf8");
  assertOnlyVersionChanged(original, updated, "1.0.0", "1.0.1");
  assert.ok(updated.includes("<Version>1.0.1</Version>"));
});

test("bumpPackageReference_WhenPackageNotPresent_ThenThrows", () => {
  const path = writeCsproj('<PackageReference Include="Some.Package" Version="1.0.0" />\n');

  assert.throws(() => bumpPackageReference(path, "Does.Not.Exist", "9.9.9"), /Does\.Not\.Exist/);
});

test("bumpPackageReference_WhenRunTwiceWithSameTarget_ThenIdempotent", () => {
  const original = '<PackageReference Include="Idem.Pkg" Version="1.0.0" />\n';
  const path = writeCsproj(original);

  const first = bumpPackageReference(path, "Idem.Pkg", "1.5.0");
  assert.deepEqual(first, { from: "1.0.0", to: "1.5.0" });

  const second = bumpPackageReference(path, "Idem.Pkg", "1.5.0");
  assert.deepEqual(second, { from: "1.5.0", to: "1.5.0" });

  const finalContent = readFileSync(path, "utf8");
  assert.equal(finalContent, '<PackageReference Include="Idem.Pkg" Version="1.5.0" />\n');
});

test("removePackageReference_WhenSelfClosingForm_ThenRemovesOnlyThatElementLine", () => {
  const original = [
    '<Project Sdk="Microsoft.NET.Sdk">',
    "  <ItemGroup>",
    '    <PackageReference Include="Redundant.Pkg" Version="1.2.3" />',
    '    <PackageReference Include="Keep.Pkg" Version="4.5.6" />',
    "  </ItemGroup>",
    "</Project>",
    "",
  ].join("\n");
  const expected = [
    '<Project Sdk="Microsoft.NET.Sdk">',
    "  <ItemGroup>",
    '    <PackageReference Include="Keep.Pkg" Version="4.5.6" />',
    "  </ItemGroup>",
    "</Project>",
    "",
  ].join("\n");
  const path = writeCsproj(original);

  const result = removePackageReference(path, "Redundant.Pkg");

  assert.deepEqual(result, { removedVersion: "1.2.3" });
  assert.equal(readFileSync(path, "utf8"), expected);
});

test("removePackageReference_WhenChildElementForm_ThenRemovesAllLinesOfElement", () => {
  const original = [
    "<Project>",
    "  <ItemGroup>",
    '    <PackageReference Include="Foo.Bar">',
    "      <Version>1.0.0</Version>",
    "    </PackageReference>",
    '    <PackageReference Include="Keep.Pkg" Version="2.0.0" />',
    "  </ItemGroup>",
    "</Project>",
    "",
  ].join("\n");
  const expected = [
    "<Project>",
    "  <ItemGroup>",
    '    <PackageReference Include="Keep.Pkg" Version="2.0.0" />',
    "  </ItemGroup>",
    "</Project>",
    "",
  ].join("\n");
  const path = writeCsproj(original);

  const result = removePackageReference(path, "Foo.Bar");

  assert.deepEqual(result, { removedVersion: "1.0.0" });
  assert.equal(readFileSync(path, "utf8"), expected);
});

test("removePackageReference_WhenIncludeCasingDiffersFromRequestedPackage_ThenMatchesCaseInsensitively", () => {
  const path = writeCsproj('<PackageReference Include="MyPkg.Thing" Version="1.0.0" />\n');

  const result = removePackageReference(path, "mypkg.thing");

  assert.deepEqual(result, { removedVersion: "1.0.0" });
});

test("removePackageReference_WhenPackageNotPresent_ThenThrows", () => {
  const path = writeCsproj('<PackageReference Include="Some.Package" Version="1.0.0" />\n');

  assert.throws(() => removePackageReference(path, "Does.Not.Exist"), /Does\.Not\.Exist/);
});

test("removePackageReference_WhenOtherPackageRemoved_ThenRestOfFileIsByteIdentical", () => {
  const original = [
    "<Project>",
    "  <ItemGroup>",
    '    <PackageReference Include="A.Pkg" Version="1.0.0" />',
    '    <PackageReference Include="B.Pkg" Version="2.0.0" />',
    '    <PackageReference Include="C.Pkg" Version="3.0.0" />',
    "  </ItemGroup>",
    "</Project>",
    "",
  ].join("\n");
  const path = writeCsproj(original);

  removePackageReference(path, "B.Pkg");

  const updated = readFileSync(path, "utf8");
  const updatedLines = updated.split("\n");
  const originalLines = original.split("\n").filter((l) => !l.includes("B.Pkg"));
  assert.deepEqual(updatedLines, originalLines);
});

test("verifyBuild_WhenUsingDefaultRunner_ThenEnvDisablesInteractiveCredentialPromptsAndTelemetry", () => {
  let capturedEnv: NodeJS.ProcessEnv | null = null;
  const runner = (_wt: string, env: NodeJS.ProcessEnv) => {
    capturedEnv = env;
    return { ok: true, output: "Restore succeeded.\nBuild succeeded.\n" };
  };

  verifyBuild("/some/fake/worktree", runner);

  assert.ok(capturedEnv, "runner should have received an env");
  assert.equal(capturedEnv!.NUGET_CREDENTIALPROVIDER_DISABLEINTERACTIVE, "1");
  assert.equal(capturedEnv!.DOTNET_CLI_TELEMETRY_OPTOUT, "1");
  assert.equal(capturedEnv!.DOTNET_NOLOGO, "1");
});

test("nonInteractiveEnv_WhenCalled_ThenMergesNonInteractiveFlagsOverExistingProcessEnv", () => {
  process.env.BUMP_TEST_MARKER = "keep-me";
  try {
    const env = nonInteractiveEnv();

    assert.equal(env.NUGET_CREDENTIALPROVIDER_DISABLEINTERACTIVE, "1");
    assert.equal(env.DOTNET_CLI_TELEMETRY_OPTOUT, "1");
    assert.equal(env.DOTNET_NOLOGO, "1");
    assert.equal(env.BUMP_TEST_MARKER, "keep-me", "must not drop existing process.env vars");
  } finally {
    delete process.env.BUMP_TEST_MARKER;
  }
});

test("verifyBuild_WhenInjectedRunnerReportsSuccess_ThenBuildOkTrueWithoutInvokingDotnet", () => {
  let receivedPath: string | null = null;
  const runner = (wt: string) => {
    receivedPath = wt;
    return { ok: true, output: "Restore succeeded.\nBuild succeeded.\n0 Warning(s)\n0 Error(s)\n" };
  };

  const result = verifyBuild("/some/fake/worktree", runner);

  assert.equal(receivedPath, "/some/fake/worktree");
  assert.equal(result.buildOk, true);
  assert.ok(result.buildOutputTail.includes("Build succeeded."));
});

test("verifyBuild_WhenInjectedRunnerReportsFailure_ThenBuildOkFalseAndTailCapturesOutput", () => {
  const manyLines = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
  const runner = () => ({ ok: false, output: `${manyLines}\nerror CS1002: ; expected` });

  const result = verifyBuild("/some/fake/worktree", runner);

  assert.equal(result.buildOk, false);
  assert.ok(result.buildOutputTail.includes("error CS1002"));
  // tail should be bounded — must not include the earliest lines of a 60-line blob.
  assert.ok(!result.buildOutputTail.includes("line 0\n"));
});

test("bumpAndBuild_WhenComposed_ThenReturnsBumpResultReflectingBumpAndInjectedBuildOutcome", () => {
  const original = '<PackageReference Include="Composed.Pkg" Version="3.0.0" />\n';
  const path = writeCsproj(original);
  const runner = (wt: string) => ({ ok: true, output: `built ${wt}` });

  const result = bumpAndBuild(path, "Composed.Pkg", "3.1.0", "/fake/worktree", runner);

  assert.equal(result.csprojPath, path);
  assert.equal(result.package, "Composed.Pkg");
  assert.equal(result.from, "3.0.0");
  assert.equal(result.to, "3.1.0");
  assert.equal(result.buildOk, true);
  assert.ok(result.buildOutputTail.includes("/fake/worktree"));
});

// --- Optional integration test: only runs when a real `dotnet` toolchain is
// available; otherwise it is explicitly skipped (not failed), keeping the
// suite green in environments without the .NET SDK.
const dotnetProbe = spawnSync("dotnet", ["--version"], { encoding: "utf8" });
const dotnetAvailable = dotnetProbe.status === 0;

test(
  "bumpAndBuild_WhenRealDotnetToolchainBuildsGeneratedClasslib_ThenBuildOkTrue",
  { skip: !dotnetAvailable && "dotnet toolchain not available in this environment" },
  () => {
    const dir = makeTmpDir();
    const created = spawnSync("dotnet", ["new", "classlib", "-o", ".", "--force", "-n", "Probe"], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.equal(created.status, 0, `dotnet new failed: ${created.stderr}`);

    const csprojPath = join(dir, "Probe.csproj");
    const result = verifyBuild(dir);

    assert.equal(result.buildOk, true, `expected a clean build, got tail:\n${result.buildOutputTail}`);
    assert.ok(readFileSync(csprojPath, "utf8").length > 0);
  },
);

after(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});
