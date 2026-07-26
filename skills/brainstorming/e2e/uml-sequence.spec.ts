import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";

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

interface SequenceServer {
  close(reason?: string): Promise<void>;
  contentDir: string;
  listen(): Promise<{ connection_url: string }>;
  stateDir: string;
}

interface SequenceServerFactory {
  createBrainstormServer(options: {
    sessionDir: string;
    host: "127.0.0.1";
    port: 0;
    token: string;
    sessionId: string;
    idleTimeoutMs: number;
  }): SequenceServer;
}

interface ActivationBar {
  messageId: string;
  componentId: string;
  label: string;
  depth: number;
  openEnded: boolean;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

const fs = require("node:fs") as FileSystem;
const path = require("node:path") as PathModule;
const { createBrainstormServer } = require("../scripts/server.cjs") as SequenceServerFactory;
const fixtureFile = require.resolve("../fixtures/uml-sequence.json");

// The fixture's bus lifeline receives four async notifications, does two pieces of self work,
// and serves one synchronous pull. Only the self work and the pull are activations a reader
// can see the end of.
const BUS_LIFELINE = "channel";
const BUS_BAR_MESSAGE_IDS = ["sanitize", "persist", "pull"];
const ASYNC_MESSAGE_IDS = ["tool-start", "render", "patch", "tool-done", "completed"];

let app: SequenceServer | undefined;

async function openSequenceDiagram(page: Page, testInfo: TestInfo): Promise<void> {
  app = createBrainstormServer({
    sessionDir: testInfo.outputPath("uml-sequence-session"),
    host: "127.0.0.1",
    port: 0,
    token: "uml-sequence-test-capability",
    sessionId: `uml-sequence-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`,
    idleTimeoutMs: 60_000,
  });
  fs.writeFileSync(
    path.join(app.contentDir, "workspace.json"),
    fs.readFileSync(fixtureFile, "utf8"),
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
  await expect(page.locator("[data-uml-sequence]")).toHaveAttribute("data-layout-status", "ready");
  await expect(page.locator(".uml-seq-lifeline").first()).toBeVisible();
}

function canvas(page: Page): Locator {
  return page.locator(".uml-sequence-canvas");
}

async function activationBars(page: Page): Promise<ActivationBar[]> {
  return canvas(page).locator(".uml-seq-activation-group").evaluateAll(groups => (
    groups.map(group => {
      const rect = group.querySelector("rect");
      const box = rect?.getBoundingClientRect();
      return {
        messageId: group.getAttribute("data-message-id") ?? "",
        componentId: group.getAttribute("data-brainstorm-id") ?? "",
        label: group.getAttribute("data-brainstorm-label") ?? "",
        depth: Number(group.getAttribute("data-activation-depth")),
        openEnded: group.getAttribute("data-activation-open-ended") === "true",
        title: group.querySelector("title")?.textContent ?? "",
        x: box?.x ?? 0,
        y: box?.y ?? 0,
        width: box?.width ?? 0,
        height: box?.height ?? 0,
      };
    })
  ));
}

async function canvasHeight(page: Page): Promise<number> {
  return canvas(page).evaluate(element => element.getBoundingClientRect().height);
}

async function selectedComponentIds(page: Page): Promise<string[]> {
  return page.locator('[data-annotation-selected="true"]').evaluateAll(elements => (
    elements.map(element => element.getAttribute("data-brainstorm-id") ?? "")
  ));
}

test.afterEach(async () => {
  await app?.close("uml sequence test complete");
  app = undefined;
});

test.describe("UML sequence activation legibility", () => {
  test("gives every activation bar the action it belongs to", async ({ page }, testInfo) => {
    await openSequenceDiagram(page, testInfo);

    const bars = await activationBars(page);
    expect(bars.length, "the fixture draws activation bars").toBeGreaterThan(0);

    const unattributed = bars.filter(bar => bar.messageId === "" || bar.componentId === "" || bar.label === "");
    expect(
      unattributed.map(bar => `bar at y=${Math.round(bar.y)} names no action`),
      "a reader must be able to trace every bar back to one message",
    ).toEqual([]);

    for (const bar of bars) {
      expect(bar.title, `${bar.messageId} bar must explain itself on hover`).toContain(bar.label);
    }
  });

  test("draws no bar for a fire-and-forget notification", async ({ page }, testInfo) => {
    await openSequenceDiagram(page, testInfo);

    const bars = await activationBars(page);
    const asyncBars = bars.filter(bar => ASYNC_MESSAGE_IDS.includes(bar.messageId));
    expect(
      asyncBars.map(bar => bar.messageId),
      "an async message has no observable return, so it must not open a bar that never closes",
    ).toEqual([]);

    // This is the regression: the bus used to own one bar per message it ever received.
    const busBars = bars.filter(bar => bar.title.includes(BUS_LIFELINE));
    expect(busBars.map(bar => bar.messageId).sort(), "only real activations belong to the bus").toEqual(
      [...BUS_BAR_MESSAGE_IDS].sort(),
    );
    expect(
      [...new Set(busBars.map(bar => bar.depth))],
      "no bar may be pushed sideways by a phantom parent activation",
    ).toEqual([0]);
  });

  test("keeps every bar clear of the bottom of the diagram", async ({ page }, testInfo) => {
    await openSequenceDiagram(page, testInfo);

    const [bars, height] = await Promise.all([activationBars(page), canvasHeight(page)]);
    const canvasBox = await canvas(page).boundingBox();
    expect(canvasBox, "canvas must have geometry").not.toBeNull();
    const bottom = canvasBox!.y + height;

    // A bar that runs to the floor is a bar whose end nobody modelled; stacked, they were
    // indistinguishable from one another.
    const runaways = bars
      .filter(bar => bar.y + bar.height > bottom - 24)
      .map(bar => `${bar.messageId} bar runs to the bottom of the diagram`);
    expect(runaways, "an activation must end where its lifeline stops working").toEqual([]);
  });

  test("separates nested bars and flags the ones with no reply", async ({ page }, testInfo) => {
    await openSequenceDiagram(page, testInfo);

    const bars = await activationBars(page);
    const byColumn = new Map<number, ActivationBar[]>();
    for (const bar of bars) {
      const column = Math.round((bar.x - bar.depth * 8) / 4);
      byColumn.set(column, [...byColumn.get(column) ?? [], bar]);
    }

    // Two bars on one lifeline must never share an edge: an offset smaller than the bar width
    // merged a nest of them into a single blurred block.
    const collisions: string[] = [];
    for (const column of byColumn.values()) {
      for (const left of column) {
        for (const right of column) {
          if (left.messageId >= right.messageId) continue;
          const verticalOverlap = Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y);
          if (verticalOverlap <= 1) continue;
          const offset = Math.abs(left.x - right.x);
          if (offset < left.width * 0.5) {
            collisions.push(`${left.messageId} and ${right.messageId} overlap in time but sit ${Math.round(offset)}px apart`);
          }
        }
      }
    }
    expect(collisions, "bars alive at the same moment must be told apart by their offset").toEqual([]);

    const openEnded = bars.filter(bar => bar.openEnded);
    expect(openEnded.map(bar => bar.messageId), "an unanswered call is flagged, not hidden").toEqual(["post-turn"]);
    for (const bar of openEnded) {
      expect(bar.title, "the flag has to say why the bar ends where it does").toContain("no reply");
    }
  });

  test("lets a reviewer click a bar to comment on the action that opened it", async ({ page }, testInfo) => {
    await openSequenceDiagram(page, testInfo);

    // The timeline scrolls inside its own container, so let Playwright bring the bar into
    // view rather than clicking a viewport coordinate the bar has scrolled past.
    const bar = canvas(page).locator('.uml-seq-activation-group[data-message-id="pull"] rect');
    await bar.click();

    expect(
      await selectedComponentIds(page),
      "clicking an activation selects the message that opened it",
    ).toEqual(["pull"]);

    // The outline belongs on the arrow and its label, not on the bar that is only a second
    // way to reach the same Component.
    const selectedIsSecondary = await page
      .locator('[data-annotation-selected="true"]')
      .evaluate(element => element.hasAttribute("data-brainstorm-secondary"));
    expect(selectedIsSecondary, "the primary element carries the selection outline").toBe(false);
  });
});
