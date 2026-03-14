/**
 * Shared HTTP and stdin utilities for infra scripts.
 */

export async function apiGet(
  baseUrl: string,
  path: string,
  params: Record<string, string | number> = {},
  headers: Record<string, string> = {},
): Promise<unknown> {
  const url = new URL(path, baseUrl);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url.toString(), Object.keys(headers).length ? { headers } : undefined);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

export async function readStdinJson(): Promise<Record<string, unknown>> {
  const raw = await new Promise<string>((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d: string) => (buf += d));
    process.stdin.on("end", () => resolve(buf.trim()));
  });
  if (!raw) {
    console.error("ERROR: No query on stdin.");
    process.exit(1);
  }
  try {
    return JSON.parse(raw);
  } catch {
    console.error("ERROR: Invalid JSON");
    process.exit(1);
  }
}