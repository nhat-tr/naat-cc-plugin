import type { Page, TestInfo } from "@playwright/test";

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

export interface ChildProcess {
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
  readFileSync(path: string, encoding: "utf8"): string;
  writeFileSync(path: string, contents: string): void;
}

export interface PresentedSession {
  connection_url: string;
  session_dir: string;
  tab_id?: string;
  type: string;
}

const childProcess = require("node:child_process") as ChildProcessModule;
export const fs = require("node:fs") as FileSystem;
const sessionCli = require.resolve("../../scripts/visual-session.cjs");

export function architectureDraft(): Record<string, unknown> {
  return {
    work_id: "work-20260723-tab-bar-e2e",
    title: "Tab bar e2e architecture",
    evidence: [{ id: "EVD-001-tab-bar-e2e", label: "Tab bar e2e fixture" }],
    boundaries: [{ id: "runtime", label: "Runtime" }],
    nodes: [
      {
        id: "request-source",
        label: "Request source",
        owner_id: "runtime",
        type: "interface",
        ports: [{ id: "request-output", label: "Request", direction: "output", kind: "command", protocol: "HTTP" }],
      },
      {
        id: "request-handler",
        label: "Request handler",
        owner_id: "runtime",
        type: "service",
        ports: [{ id: "request-input", label: "Request", direction: "input", kind: "command", protocol: "HTTP" }],
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
        current: { node_ids: ["request-source", "request-handler"], edge_ids: ["request-flow"] },
        proposed: { node_ids: ["request-source", "request-handler"], edge_ids: ["request-flow"] },
      },
    }],
    decisions: [],
  };
}

export function stateMachineDraft(): Record<string, unknown> {
  return {
    kind: "uml",
    diagram_kind: "state_machine",
    work_id: "work-20260723-tab-bar-e2e",
    title: "Tab bar e2e state machine",
    nodes: [
      { id: "start", label: "start", node_kind: "initial" },
      { id: "pending", label: "Pending", node_kind: "state" },
      { id: "done", label: "end", node_kind: "final" },
    ],
    edges: [
      { id: "t-start", source: "start", target: "pending" },
      { id: "t-done", label: "complete", source: "pending", target: "done" },
    ],
  };
}

export function firstLine(stream: ReadableTextStream): Promise<string> {
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

export async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>(resolve => child.once("exit", resolve));
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise<void>(resolve => setTimeout(resolve, 3_000))]);
}

export function runCli(args: string[]): Promise<PresentedSession> {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(process.execPath, [sessionCli, ...args], {
      encoding: "utf8",
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.setEncoding("utf8");
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("exit", () => {
      if (child.exitCode !== 0) { reject(new Error(stderr || `exit ${child.exitCode}`)); return; }
      resolve(JSON.parse(stdout.trim().split("\n")[0] ?? "") as PresentedSession);
    });
  });
}

export function startSession(outputDir: string): ChildProcess {
  return childProcess.spawn(process.execPath, [
    sessionCli, "start", "--project-dir", outputDir, "--quiet",
  ], {
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// Bootstraps via `start` (which only ever consults its OWN --project-dir-scoped active-file,
// never the cross-scratch "discover the one live session" fallback that plain `present`/`status`
// fall back to when their own pointer file doesn't exist yet) so this harness can never collide
// with an unrelated Visual Companion session that happens to be live elsewhere on the same machine.
export async function openTwoTabSession(page: Page, testInfo: TestInfo): Promise<{ child: ChildProcess; info: PresentedSession }> {
  const outputDir = testInfo.outputPath("present-session");
  const architectureFile = testInfo.outputPath("architecture-draft.json");
  const stateMachineFile = testInfo.outputPath("state-machine-draft.json");
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(architectureFile, `${JSON.stringify(architectureDraft())}\n`);
  fs.writeFileSync(stateMachineFile, `${JSON.stringify(stateMachineDraft())}\n`);

  const child = startSession(outputDir);
  const started = JSON.parse(await firstLine(child.stdout)) as PresentedSession;

  await runCli([
    "migrate",
    "--work-id", "work-20260723-tab-bar-e2e",
    "--workspace-kind", "architecture",
    "--session-dir", started.session_dir,
  ]);
  const info = await runCli([
    "present",
    "--draft", architectureFile,
    "--session-dir", started.session_dir,
    "--tab-id", "architecture",
    "--tab-label", "Architecture Canvas",
  ]);
  await runCli([
    "present",
    "--draft", stateMachineFile,
    "--session-dir", started.session_dir,
    "--tab-id", "uml-state_machine",
    "--tab-label", "State Machine",
  ]);

  await page.goto(info.connection_url ?? started.connection_url);
  return { child, info: started };
}
