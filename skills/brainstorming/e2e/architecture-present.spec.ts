import { expect, test, type Page, type TestInfo } from "@playwright/test";

declare const process: {
  env: Record<string, string | undefined>;
  execPath: string;
};

declare const require: {
  (id: string): unknown;
  resolve(id: string): string;
};

interface ReadableTextStream {
  on(event: "data", listener: (chunk: string) => void): void;
  off(event: "data", listener: (chunk: string) => void): void;
  setEncoding(encoding: "utf8"): void;
}

interface ChildProcess {
  exitCode: number | null;
  kill(signal: "SIGTERM"): boolean;
  once(event: "exit", listener: () => void): void;
  stderr: ReadableTextStream;
  stdout: ReadableTextStream;
}

interface ChildProcessModule {
  spawn(
    command: string,
    args: string[],
    options: {
      encoding: "utf8";
      env: Record<string, string | undefined>;
      stdio: ["ignore", "pipe", "pipe"];
    },
  ): ChildProcess;
}

interface FileSystem {
  mkdirSync(path: string, options: { recursive: true }): void;
  writeFileSync(path: string, contents: string): void;
}

interface PresentedSession {
  connection_url: string;
  elk_preflight: { status: string };
  render_preflight?: unknown;
  session_dir: string;
  type: string;
}

const childProcess = require("node:child_process") as ChildProcessModule;
const fs = require("node:fs") as FileSystem;
const sessionCli = require.resolve("../scripts/visual-session.cjs");

function architectureDraft(): Record<string, unknown> {
  return {
    work_id: "work-20260713-architecture-browser-preflight",
    title: "Architecture browser preflight",
    evidence: [{ id: "EVD-001-browser-preflight", label: "Browser preflight fixture" }],
    boundaries: [{ id: "runtime", label: "Runtime" }],
    nodes: [
      {
        id: "request-source",
        label: "Request source",
        owner_id: "runtime",
        type: "interface",
        ports: [{
          id: "request-output",
          label: "Request",
          direction: "output",
          kind: "command",
          protocol: "HTTP",
        }],
      },
      {
        id: "request-handler",
        label: "Request handler",
        owner_id: "runtime",
        type: "service",
        ports: [{
          id: "request-input",
          label: "Request",
          direction: "input",
          kind: "command",
          protocol: "HTTP",
        }],
      },
    ],
    edges: [{
      id: "request-flow",
      label: "Request flow",
      type: "command",
      source: { node_id: "request-source", port_id: "request-output" },
      target: { node_id: "request-handler", port_id: "request-input" },
    }],
    scenarios: [{
      id: "handle-request",
      label: "Handle request",
      description: "Deliver one request to the handler.",
      paths: {
        current: {
          node_ids: ["request-source", "request-handler"],
          edge_ids: ["request-flow"],
        },
        proposed: {
          node_ids: ["request-source", "request-handler"],
          edge_ids: ["request-flow"],
        },
      },
    }],
    decisions: [{
      id: "request-transport",
      title: "Choose request transport",
      options: [
        { id: "http-transport", label: "HTTP" },
        { id: "queue-transport", label: "Queue" },
      ],
    }],
  };
}

function firstLine(stream: ReadableTextStream): Promise<string> {
  stream.setEncoding("utf8");
  return new Promise(resolve => {
    let buffered = "";
    const onData = (chunk: string): void => {
      buffered += chunk;
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      stream.off("data", onData);
      resolve(buffered.slice(0, newline));
    };
    stream.on("data", onData);
  });
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>(resolve => child.once("exit", resolve));
  child.kill("SIGTERM");
  await Promise.race([
    exited,
    new Promise<void>(resolve => setTimeout(resolve, 3_000)),
  ]);
}

async function openPresentedArchitecture(page: Page, testInfo: TestInfo): Promise<{
  child: ChildProcess;
  info: PresentedSession;
}> {
  const outputDir = testInfo.outputPath("present-session");
  const draftFile = testInfo.outputPath("architecture-draft.json");
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(draftFile, `${JSON.stringify(architectureDraft())}\n`);
  const child = childProcess.spawn(process.execPath, [
    sessionCli,
    "present",
    "--draft", draftFile,
    "--project-dir", outputDir,
  ], {
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const info = JSON.parse(await firstLine(child.stdout)) as PresentedSession;
  await page.goto(info.connection_url);
  return { child, info };
}

test("Architecture Draft present journey reaches a nonblank ready Visual Shell", async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  const { child, info } = await openPresentedArchitecture(page, testInfo);
  try {
    expect(info.type).toBe("visual-session-presented");
    expect(info.elk_preflight.status).toBe("ready");
    expect(info.render_preflight).toBeUndefined();
    const canvas = page.locator('[data-architecture-canvas][data-layout-engine="elk"]');
    await expect(canvas).toHaveAttribute("data-layout-status", "ready");
    await expect(canvas.locator("[data-architecture-node]")).toHaveCount(2);
    await expect(canvas.locator("[data-architecture-edge]")).toHaveCount(1);
    await expect(page.getByRole("region", { name: "Decisions" })).toBeVisible();
    await expect(page.getByRole("button", { name: "HTTP", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Queue", exact: true })).toBeVisible();
    expect(pageErrors).toEqual([]);
  } finally {
    await stop(child);
  }
});
