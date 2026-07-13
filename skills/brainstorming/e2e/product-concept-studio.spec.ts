import { expect, test, type Page, type TestInfo } from "@playwright/test";

declare const require: {
  (id: string): unknown;
  resolve(id: string): string;
};

interface FileSystem {
  readFileSync(file: string, encoding: "utf8"): string;
  writeFileSync(file: string, contents: string, options?: { mode?: number }): void;
}

interface PathModule {
  join(...parts: string[]): string;
}

interface SessionEvent {
  type?: string;
  choices?: Array<{
    groupId?: string;
    componentId?: string;
    value?: string;
    label?: string;
  }>;
}

interface ProductServer {
  close(reason?: string): Promise<void>;
  contentDir: string;
  listen(): Promise<{ connection_url: string }>;
  stateDir: string;
  store: { snapshot(): { events: SessionEvent[] } };
}

interface ProductServerFactory {
  createBrainstormServer(options: {
    sessionDir: string;
    host: "127.0.0.1";
    port: 0;
    token: string;
    sessionId: string;
    idleTimeoutMs: number;
  }): ProductServer;
}

const fs = require("node:fs") as FileSystem;
const path = require("node:path") as PathModule;
const { createBrainstormServer } = require("../scripts/server.cjs") as ProductServerFactory;
const fixtureFile = require.resolve("../fixtures/product-concept-set.json");

let app: ProductServer | undefined;

function productFixture(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(fixtureFile, "utf8")) as Record<string, unknown>;
}

async function openProductStudio(page: Page, testInfo: TestInfo): Promise<void> {
  app = createBrainstormServer({
    sessionDir: testInfo.outputPath("product-concept-session"),
    host: "127.0.0.1",
    port: 0,
    token: "product-concept-test-capability",
    sessionId: `product-concept-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`,
    idleTimeoutMs: 60_000,
  });
  fs.writeFileSync(
    path.join(app.contentDir, "workspace.json"),
    `${JSON.stringify(productFixture())}\n`,
    { mode: 0o600 },
  );
  fs.writeFileSync(
    path.join(app.stateDir, "visual-format.json"),
    `${JSON.stringify({
      version: 1,
      active_version: 2,
      v1_document: "content/screen.json",
      v2_document: "content/workspace.json",
    })}\n`,
    { mode: 0o600 },
  );
  const address = await app.listen();
  await page.goto(address.connection_url);
  await expect(page.getByRole("heading", { name: "Feedback review concepts" })).toBeVisible();
}

test.beforeEach(async ({ page }, testInfo) => {
  await openProductStudio(page, testInfo);
});

test.afterEach(async () => {
  await app?.close();
  app = undefined;
});

test("product concept set uses the approved device-aware comparison before revealing a recommendation", async ({ page }) => {
  await page.setViewportSize({ width: 1_440, height: 900 });

  const wall = page.locator("[data-product-concept-wall]");
  const concepts = wall.locator("[data-product-concept]");
  await expect(page.getByRole("heading", { level: 1, name: "Feedback review concepts" })).toHaveCount(1);
  await expect(page.getByRole("heading", { level: 2, name: "Compare product concepts" })).toHaveCount(1);
  await expect(concepts.nth(0).getByRole("heading", { level: 3, name: "Concept A · Command center" })).toHaveCount(1);
  await expect(wall).toHaveAttribute("data-layout", "desktop-stacked");
  await expect(concepts).toHaveCount(3);
  await expect(concepts.nth(0)).toContainText("Concept A · Command center");
  await expect(concepts.nth(1)).toContainText("Concept B · Guided review");
  await expect(concepts.nth(2)).toContainText("Concept C · Direct manipulation");
  await expect(page.locator("[data-product-equal-fixture]")).toContainText(
    "Same device, scope, fidelity, and data",
  );
  await expect(page.locator("[data-product-difference-lens]")).toBeVisible();
  await expect(page.locator("[data-product-recommendation]")).toBeHidden();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(wall).toHaveAttribute("data-layout", "mobile-three-up");
  await expect(concepts).toHaveCount(3);
  await expect(page.locator("[data-product-difference-lens]")).toBeHidden();
  const widthState = await page.locator("html").evaluate(element => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(widthState.scrollWidth).toBeLessThanOrEqual(widthState.clientWidth);
});

test("product concept set inspection reveals recommendation and complete focus details", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const inspect = page.getByRole("button", { name: "Inspect Concept A · Command center" });
  await expect(inspect).toBeVisible();
  await expect(page.locator("[data-product-recommendation]")).toBeHidden();

  await inspect.focus();
  await expect(inspect).toBeFocused();
  await page.keyboard.press("Enter");

  const focus = page.locator("[data-product-focus]");
  const back = focus.getByRole("button", { name: "Back to comparison" });
  await expect(focus).toBeVisible();
  await expect(back).toBeFocused();
  await expect(focus.getByRole("heading", { name: "Concept A · Command center" })).toBeVisible();
  await expect(page.locator("[data-product-recommendation]")).toContainText(
    "Recommended: Concept B · Guided review",
  );

  const states = focus.getByRole("tablist", { name: "Prototype states" });
  await expect(states.getByRole("tab", { name: "Default" })).toHaveAttribute("aria-selected", "true");
  await states.getByRole("tab", { name: "Error" }).click();
  await expect(focus.locator("[data-product-focus-state]"))
    .toContainText("Keep the Feedback Batch selected and offer retry.");

  const responsive = focus.getByRole("group", { name: "Responsive preview" });
  await responsive.getByRole("button", { name: "Mobile" }).click();
  await expect(focus.locator("[data-product-responsive-preview]"))
    .toContainText("Queue becomes a compact selector above the detail surface.");
  await responsive.getByRole("button", { name: "Desktop" }).click();
  await expect(focus.locator("[data-product-responsive-preview]"))
    .toContainText("Queue, detail, and acknowledgement rail remain visible together.");

  await expect(focus.getByRole("heading", { name: "Accessibility behavior" })).toBeVisible();
  await expect(focus).toContainText("Feedback Batch selection");
  await expect(focus.getByRole("heading", { name: "Implementation handoff" })).toBeVisible();
  await expect(focus).toContainText("FeedbackQueue");
  const motion = await focus.evaluate(element => {
    const style = getComputedStyle(element);
    return { animationDuration: style.animationDuration, transitionDuration: style.transitionDuration };
  });
  expect(motion.animationDuration).toBe("0s");
  expect(motion.transitionDuration).toBe("0s");

  await back.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-product-concept-wall]")).toBeVisible();
  await expect(inspect).toBeFocused();
});

test("product concept Frame navigation keeps focus on the activated tab", async ({ page }) => {
  const frames = page.getByRole("tablist", { name: "Workspace frames" });
  const compare = frames.getByRole("tab", { name: "Compare concepts" });
  const focus = frames.getByRole("tab", { name: "Focused concept" });

  await compare.focus();
  await page.keyboard.press("ArrowRight");

  await expect(focus).toHaveAttribute("aria-selected", "true");
  await expect(focus).toBeFocused();
  await expect(page.locator("[data-product-focus]")).toBeVisible();
});

test("product concept set records one keyboard-made Choice and persists it in the Feedback Batch", async ({ page }) => {
  const choiceGroup = page.locator("[data-product-choice-group]");
  const conceptA = choiceGroup.getByRole("button", { name: "Select Concept A · Command center" });
  const conceptB = choiceGroup.getByRole("button", { name: "Select Concept B · Guided review" });

  await expect(conceptA).toBeVisible();
  await expect(conceptB).toBeVisible();
  await conceptA.focus();
  await page.keyboard.press("Enter");
  await expect(conceptA).toHaveAttribute("aria-pressed", "true");
  await conceptB.focus();
  await page.keyboard.press("Space");
  await expect(conceptA).toHaveAttribute("aria-pressed", "false");
  await expect(conceptB).toHaveAttribute("aria-pressed", "true");
  await expect(choiceGroup.locator('[aria-pressed="true"]')).toHaveCount(1);
  await expect(page.locator("[data-product-recommendation]")).toContainText(
    "Recommended: Concept B · Guided review",
  );

  await page.getByLabel("Summary Note").fill("Proceed with the guided review concept.");
  await page.getByRole("button", { name: "Save feedback batch" }).click();

  await expect.poll(() => app?.store.snapshot().events.filter(event => event.type === "user.turn").length)
    .toBe(1);
  const feedback = app!.store.snapshot().events.find(event => event.type === "user.turn");
  expect(feedback?.choices).toEqual([{
    groupId: "product-concept-choice",
    componentId: "concept-b",
    value: "concept-b",
    label: "Concept B · Guided review",
  }]);
});
