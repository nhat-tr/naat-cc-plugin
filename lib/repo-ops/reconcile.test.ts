import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconcile } from "./reconcile.ts";

const tmpDirs: string[] = [];

function makeWorktree(csprojRelPath: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "reconcile-test-"));
  tmpDirs.push(dir);
  const csprojPath = join(dir, csprojRelPath);
  mkdirSync(join(csprojPath, ".."), { recursive: true });
  writeFileSync(csprojPath, content, "utf8");
  return dir;
}

test("reconcile_WhenFirstRestoreSucceeds_ThenOkTrueWithOneRoundAndNoActions", () => {
  const worktree = makeWorktree(
    "App.csproj",
    '<PackageReference Include="Newtonsoft.Json" Version="13.0.3" />\n',
  );
  let calls = 0;
  const runner = (wt: string) => {
    calls++;
    assert.equal(wt, worktree);
    return { ok: true, output: "Restore succeeded.\n" };
  };

  const result = reconcile(worktree, { runner });

  assert.equal(result.ok, true);
  assert.equal(result.rounds, 1);
  assert.deepEqual(result.actions, []);
  assert.equal(calls, 1);
});

test("reconcile_WhenOneDowngradeErrorThenSuccess_ThenBumpsParsedPackageToRequiredVersionAndSucceeds", () => {
  const worktree = makeWorktree(
    "App.csproj",
    [
      "<Project>",
      "  <ItemGroup>",
      '    <PackageReference Include="Newtonsoft.Json" Version="12.0.1" />',
      "  </ItemGroup>",
      "</Project>",
      "",
    ].join("\n"),
  );
  const csprojPath = join(worktree, "App.csproj");

  let calls = 0;
  const runner = (_wt: string) => {
    calls++;
    if (calls === 1) {
      return {
        ok: false,
        output:
          "error NU1605: Detected package downgrade: Newtonsoft.Json from 13.0.3 to 12.0.1. " +
          "Reference the package directly from the project to select a different version.\n" +
          " App -> Some.Dep 1.0.0 -> Newtonsoft.Json (>= 13.0.3)\n" +
          " App -> Newtonsoft.Json (>= 12.0.1)\n",
      };
    }
    return { ok: true, output: "Restore succeeded.\n" };
  };

  const result = reconcile(worktree, { runner });

  assert.equal(result.ok, true);
  assert.equal(result.rounds, 2);
  assert.equal(result.actions.length, 1);
  assert.match(result.actions[0], /Newtonsoft\.Json/);
  assert.match(result.actions[0], /12\.0\.1/);
  assert.match(result.actions[0], /13\.0\.3/);
  assert.equal(calls, 2);

  const updated = readFileSync(csprojPath, "utf8");
  assert.ok(updated.includes('Version="13.0.3"'), "csproj should be bumped to the required version");
  assert.ok(!updated.includes('Version="12.0.1"'));
});

test("reconcile_WhenFailureIsNotADowngrade_ThenOkFalseAndStopsImmediately", () => {
  const worktree = makeWorktree(
    "App.csproj",
    '<PackageReference Include="Some.Pkg" Version="1.0.0" />\n',
  );
  let calls = 0;
  const runner = (_wt: string) => {
    calls++;
    return { ok: false, output: "error CS1002: ; expected\nBuild FAILED.\n" };
  };

  const result = reconcile(worktree, { runner });

  assert.equal(result.ok, false);
  assert.equal(result.rounds, 1);
  assert.deepEqual(result.actions, []);
  assert.ok(result.outputTail.includes("CS1002"));
  assert.equal(calls, 1, "should not retry a non-downgrade failure");
});

test("reconcile_WhenDowngradePackageHasNoDeclaringCsproj_ThenOkFalseWithoutRetrying", () => {
  const worktree = makeWorktree(
    "App.csproj",
    '<PackageReference Include="Some.Other.Pkg" Version="1.0.0" />\n',
  );
  let calls = 0;
  const runner = (_wt: string) => {
    calls++;
    return {
      ok: false,
      output: "error NU1605: Detected package downgrade: Ghost.Pkg from 2.0.0 to 1.0.0.\n",
    };
  };

  const result = reconcile(worktree, { runner });

  assert.equal(result.ok, false);
  assert.equal(result.rounds, 1);
  assert.deepEqual(result.actions, []);
  assert.equal(calls, 1);
});

test("reconcile_WhenDowngradeKeepsRecurring_ThenStopsAtMaxRoundsWithOkFalse", () => {
  const worktree = makeWorktree(
    "App.csproj",
    '<PackageReference Include="Flappy.Pkg" Version="1.0.0" />\n',
  );
  let calls = 0;
  const runner = (_wt: string) => {
    calls++;
    return {
      ok: false,
      output: `error NU1605: Detected package downgrade: Flappy.Pkg from 1.0.${calls} to 1.0.0.\n`,
    };
  };

  const result = reconcile(worktree, { maxRounds: 3, runner });

  assert.equal(result.ok, false);
  assert.equal(result.rounds, 3);
  assert.equal(calls, 3, "must not exceed maxRounds restore attempts");
  assert.equal(result.actions.length, 3);
});

after(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});
