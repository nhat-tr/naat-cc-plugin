/**
 * Shared kubectl port-forward utility.
 * Spawns a port-forward, waits until the local port accepts connections, then yields.
 * Kills the process on cleanup.
 */
import { spawn } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

const CONTEXTS: Record<string, string> = {
  qss:  "WE-POS-QSS-AKS-SVC-2",
  oae:  "WE-POS-OAE-AKS-SVC-2",
  prod: "WE-POS-PROD-AKS-SVC-2",
};

export function resolveContext(env: string): string {
  const ctx = CONTEXTS[env.toLowerCase()];
  if (!ctx) throw new Error(`Unknown env '${env}'. Use: qss, oae, prod`);
  return ctx;
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function waitReady(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = createConnection({ port, host: "127.0.0.1" });
      s.once("connect", () => { s.destroy(); resolve(true); });
      s.once("error", () => { s.destroy(); resolve(false); });
    });
    if (ok) return;
    await sleep(200);
  }
  throw new Error(`Port-forward to :${port} not ready after ${timeoutMs}ms`);
}

export async function withPortForward<T>(
  env: string,
  namespace: string,
  service: string,
  remotePort: number,
  fn: (localPort: number) => Promise<T>,
): Promise<T> {
  const ctx = resolveContext(env);
  const localPort = await getFreePort();

  const pf = spawn("kubectl", [
    "port-forward",
    "--context", ctx,
    "-n", namespace,
    `svc/${service}`,
    `${localPort}:${remotePort}`,
  ], { stdio: ["ignore", "pipe", "pipe"] });

  pf.on("error", () => {}); // prevent unhandled ENOENT if kubectl is missing

  const cleanup = () => { if (!pf.killed) pf.kill(); };
  process.on("exit", cleanup);
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  try {
    await waitReady(localPort);
    return await fn(localPort);
  } finally {
    cleanup();
    process.off("exit", cleanup);
    process.off("SIGINT", cleanup);
    process.off("SIGTERM", cleanup);
  }
}

export function kubectlJson(args: string[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    const p = spawn("kubectl", [...args, "-o", "json"], { stdio: ["ignore", "pipe", "pipe"] });
    p.stdout.on("data", (d: Buffer) => chunks.push(d));
    p.stderr.on("data", (d: Buffer) => errChunks.push(d));
    p.on("close", (code) => {
      if (code !== 0) {
        const stderr = Buffer.concat(errChunks).toString().trim();
        return reject(new Error(`kubectl ${args.join(" ")} exited ${code}: ${stderr}`));
      }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch (e) { reject(e); }
    });
  });
}