import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";

declare const require: {
  (id: string): unknown;
};

interface FileSystem {
  readFileSync(file: string, encoding: "utf8"): string;
  writeFileSync(file: string, contents: string, options?: { mode?: number }): void;
}

interface NodeUrl {
  pathToFileURL(file: string): { href: string };
}

interface StandaloneBuilder {
  buildStandaloneHtml(screen: unknown, session: unknown): string;
}

interface LiveSessionStore {
  publishAgentReply(input: { replyTo: number; message: string }): unknown;
  snapshot(): { events: Array<{ seq?: number; type?: string }> };
}

interface BrainstormServer {
  close(reason?: string): Promise<void>;
  listen(): Promise<{ connection_url: string }>;
  screenPath: string;
  stateDir: string;
  store: LiveSessionStore;
}

interface BrainstormServerFactory {
  createBrainstormServer(options: {
    sessionDir: string;
    host: "127.0.0.1";
    port: 0;
    token: string;
    sessionId: string;
    idleTimeoutMs: number;
  }): BrainstormServer;
}

interface LegacyImporter {
  importLegacyVisualState(
    document: unknown,
    options: {
      workId: string;
      workspaceKind: "review";
      sessionSnapshot: unknown;
      evidenceRefs: Array<{ id: string; label: string }>;
    },
  ): { document: unknown; session: unknown };
}

interface PerformanceBudgets {
  version: number;
  units: {
    time: "milliseconds";
    size: "bytes";
    dom: "nodes";
    workload: "items";
  };
  host: {
    initial_render_ms: number;
    interaction_response_ms: number;
    feedback_persistence_ms: number;
    max_long_task_ms: number;
    max_dom_nodes: number;
  };
  standalone_export: {
    max_bytes: number;
    generation_ms: number;
    open_to_interactive_ms: number;
  };
  stress_workload: {
    changed_files: number;
    architecture_nodes: number;
    architecture_edges: number;
  };
}

const fs = require("node:fs") as FileSystem;
const { pathToFileURL } = require("node:url") as NodeUrl;
const { buildStandaloneHtml } = require("../scripts/visual-session.cjs") as StandaloneBuilder;
const { createBrainstormServer } = require("../scripts/server.cjs") as BrainstormServerFactory;

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
  const { importLegacyVisualState } = require("../scripts/legacy-visual-import.cjs") as LegacyImporter;
  const imported = importLegacyVisualState({
    version: 1,
    profile: "technical",
    audience: "Software developers",
    title: "Shared host behavior",
    summary: "The shared host remains usable through the v1 compatibility path.",
    sections: [{
      kind: "callout",
      id: "intent",
      title: "Intent",
      summary: "Approved purpose",
      body: "Keep the approved purpose visible while navigating the shared host.",
      tone: "accent",
    }, {
      kind: "callout",
      id: "constraints",
      title: "Constraints",
      summary: "Security boundary",
      body: "Keep capability ownership visible at narrow widths.",
      tone: "warning",
    }, {
      kind: "callout",
      id: "handoff",
      title: "Handoff",
      summary: "Delivery state",
      body: "Preserve delivery evidence without hiding the feedback controls.",
      tone: "positive",
    }],
  }, {
    workId: "work-20260712-visual-companion-vnext",
    workspaceKind: "review",
    sessionSnapshot: { version: 1, cursor: 0, pendingTurns: 0, events: [] },
    evidenceRefs: [{ id: "EVD-001-host-contract", label: "Approved host contract" }],
  });
  return imported.document as Record<string, unknown>;
}

function sessionFixture(revision: unknown): Record<string, unknown> {
  return {
    version: 1,
    cursor: 0,
    pendingTurns: 1,
    events: [{
      version: 1,
      id: "host-feedback-event",
      seq: 1,
      timestamp: 1_725_000_000_000,
      type: "user.turn",
      role: "user",
      clientTurnId: "host-feedback-turn",
      message: "Keep the shared host compact without hiding evidence.",
      annotations: [],
      choices: [],
      screen: { id: "review", file: "screen.json", revision },
    }],
  };
}

function denseSessionFixture(revision: unknown): Record<string, unknown> {
  return {
    version: 1,
    cursor: 30,
    pendingTurns: 0,
    events: Array.from({ length: 30 }, (_, index) => {
      const seq = index + 1;
      if (seq % 2 === 0) {
        return {
          version: 1,
          id: `dense-reply-${seq}`,
          seq,
          timestamp: 1_725_000_000_000 + seq * 1_000,
          type: "agent.message",
          role: "agent",
          replyTo: seq - 1,
          message: `Reply ${seq}: retain the evidence and ownership boundary in the next Revision.`,
        };
      }
      return {
        version: 1,
        id: `dense-feedback-${seq}`,
        seq,
        timestamp: 1_725_000_000_000 + seq * 1_000,
        type: "user.turn",
        role: "user",
        clientTurnId: `dense-feedback-turn-${seq}`,
        message: `Feedback ${seq}: keep the shared host readable while the Session Store history grows.`,
        annotations: [],
        choices: [],
        screen: { id: "review", file: "screen.json", revision },
      };
    }),
  };
}

function writeStandalone(
  testInfo: TestInfo,
  name: string,
  screen: unknown,
  session: unknown,
): { file: string; html: string } {
  const html = buildStandaloneHtml(screen, session);
  const file = testInfo.outputPath(name);
  fs.writeFileSync(file, html);
  return { file, html };
}

async function openWorkspace(page: Page, testInfo: TestInfo): Promise<{ file: string; html: string; screen: Record<string, unknown> }> {
  const screen = workspaceFixture();
  const { file, html } = writeStandalone(
    testInfo,
    "workspace-host.html",
    screen,
    sessionFixture(screen.revision),
  );
  await page.goto(pathToFileURL(file).href);
  await expect(page.getByRole("heading", { name: "Shared host behavior" })).toBeVisible();
  return { file, html, screen };
}

function overlapArea(
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width: number; height: number },
): number {
  const width = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  const height = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
  return width * height;
}

async function expectNoPairOverlap(locators: Locator[]): Promise<void> {
  const boxes = await Promise.all(locators.map(locator => locator.boundingBox()));
  for (let left = 0; left < boxes.length; left += 1) {
    for (let right = left + 1; right < boxes.length; right += 1) {
      const leftBox = boxes[left];
      const rightBox = boxes[right];
      expect(leftBox, `item ${left + 1} must have geometry`).not.toBeNull();
      expect(rightBox, `item ${right + 1} must have geometry`).not.toBeNull();
      expect(overlapArea(leftBox!, rightBox!), `items ${left + 1} and ${right + 1} overlap`).toBe(0);
    }
  }
}

async function expectReachableControls(page: Page): Promise<void> {
  const controls = page.locator(
    "button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex='0']",
  );
  const count = await controls.count();
  expect(count).toBeGreaterThan(0);
  for (let index = 0; index < count; index += 1) {
    const control = controls.nth(index);
    if (!(await control.isVisible())) continue;
    await control.scrollIntoViewIfNeeded();
    const box = await control.boundingBox();
    expect(box, `control ${index + 1} must remain reachable`).not.toBeNull();
    const viewport = page.viewportSize();
    expect(viewport).not.toBeNull();
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width + 1);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height + 1);
    expect(box!.x).toBeGreaterThanOrEqual(-1);
    expect(box!.y).toBeGreaterThanOrEqual(-1);
  }
}

function legacyTimelineState(): { document: unknown; session: unknown } {
  const { importLegacyVisualState } = require("../scripts/legacy-visual-import.cjs") as LegacyImporter;
  const sessionSnapshot = {
    version: 1,
    cursor: 0,
    pendingTurns: 1,
    events: [{
      version: 1,
      id: "timeline-event",
      seq: 1,
      timestamp: 1_725_000_000_000,
      type: "user.turn",
      role: "user",
      clientTurnId: "timeline-feedback",
      message: "Keep the Point in the content column.",
      annotations: [{
        id: "timeline-point-note",
        comment: "This long Point must not collapse into the number rail.",
        target: { componentId: "handoff-step-p1", selector: null, label: "Handoff Point" },
      }],
      choices: [],
      screen: { id: "screen", file: "screen.json", revision: "a1b2c3d4" },
    }],
  };
  return importLegacyVisualState({
    version: 1,
    profile: "technical",
    audience: "Software developers",
    title: "Imported delivery timeline",
    summary: "The compatibility path retains exact Point geometry and identity.",
    sections: [{
      kind: "timeline",
      id: "delivery-timeline",
      title: "Delivery timeline",
      items: [{
        id: "handoff-step",
        title: "Feedback handoff",
        detail: "The active agent receives the persisted Feedback Batch.",
        points: [
          "The full Point text uses the content column beside the number rail and remains readable without horizontal scrolling.",
        ],
      }],
    }],
  }, {
    workId: "work-20260712-visual-companion-vnext",
    workspaceKind: "review",
    sessionSnapshot,
    evidenceRefs: [{ id: "EVD-legacy-timeline", label: "Imported timeline regression" }],
  });
}

test("shared host supports keyboard frame navigation, visible focus, and session-persisted density", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1_280, height: 800 });
  const firstWorkspace = await openWorkspace(page, testInfo);

  const frameNavigation = page.getByRole("tablist", { name: /workspace frames/i });
  const intent = frameNavigation.getByRole("tab", { name: "Intent" });
  const constraints = frameNavigation.getByRole("tab", { name: "Constraints" });
  const handoff = frameNavigation.getByRole("tab", { name: "Handoff" });
  await expect(frameNavigation).toBeVisible();
  await expect(intent).toHaveAttribute("aria-selected", "true");

  await intent.focus();
  await page.keyboard.press("ArrowRight");
  await expect(constraints).toBeFocused();
  await expect(constraints).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel", { name: "Constraints" })).toBeVisible();
  const focusStyle = await constraints.evaluate(element => {
    const style = getComputedStyle(element);
    return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
  });
  expect(focusStyle.outlineStyle).not.toBe("none");
  expect(Number.parseFloat(focusStyle.outlineWidth)).toBeGreaterThan(0);

  await page.keyboard.press("End");
  await expect(handoff).toBeFocused();
  await expect(handoff).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Home");
  await expect(intent).toBeFocused();

  const comfortable = page.getByRole("button", { name: "Comfortable" });
  const compact = page.getByRole("button", { name: "Compact" });
  await comfortable.focus();
  await page.keyboard.press("Enter");
  await expect(comfortable).toHaveAttribute("aria-pressed", "true");
  await compact.focus();
  await page.keyboard.press("Space");
  await expect(compact).toHaveAttribute("aria-pressed", "true");
  await expect(comfortable).toHaveAttribute("aria-pressed", "false");
  await page.reload();
  await expect(compact).toHaveAttribute("aria-pressed", "true");

  const secondScreen = workspaceFixture();
  secondScreen.work_id = "work-20260712-visual-companion-second-session";
  secondScreen.title = "Second Visual Session";
  secondScreen.revision = documentRevision(secondScreen);
  const secondWorkspace = writeStandalone(
    testInfo,
    "workspace-host-second-session.html",
    secondScreen,
    sessionFixture(secondScreen.revision),
  );
  await page.goto(pathToFileURL(secondWorkspace.file).href);
  await expect(page.getByRole("button", { name: "Comfortable" })).toHaveAttribute("aria-pressed", "true");
  await page.goto(pathToFileURL(firstWorkspace.file).href);
  await expect(page.getByRole("button", { name: "Compact" })).toHaveAttribute("aria-pressed", "true");

  await expectNoPairOverlap([intent, constraints, handoff]);
});

test("shared host exposes an accessible desktop splitter that resizes both panes and persists", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1_280, height: 800 });
  await openWorkspace(page, testInfo);

  const canvas = page.locator(".workspace-canvas");
  const feedback = page.getByRole("complementary", { name: "Feedback batch" });
  const splitter = page.getByRole("separator", { name: "Workspace canvas width" });
  await expect(splitter).toBeVisible();
  await expect(splitter).toHaveAttribute("aria-controls", "workspace-canvas");
  await expect(splitter).toHaveAttribute("aria-orientation", "vertical");
  await expect(splitter).toHaveAttribute("aria-valuemin", /^\d+$/u);
  await expect(splitter).toHaveAttribute("aria-valuemax", /^\d+$/u);
  await expect(splitter).toHaveAttribute("aria-valuenow", /^\d+$/u);
  await expect(splitter).toHaveAttribute("aria-valuetext", /Workspace canvas .*Feedback panel/iu);

  const beforeCanvas = await canvas.boundingBox();
  const beforeFeedback = await feedback.boundingBox();
  const beforeSplitter = await splitter.boundingBox();
  expect(beforeCanvas).not.toBeNull();
  expect(beforeFeedback).not.toBeNull();
  expect(beforeSplitter).not.toBeNull();
  expect(beforeCanvas!.x + beforeCanvas!.width).toBeLessThanOrEqual(beforeSplitter!.x + 1);
  expect(beforeSplitter!.x + beforeSplitter!.width).toBeLessThanOrEqual(beforeFeedback!.x + 1);

  await splitter.focus();
  await expect(splitter).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");

  const resizedCanvas = await canvas.boundingBox();
  const resizedFeedback = await feedback.boundingBox();
  expect(resizedCanvas).not.toBeNull();
  expect(resizedFeedback).not.toBeNull();
  expect(resizedCanvas!.width).toBeLessThan(beforeCanvas!.width - 1);
  expect(resizedFeedback!.width).toBeGreaterThan(beforeFeedback!.width + 1);

  const resizedSplitter = await splitter.boundingBox();
  expect(resizedSplitter).not.toBeNull();
  await page.mouse.move(
    resizedSplitter!.x + resizedSplitter!.width / 2,
    resizedSplitter!.y + Math.min(resizedSplitter!.height / 2, 200),
  );
  await page.mouse.down();
  await page.mouse.move(resizedSplitter!.x - 48, resizedSplitter!.y + Math.min(resizedSplitter!.height / 2, 200));
  await page.mouse.up();

  const pointerCanvas = await canvas.boundingBox();
  const pointerFeedback = await feedback.boundingBox();
  expect(pointerCanvas).not.toBeNull();
  expect(pointerFeedback).not.toBeNull();
  expect(pointerCanvas!.width).toBeLessThan(resizedCanvas!.width - 20);
  expect(pointerFeedback!.width).toBeGreaterThan(resizedFeedback!.width + 20);
  const persistedCanvasWidth = pointerCanvas!.width;
  const persistedFeedbackWidth = pointerFeedback!.width;

  await page.reload();
  await expect(page.getByRole("heading", { name: "Shared host behavior" })).toBeVisible();
  await expect(page.getByRole("separator", { name: "Workspace canvas width" })).toBeVisible();
  const reloadedCanvas = await canvas.boundingBox();
  const reloadedFeedback = await feedback.boundingBox();
  expect(reloadedCanvas).not.toBeNull();
  expect(reloadedFeedback).not.toBeNull();
  expect(Math.abs(reloadedCanvas!.width - persistedCanvasWidth)).toBeLessThanOrEqual(1);
  expect(Math.abs(reloadedFeedback!.width - persistedFeedbackWidth)).toBeLessThanOrEqual(1);
});

test("shared host keeps coarse-pointer splitter hit geometry out of layout bounds", async ({ browser }, testInfo) => {
  const context = await browser.newContext({
    hasTouch: true,
    viewport: { width: 1_280, height: 800 },
  });
  const page = await context.newPage();

  try {
    await openWorkspace(page, testInfo);
    const splitter = page.getByRole("separator", { name: "Workspace canvas width" });
    const canvas = page.locator(".workspace-canvas");
    const feedback = page.getByRole("complementary", { name: "Feedback batch" });

    await expect(splitter).toBeVisible();
    await splitter.focus();
    await page.keyboard.press("End");

    const splitterBox = await splitter.boundingBox();
    const canvasBox = await canvas.boundingBox();
    const feedbackBox = await feedback.boundingBox();
    expect(splitterBox).not.toBeNull();
    expect(canvasBox).not.toBeNull();
    expect(feedbackBox).not.toBeNull();
    expect(splitterBox!.width).toBeLessThanOrEqual(16);
    expect(feedbackBox!.width).toBeGreaterThanOrEqual(256);
    expect(canvasBox!.x + canvasBox!.width).toBeLessThanOrEqual(splitterBox!.x + 1);
    expect(splitterBox!.x + splitterBox!.width).toBeLessThanOrEqual(feedbackBox!.x + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  } finally {
    await context.close();
  }
});

test("shared host removes the desktop splitter and ignores its persisted size in stacked mobile flow", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1_280, height: 800 });
  await openWorkspace(page, testInfo);

  const splitter = page.getByRole("separator", { name: "Workspace canvas width" });
  await expect(splitter).toBeVisible();
  await splitter.focus();
  await page.keyboard.press("End");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Shared host behavior" })).toBeVisible();
  await expect(page.getByRole("separator", { name: "Workspace canvas width" })).toHaveCount(0);

  const canvas = page.locator(".workspace-canvas");
  const feedback = page.getByRole("complementary", { name: "Feedback batch" });
  const canvasBox = await canvas.boundingBox();
  const feedbackBox = await feedback.boundingBox();
  expect(canvasBox).not.toBeNull();
  expect(feedbackBox).not.toBeNull();
  expect(canvasBox!.width).toBeGreaterThanOrEqual(389);
  expect(feedbackBox!.width).toBeGreaterThanOrEqual(389);
  expect(feedbackBox!.y).toBeGreaterThanOrEqual(canvasBox!.y + canvasBox!.height - 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test("live delivery status follows durable server and adapter evidence", async ({ page }, testInfo) => {
  const app = createBrainstormServer({
    sessionDir: testInfo.outputPath("live-delivery-session"),
    host: "127.0.0.1",
    port: 0,
    token: "live-delivery-test-capability",
    sessionId: "live-delivery-status",
    idleTimeoutMs: 60_000,
  });
  fs.writeFileSync(app.screenPath, `${JSON.stringify({
    version: 1,
    profile: "technical",
    audience: "Software developers",
    title: "Live delivery evidence",
    sections: [{
      kind: "callout",
      id: "delivery-contract",
      title: "Delivery contract",
      body: "The browser presents only observed delivery evidence.",
      tone: "accent",
    }],
  })}\n`, { mode: 0o600 });
  const address = await app.listen();

  try {
    await page.goto(address.connection_url);
    const status = page.getByRole("status", { name: /feedback delivery/i });
    await expect(status).toHaveText("Closed");

    fs.writeFileSync(`${app.stateDir}/delivery-state.json`, `${JSON.stringify({
      version: 1,
      listening: true,
      deliveredThrough: 0,
    })}\n`, { mode: 0o600 });
    await expect(status).toHaveText("Listening");

    await page.getByLabel("Summary Note").fill("Persist this Feedback Batch before claiming delivery.");
    await page.getByRole("button", { name: "Save feedback batch" }).click();
    await expect(status).toHaveText("Queued");
    const feedback = app.store.snapshot().events.find(event => event.type === "user.turn");
    expect(feedback?.seq).toBeGreaterThan(0);

    fs.writeFileSync(`${app.stateDir}/delivery-state.json`, `${JSON.stringify({
      version: 1,
      listening: false,
      deliveredThrough: feedback!.seq,
    })}\n`, { mode: 0o600 });
    await expect(status).toHaveText("Delivered");

    app.store.publishAgentReply({ replyTo: feedback!.seq!, message: "Reply acknowledgement is durable." });
    await expect(status).toHaveText("Acknowledged");

    await app.close("closed");
    await expect(status).toHaveText("Closed");
  } finally {
    await app.close();
  }
});

test("shared host reflows at 320 CSS pixels (1280 at 400% zoom), disables motion, and keeps controls reachable", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openWorkspace(page, testInfo);
  await expect(page.getByRole("tablist", { name: /workspace frames/i })).toBeVisible();
  await expect(page.getByRole("button", { name: "Compact" })).toBeVisible();
  await expect(page.getByRole("alert")).toBeHidden();

  expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
  const movingElements = await page.locator("body *").evaluateAll(elements => elements
    .filter(element => {
      const style = getComputedStyle(element);
      const animated = style.animationName !== "none" && Number.parseFloat(style.animationDuration) > 0;
      const motionTransition = /transform|translate|rotate|scale|left|right|top|bottom|all/u
        .test(style.transitionProperty)
        && Number.parseFloat(style.transitionDuration) > 0;
      return animated || motionTransition || style.scrollBehavior === "smooth";
    })
    .map(element => `${element.tagName.toLowerCase()}#${element.id}`));
  expect(movingElements).toEqual([]);

  const geometry = await page.evaluate(() => ({
    viewport: innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    rootText: document.querySelector("#visual-shell-root")?.textContent?.trim().length ?? 0,
    rootHeight: document.querySelector("#visual-shell-root")?.getBoundingClientRect().height ?? 0,
  }));
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.viewport + 1);
  expect(geometry.rootText).toBeGreaterThan(100);
  expect(geometry.rootHeight).toBeGreaterThan(300);

  const overflowingText = await page.locator("h1, h2, h3, p, button, [role='tab'], [data-brainstorm-id]").evaluateAll(elements => elements
    .filter(element => element.scrollWidth > element.clientWidth + 1)
    .map(element => element.textContent?.trim().slice(0, 80) ?? element.tagName));
  expect(overflowingText).toEqual([]);
  await expectNoPairOverlap([
    page.getByRole("tab", { name: "Intent" }),
    page.getByRole("tab", { name: "Constraints" }),
    page.getByRole("tab", { name: "Handoff" }),
  ]);
  await expectNoPairOverlap([
    page.getByRole("button", { name: "Comfortable" }),
    page.getByRole("button", { name: "Compact" }),
  ]);
  await expectReachableControls(page);
});

test("dense desktop history scrolls without overlapping or hiding feedback compose controls", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1_280, height: 800 });
  const screen = workspaceFixture();
  const { file } = writeStandalone(
    testInfo,
    "workspace-host-dense-history.html",
    screen,
    denseSessionFixture(screen.revision),
  );
  await page.goto(pathToFileURL(file).href);
  await expect(page.getByRole("heading", { name: "Shared host behavior" })).toBeVisible();

  const panel = page.locator(".feedback-panel");
  const compose = page.locator(".feedback-compose");
  const history = page.locator(".history");
  await expect(page.getByPlaceholder("Add one summary note…")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save feedback batch" })).toBeVisible();
  await expect(history.getByText("Feedback 1:", { exact: false })).toBeVisible();

  const geometry = await page.evaluate(() => {
    const rect = (selector: string): DOMRect => {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) throw new Error(`${selector} is missing`);
      return element.getBoundingClientRect();
    };
    const panelRect = rect(".feedback-panel");
    const composeRect = rect(".feedback-compose");
    const historyElement = document.querySelector(".history");
    if (!(historyElement instanceof HTMLElement)) throw new Error(".history is missing");
    const historyRect = historyElement.getBoundingClientRect();
    return {
      compose: { top: composeRect.top, bottom: composeRect.bottom },
      history: {
        top: historyRect.top,
        bottom: historyRect.bottom,
        clientHeight: historyElement.clientHeight,
        scrollHeight: historyElement.scrollHeight,
      },
      panel: { top: panelRect.top, bottom: panelRect.bottom },
    };
  });

  expect(geometry.compose.top).toBeGreaterThanOrEqual(geometry.panel.top - 1);
  expect(geometry.compose.bottom).toBeLessThanOrEqual(geometry.history.top + 1);
  expect(geometry.history.bottom).toBeLessThanOrEqual(geometry.panel.bottom + 1);
  expect(geometry.history.scrollHeight).toBeGreaterThan(geometry.history.clientHeight);

  await history.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect(history.getByText("Reply 30:", { exact: false })).toBeVisible();
});

test("v1 import keeps a timeline Point in the full content column without overlap or horizontal overflow", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1_100, height: 800 });
  const imported = legacyTimelineState();
  const { file } = writeStandalone(testInfo, "imported-timeline.html", imported.document, imported.session);
  await page.goto(pathToFileURL(file).href);

  await expect(page.getByRole("heading", { name: "Imported delivery timeline" })).toBeVisible();
  const card = page.locator('[data-brainstorm-id="handoff-step"]');
  const point = page.locator('[data-brainstorm-id="handoff-step-p1"]');
  const index = card.locator(".timeline-index");
  await expect(point).toContainText("full Point text uses the content column");
  await expect(page.locator(".feedback-thread-gutter").getByText(
    "This long Point must not collapse into the number rail.",
    { exact: true },
  )).toBeVisible();

  const [cardBox, pointBox, indexBox] = await Promise.all([
    card.boundingBox(),
    point.boundingBox(),
    index.boundingBox(),
  ]);
  expect(cardBox).not.toBeNull();
  expect(pointBox).not.toBeNull();
  expect(indexBox).not.toBeNull();
  expect(overlapArea(pointBox!, indexBox!)).toBe(0);
  expect(pointBox!.x).toBeGreaterThan(indexBox!.x + indexBox!.width);
  expect(pointBox!.width).toBeGreaterThan(cardBox!.width * 0.6);
  expect(pointBox!.x + pointBox!.width).toBeLessThanOrEqual(cardBox!.x + cardBox!.width + 1);
  expect(await point.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test("clicking an Item paragraph and nested Point selects the deepest Annotation Component", async ({ page }, testInfo) => {
  const imported = legacyTimelineState();
  const editableDocument = (imported.document as {
    content: { legacy_document: unknown };
  }).content.legacy_document;
  const app = createBrainstormServer({
    sessionDir: testInfo.outputPath("component-annotation-session"),
    host: "127.0.0.1",
    port: 0,
    token: "component-annotation-capability",
    sessionId: `component-annotation-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`,
    idleTimeoutMs: 60_000,
  });
  fs.writeFileSync(
    app.screenPath,
    `${JSON.stringify(editableDocument)}\n`,
    { mode: 0o600 },
  );

  try {
    const address = await app.listen();
    await page.goto(address.connection_url);
    await expect(page.getByRole("heading", { name: "Imported delivery timeline" })).toBeVisible();

    const componentSelect = page.getByLabel("Component", { exact: true });
    const item = page.locator('[data-brainstorm-id="handoff-step"]');
    const point = page.locator('[data-brainstorm-id="handoff-step-p1"]');
    await item.locator(".timeline-content > p").click();
    await expect(componentSelect).toHaveValue("handoff-step");
    await expect(item).toHaveAttribute("data-annotation-selected", "true");

    await point.locator(".point-text").click();
    await expect(componentSelect).toHaveValue("handoff-step-p1");
    await expect(point).toHaveAttribute("data-annotation-selected", "true");
    await expect(item).not.toHaveAttribute("data-annotation-selected", "true");

    const targetedNote = page.getByLabel("Targeted note");
    await targetedNote.fill("Keep this Point explicit in the next Revision.");
    await page.getByRole("button", { name: "Add targeted note" }).click();
    await expect(page.getByLabel("Pending feedback")).toContainText("Feedback handoff · point 1");
    await expect(point).toHaveAttribute("data-annotation-count", "1");
    await expect(point.locator("[data-annotation-badge]"))
      .toHaveText("1");
    await expect(point).toHaveClass(/has-pending-annotations/u);
    await expect(point).toHaveAttribute("title", /1 annotation:[\s\S]*Keep this Point explicit/u);

    await targetedNote.fill("Keep this Point individually selectable.");
    await page.getByRole("button", { name: "Add targeted note" }).click();
    await expect(point).toHaveAttribute("data-annotation-count", "2");
    await expect(point.locator("[data-annotation-badge]"))
      .toHaveText("2");
    await expect(point).toHaveAttribute("title", /2 annotations:[\s\S]*1\.[\s\S]*2\./u);

    const feedbackResponse = page.waitForResponse(response => (
      response.request().method() === "POST" && response.url().endsWith("/api/feedback")
    ));
    await page.getByRole("button", { name: "Save feedback batch" }).click();
    expect((await feedbackResponse).status()).toBe(201);
    await expect(point).toHaveClass(/has-committed-annotations/u);
    await expect(point).not.toHaveClass(/has-pending-annotations/u);
    await expect(point).toHaveAttribute("data-annotation-count", "2");
  } finally {
    await app.close("component annotation test complete");
  }
});

test("provisional host and standalone export budgets are explicit and the measurable size/DOM caps hold", async ({ page }, testInfo) => {
  const budgets = JSON.parse(fs.readFileSync(
    "skills/brainstorming/fixtures/performance-budgets.json",
    "utf8",
  )) as PerformanceBudgets;
  expect(budgets.version).toBe(1);
  expect(budgets.units).toEqual({
    time: "milliseconds",
    size: "bytes",
    dom: "nodes",
    workload: "items",
  });
  expect(budgets.host.initial_render_ms).toBeGreaterThan(0);
  expect(budgets.host.interaction_response_ms).toBeGreaterThan(0);
  expect(budgets.host.feedback_persistence_ms).toBeGreaterThan(0);
  expect(budgets.host.max_long_task_ms).toBeLessThanOrEqual(50);
  expect(budgets.host.max_dom_nodes).toBeGreaterThan(0);
  expect(budgets.standalone_export.max_bytes).toBeGreaterThan(0);
  expect(budgets.standalone_export.generation_ms).toBeGreaterThan(0);
  expect(budgets.standalone_export.open_to_interactive_ms).toBeGreaterThan(0);
  expect(budgets.stress_workload.changed_files).toBe(300);
  expect(budgets.stress_workload.architecture_nodes).toBeGreaterThanOrEqual(100);
  expect(budgets.stress_workload.architecture_edges).toBeGreaterThanOrEqual(100);

  const { html } = await openWorkspace(page, testInfo);
  await expect(page.getByRole("tablist", { name: /workspace frames/i })).toBeVisible();
  expect(new TextEncoder().encode(html).byteLength).toBeLessThanOrEqual(
    budgets.standalone_export.max_bytes,
  );
  expect(await page.locator("body *").count()).toBeLessThanOrEqual(budgets.host.max_dom_nodes);
});
