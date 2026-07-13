import { expect, test, type Page, type TestInfo } from "@playwright/test";

declare const __dirname: string;
declare const require: { (id: string): unknown };

interface FileSystem {
  readFileSync(file: string, encoding: "utf8"): string;
  writeFileSync(file: string, contents: string): void;
}

interface PathModule {
  join(...parts: string[]): string;
}

interface UrlModule {
  pathToFileURL(file: string): { href: string };
}

interface StandaloneBuilder {
  buildStandaloneHtml(screen: unknown, session: unknown): string;
}

interface LegacyImporter {
  importLegacyVisualState(document: unknown, options: {
    evidenceRefs: Array<{ id: string; label: string }>;
    sessionSnapshot: unknown;
    workId: string;
    workspaceKind: "review";
  }): { document: unknown; session: unknown };
}

interface WorkspaceFixture extends Record<string, unknown> {
  content: Record<string, unknown>;
  revision: string;
  title: string;
  workspace_kind: "architecture" | "business" | "product" | "research" | "review";
}

const fs = require("node:fs") as FileSystem;
const path = require("node:path") as PathModule;
const { pathToFileURL } = require("node:url") as UrlModule;
const { buildStandaloneHtml } = require("../scripts/visual-session.cjs") as StandaloneBuilder;
const { importLegacyVisualState } = require("../scripts/legacy-visual-import.cjs") as LegacyImporter;
const fixtureDirectory = path.join(__dirname, "..", "fixtures");

function fixture(name: string): WorkspaceFixture {
  return JSON.parse(fs.readFileSync(path.join(fixtureDirectory, name), "utf8")) as WorkspaceFixture;
}

function sessionFixture(screen: WorkspaceFixture): Record<string, unknown> {
  return {
    version: 1,
    cursor: 0,
    pendingTurns: 0,
    events: [],
    screen: {
      id: screen.workspace_kind,
      file: "workspace.json",
      revision: screen.revision,
    },
  };
}

async function mountScreen(
  page: Page,
  testInfo: TestInfo,
  screen: WorkspaceFixture,
  artifactName = `${screen.workspace_kind}-feedback-components.html`,
): Promise<void> {
  const html = buildStandaloneHtml(screen, sessionFixture(screen));
  const file = testInfo.outputPath(artifactName);
  fs.writeFileSync(file, html);
  await page.setViewportSize({ width: 1_440, height: 900 });
  await page.goto(pathToFileURL(file).href);
  await expect(page.getByRole("heading", { name: screen.title, exact: true })).toBeVisible();
  await expect(page.locator(".workspace-host")).toBeVisible();
}

async function mount(page: Page, testInfo: TestInfo, fixtureName: string): Promise<void> {
  await mountScreen(page, testInfo, fixture(fixtureName));
}

async function feedbackOptionIds(page: Page): Promise<string[]> {
  return page.locator("#feedback-target option").evaluateAll(options => options
    .map(option => (option as HTMLOptionElement).value)
    .sort());
}

async function presentedComponentIds(page: Page): Promise<string[]> {
  return page.locator(".workspace-canvas [data-brainstorm-id]").evaluateAll(elements => {
    const ids = new Set<string>();
    for (const element of elements) {
      const id = element.getAttribute("data-brainstorm-id");
      if (!id || element.closest("[hidden]")) continue;
      const style = globalThis.getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") continue;
      ids.add(id);
    }
    return [...ids].sort();
  });
}

async function expectFeedbackOptionsMatchPresentedComponents(page: Page, state: string): Promise<void> {
  const [options, presented] = await Promise.all([
    feedbackOptionIds(page),
    presentedComponentIds(page),
  ]);
  expect.soft(options, `${state}: Feedback Panel options must equal currently presented Components`).toEqual(presented);
}

async function expectFeedbackOptionsMatchPresentedTargets(
  page: Page,
  targetIds: string[],
  state: string,
): Promise<void> {
  const [options, presented] = await Promise.all([
    feedbackOptionIds(page),
    presentedComponentIds(page),
  ]);
  const presentedSet = new Set(presented);
  const expected = targetIds.filter(id => presentedSet.has(id)).sort();
  expect.soft(options, `${state}: Feedback Panel options must equal presented annotation targets`).toEqual(expected);
}

test("Architecture feedback Components track the exclusive Current and Proposed modes", async ({ page }, testInfo) => {
  const screen = fixture("architecture-large.json");
  const annotationTargets = screen.content.annotation_targets as string[];
  await mount(page, testInfo, "architecture-large.json");
  await expect(page.locator('[data-architecture-canvas][data-layout-status="ready"]')).toBeVisible();

  await expectFeedbackOptionsMatchPresentedTargets(page, annotationTargets, "Architecture Proposed");

  await page.getByRole("tab", { name: "Current" }).click();
  await expect(page.locator('[data-architecture-viewport][data-mode="current"]')).toBeVisible();
  await expect(page.locator('[data-brainstorm-id="legacy-poll-worker"]')).toBeVisible();
  await expect(page.locator('[data-brainstorm-id="codex-idle-worker"]')).toHaveCount(0);
  await expectFeedbackOptionsMatchPresentedTargets(page, annotationTargets, "Architecture Current");
});

test("Research feedback Components track the active decision-relevance filter", async ({ page }, testInfo) => {
  await mount(page, testInfo, "research-evidence.json");
  await expectFeedbackOptionsMatchPresentedComponents(page, "Research All decisions");

  await page.getByRole("combobox", { name: "Decision relevance" }).selectOption("Runtime support");
  await expect(page.locator('[data-brainstorm-id="claim-durable-wait"]')).toHaveCount(0);
  await expect(page.locator('[data-brainstorm-id="claim-idle-ordering"]')).toBeVisible();
  await expectFeedbackOptionsMatchPresentedComponents(page, "Research Runtime support");
});

test("Product feedback Components track Compare and Focus Frames", async ({ page }, testInfo) => {
  await mount(page, testInfo, "product-concept-set.json");
  await expectFeedbackOptionsMatchPresentedComponents(page, "Product Compare");

  const splitter = page.getByRole("separator", { name: "Workspace canvas width" });
  await splitter.focus();
  await page.keyboard.press("Home");
  await expect(page.locator("[data-product-concept-wall]"))
    .toHaveAttribute("data-layout", "mobile-three-up");
  await expect(page.locator(".product-difference-lens")).toBeHidden();
  await expect(page.locator('#feedback-target option[value="difference-lens"]')).toHaveCount(0);
  await expectFeedbackOptionsMatchPresentedComponents(page, "Product narrow Canvas Compare");

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".product-difference-lens")).toBeHidden();
  await expectFeedbackOptionsMatchPresentedComponents(page, "Product mobile Compare");

  await page.locator(".product-inspect-button").first().click();
  await expect(page.getByRole("tabpanel", { name: "Focused concept" })).toBeVisible();
  await expectFeedbackOptionsMatchPresentedComponents(page, "Product Focus");
});

test("Business feedback Components match the presented journey stages", async ({ page }, testInfo) => {
  await mount(page, testInfo, "business-reasoning.json");
  await expectFeedbackOptionsMatchPresentedComponents(page, "Business journey");
});

test("an imported v2 compatibility document preserves its active Frame feedback Components", async ({ page }, testInfo) => {
  const imported = importLegacyVisualState({
    version: 1,
    profile: "technical",
    title: "Imported compatibility Components",
    sections: [{
      kind: "callout",
      id: "compatibility-intent",
      title: "Compatibility intent",
      summary: "Preserve the active Frame Component inventory.",
      body: "The v2 envelope still renders this content through the v1 compatibility path.",
      tone: "accent",
    }],
  }, {
    evidenceRefs: [{ id: "EVD-001-compatibility", label: "Compatibility evidence" }],
    sessionSnapshot: { version: 1, cursor: 0, pendingTurns: 0, events: [] },
    workId: "work-20260712-visual-companion-vnext",
    workspaceKind: "review",
  });
  const screen = imported.document as WorkspaceFixture;
  await mountScreen(page, testInfo, screen, "imported-compatibility-feedback-components.html");
  await expectFeedbackOptionsMatchPresentedComponents(page, "Imported v2 compatibility Frame");
});

test("Review feedback Components track the active Acceptance Criterion and source context", async ({ page }, testInfo) => {
  await mount(page, testInfo, "feature-review-work.json");
  await expectFeedbackOptionsMatchPresentedComponents(page, "Review initial criterion");

  const criterion = page.locator('[role="tab"][data-acceptance-criterion="AC-15"]');
  await criterion.click();
  await expect(criterion).toHaveAttribute("aria-selected", "true");
  await expectFeedbackOptionsMatchPresentedComponents(page, "Review AC-15");
});
