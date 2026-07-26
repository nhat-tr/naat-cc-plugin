import { expect, test } from "@playwright/test";

import { fs, openTwoTabSession, stop } from "./support/two-tab-session";

declare const require: { (id: string): unknown };

interface NodePath {
  join(...parts: string[]): string;
}

const path = require("node:path") as NodePath;

interface StoredTurn {
  type?: string;
  annotations?: Array<{
    comment?: string;
    target?: {
      componentId?: string | null;
      frameId?: string | null;
      frameTitle?: string | null;
      label?: string | null;
      tabId?: string | null;
    };
  }>;
  screen?: {
    diagramKind?: string | null;
    revision?: string | null;
    tabId?: string | null;
    tabLabel?: string | null;
  };
}

// The feedback panel collapses below the workspace split breakpoint; keep it visible.
test.use({ viewport: { width: 1_440, height: 900 } });

function storedUserTurn(eventsFile: string): StoredTurn | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(eventsFile, "utf8");
  } catch {
    return undefined;
  }
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(line => JSON.parse(line) as StoredTurn)
    .find(event => event.type === "user.turn");
}

test("a Feedback Batch submitted from a non-active Workspace Tab persists tab, frame, and component context", async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  const { child, info } = await openTwoTabSession(page, testInfo);
  try {
    // The state machine published last, so it is active; review the Architecture tab instead.
    const tabBar = page.getByRole("tablist", { name: "Workspace tabs" });
    await tabBar.getByRole("tab", { name: "Architecture Canvas", exact: true }).click();
    await expect(page.locator("[data-architecture-canvas]")).toBeVisible();

    // Component options appear only after the canvas layout reports its presented
    // components, so wait for the target select to come alive before interacting.
    const componentSelect = page.locator("#feedback-target");
    await expect(componentSelect).toBeEnabled();

    // The user gesture under test: click a rendered component to anchor the annotation.
    const node = page.locator('[data-architecture-canvas] .architecture-node[data-node-id="request-handler"]');
    await node.click();
    const componentId = await componentSelect.inputValue();
    expect(componentId).toEqual(await node.getAttribute("data-brainstorm-id"));

    await page.locator("#annotation-comment").fill("Clarify this boundary before we build it.");
    await page.getByRole("button", { name: "Add targeted note" }).click();
    await page.getByRole("button", { name: "Save feedback batch" }).click();

    const eventsFile = path.join(info.session_dir, "state", "session.jsonl");
    await expect.poll(() => storedUserTurn(eventsFile) !== undefined, { timeout: 5_000 }).toBe(true);
    const turn = storedUserTurn(eventsFile);

    // Without tab-aware Revision binding this submission would be 409-rejected as stale,
    // because the active document is the state machine, not the annotated architecture tab.
    expect(turn?.screen?.tabId).toBe("architecture");
    expect(turn?.screen?.tabLabel).toBe("Architecture Canvas");
    const target = turn?.annotations?.[0]?.target;
    expect(target?.componentId).toBe(componentId);
    expect(target?.tabId).toBe("architecture");
    expect(target?.frameId).toBeTruthy();
    expect(target?.frameTitle).toBeTruthy();

    expect(pageErrors).toEqual([]);
  } finally {
    await stop(child);
  }
});
