import { expect, test } from "@playwright/test";

import {
  architectureDraft,
  firstLine,
  fs,
  openTwoTabSession,
  runCli,
  startSession,
  stop,
  type PresentedSession,
} from "./support/two-tab-session";

test("Workspace Tab Bar keeps a published Architecture Canvas and UML diagram both reachable, switching between them without losing either", async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  const { child } = await openTwoTabSession(page, testInfo);
  try {
    const tabBar = page.getByRole("tablist", { name: "Workspace tabs" });
    await expect(tabBar).toBeVisible();
    // Scoped to the tab bar itself: a UML/Architecture workspace's own FrameNavigator also
    // renders role="tab" elements, and a frame title can coincidentally contain "State Machine"
    // as a substring, so searching the whole page risks an ambiguous match.
    const architectureTab = tabBar.getByRole("tab", { name: "Architecture Canvas", exact: true });
    const stateMachineTab = tabBar.getByRole("tab", { name: "State Machine", exact: true });
    await expect(architectureTab).toBeVisible();
    await expect(stateMachineTab).toBeVisible();

    // The most recently published tab (state machine) is active on first load.
    await expect(stateMachineTab).toHaveAttribute("aria-selected", "true");
    await expect(architectureTab).toHaveAttribute("aria-selected", "false");
    await expect(page.locator('[data-uml-canvas][data-diagram-kind="state_machine"]')).toBeVisible();

    // Switching to the Architecture tab must actually swap the rendered canvas...
    await architectureTab.click();
    await expect(architectureTab).toHaveAttribute("aria-selected", "true");
    await expect(stateMachineTab).toHaveAttribute("aria-selected", "false");
    await expect(page.locator('[data-architecture-canvas]')).toBeVisible();
    await expect(page.locator('[data-uml-canvas]')).toHaveCount(0);

    // ...and switching back must restore the UML diagram, not a blank/lost state.
    await stateMachineTab.click();
    await expect(stateMachineTab).toHaveAttribute("aria-selected", "true");
    await expect(page.locator('[data-uml-canvas][data-diagram-kind="state_machine"]')).toBeVisible();
    await expect(page.locator('[data-architecture-canvas]')).toHaveCount(0);

    expect(pageErrors).toEqual([]);
  } finally {
    await stop(child);
  }
});

test("a session with only one published document renders no Workspace Tab Bar", async ({ page }, testInfo) => {
  const outputDir = testInfo.outputPath("present-session");
  const draftFile = testInfo.outputPath("architecture-draft.json");
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(draftFile, `${JSON.stringify(architectureDraft())}\n`);
  const child = startSession(outputDir);
  const started = JSON.parse(await firstLine(child.stdout)) as PresentedSession;
  try {
    await runCli([
      "migrate", "--work-id", "work-20260723-tab-bar-e2e-single",
      "--workspace-kind", "architecture", "--session-dir", started.session_dir,
    ]);
    await runCli(["present", "--draft", draftFile, "--session-dir", started.session_dir]);
    await page.goto(started.connection_url);
    await expect(page.locator('[data-architecture-canvas]')).toBeVisible();
    await expect(page.getByRole("tablist", { name: "Workspace tabs" })).toHaveCount(0);
  } finally {
    await stop(child);
  }
});
