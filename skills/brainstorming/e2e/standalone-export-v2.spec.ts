import { expect, test } from "@playwright/test";

declare const require: {
  (id: string): unknown;
  resolve(id: string): string;
};

interface FileSystem {
  readFileSync(file: string, encoding: "utf8"): string;
  writeFileSync(file: string, contents: string): void;
}

interface NodeUrl {
  pathToFileURL(file: string): { href: string };
}

interface StandaloneBuilder {
  buildStandaloneHtml(screen: unknown, session: unknown): string;
}

const fs = require("node:fs") as FileSystem;
const { pathToFileURL } = require("node:url") as NodeUrl;
const { buildStandaloneHtml } = require("../scripts/visual-session.cjs") as StandaloneBuilder;
const productFixtureFile = require.resolve("../fixtures/product-concept-set.json");

function documentRevision(value: Record<string, unknown>): string {
  const semantic = structuredClone(value);
  delete semantic.revision;
  const json = JSON.stringify(semantic);
  let hash = 0x811c9dc5;
  for (let index = 0; index < json.length; index += 1) {
    hash ^= json.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function workspaceFixture(): Record<string, unknown> {
  const document = JSON.parse(fs.readFileSync(productFixtureFile, "utf8")) as Record<string, unknown>;
  document.title = "Visual Companion v2 concepts";
  document.evidence_refs = [{
    id: "EVD-001-design-direction-approval",
    label: "Approved device-aware triptych",
  }];
  document.feedback_threads = [{
    id: "thread-concept-a",
    component_id: "concept-a",
    revision: "a1b2c3d4",
    type: "annotation",
    status: "open",
    comment: "Keep the equal comparison visible.",
    replies: [],
  }];
  document.read_only = true;
  document.revision = documentRevision(document);
  return document;
}

test("network-disabled v2 standalone export preserves Product Choice state and stays read-only", async ({ context, page }, testInfo) => {
  const screen = workspaceFixture();
  const session = {
    version: 1,
    cursor: 0,
    pendingTurns: 1,
    events: [{
      version: 1,
      id: "event-product-choice",
      seq: 1,
      timestamp: 1_725_000_000_000,
      type: "user.turn",
      role: "user",
      clientTurnId: "product-choice-turn",
      message: "Keep this product concept.",
      annotations: [],
      choices: [{
        groupId: "product-concept-choice",
        componentId: "concept-a",
        value: "concept-a",
        label: "Concept A · Command center",
      }],
      screen: { id: "screen", file: "/private-fixture/workspace.json", revision: screen.revision },
      prompt: "private-agent-prompt-must-not-ship",
    }],
    capability_token: "current-capability-value",
    connection_url: "http://localhost/session/?token=current-capability-value",
  };
  const html = buildStandaloneHtml(screen, session);
  const exportFile = testInfo.outputPath("visual-v2.html");
  fs.writeFileSync(exportFile, html);

  const networkRequests: string[] = [];
  const pageErrors: string[] = [];
  page.on("request", request => {
    if (!/^(?:file|data|blob):/u.test(request.url())) networkRequests.push(request.url());
  });
  page.on("pageerror", error => pageErrors.push(error.message));
  await context.setOffline(true);
  await page.goto(pathToFileURL(exportFile).href);

  await expect(page.getByRole("heading", { name: "Visual Companion v2 concepts" })).toBeVisible();
  await expect(page.getByText("Product", { exact: true })).toBeVisible();
  await expect(page.getByText("Approved device-aware triptych", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Choose one product concept" })).toBeVisible();
  const committedOption = page.getByRole("button", { name: "Select Concept A · Command center" });
  await expect(committedOption).toBeVisible();
  await expect(committedOption).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('[data-brainstorm-id="concept-a"]')).toHaveCount(1);

  const frameTabs = page.getByRole("tablist", { name: "Workspace frames" });
  const compareTab = frameTabs.getByRole("tab", { name: "Compare concepts" });
  const focusTab = frameTabs.getByRole("tab", { name: "Focused concept" });
  const comparePanelId = await compareTab.getAttribute("aria-controls");
  const focusPanelId = await focusTab.getAttribute("aria-controls");
  expect(comparePanelId).not.toBeNull();
  expect(focusPanelId).not.toBeNull();
  await expect(page.locator(`#${comparePanelId}`)).toBeVisible();
  await expect(page.locator(`#${focusPanelId}`)).toBeHidden();
  await expect(page.getByText("Keep the equal comparison visible.", { exact: true })).toBeVisible();
  await focusTab.click();
  await expect(page.locator(`#${comparePanelId}`)).toBeHidden();
  await expect(page.locator(`#${focusPanelId}`)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Accessibility behavior", exact: true })).toBeVisible();
  await expect(page.getByText("Keep this product concept.", { exact: true })).toBeVisible();
  await expect(page.getByText(`rev ${String(screen.revision)}`, { exact: true })).toBeVisible();
  await expect(page.getByText(/Read-only export/u)).toBeVisible();
  await expect(page.getByRole("button", { name: "Save feedback batch" })).toBeDisabled();
  await expect(page.getByPlaceholder("Add one summary note…")).toBeDisabled();
  await expect(page.getByRole("alert")).toBeHidden();

  const visibleText = await page.locator("#visual-shell-root").innerText();
  expect(visibleText.trim().length).toBeGreaterThan(100);
  expect(networkRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(html).not.toMatch(/<link rel="stylesheet"|<script src=/u);
  expect(html).not.toMatch(/current-capability-value|private-agent-prompt-must-not-ship|brainstorm_session=|\/Users\/private/u);
});

test("direct v1 keeps derived Point and Element feedback targets and renders Flow Points", async ({ page }, testInfo) => {
  const screen = {
    version: 1,
    profile: "technical",
    title: "Legacy identity review",
    sections: [{
      kind: "flow",
      id: "delivery-flow",
      title: "Delivery flow",
      nodes: [{
        id: "delivery-source",
        title: "Source",
        detail: "Read Factory.cs:135 before delivery.",
        points: ["Flow Point remains individually targetable."],
      }, {
        id: "delivery-target",
        title: "Target",
      }],
    }, {
      kind: "mockup",
      id: "delivery-mockup",
      title: "Delivery mockup",
      device: "desktop",
      regions: [{
        id: "delivery-region",
        title: "Delivery region",
        elements: [{ kind: "button", label: "Deliver" }],
      }],
    }],
  };
  const html = buildStandaloneHtml(screen, { version: 1, cursor: 0, pendingTurns: 0, events: [] });
  const exportFile = testInfo.outputPath("visual-v1-identities.html");
  fs.writeFileSync(exportFile, html);

  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.goto(pathToFileURL(exportFile).href);

  await expect(page.locator('[data-brainstorm-id="delivery-source-p1"]')).toContainText("Flow Point remains individually targetable.");
  await expect(page.locator('[data-brainstorm-id="delivery-region-e1"]')).toBeVisible();
  await expect(page.locator('select#feedback-target option[value="delivery-source-p1"]')).toHaveCount(1);
  await expect(page.locator('select#feedback-target option[value="delivery-region-e1"]')).toHaveCount(1);
  const fileReference = page.getByRole("button", { name: "Copy file reference Factory.cs:135" });
  await expect(fileReference).toBeVisible();
  await fileReference.click();
  expect(pageErrors).toEqual([]);
});
