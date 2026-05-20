// aspire-lib — shared helpers for the aspire skill's bundled scripts.
//
// Pure logic; the only I/O is the `aspire` subprocess invocation and the
// AppHost auto-discovery flow it powers. Three scripts use this:
//   - trace-inspect.ts (traces + resource state)
//   - aspire-logs.ts   (OTel structured logs)
//   - aspire-db.ts     (read-only SQL against postgres resources)
//
// Everything is exported; import what you need. Imports must include the
// explicit `.ts` extension when loaded via `node --experimental-strip-types`.

import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";

export const ANSI = /\x1b\[[0-9;]*[a-zA-Z]/g;

export type Attrs = Record<string, string>;
export type Resource = {
    name: string;
    resourceType: string;
    state: string;
    healthStatus?: string;
    urls?: Array<{ url: string }>;
    properties?: Record<string, unknown>;
};

export function runAspire(args: string[]): string {
    const result = spawnSync("aspire", [...args, "--non-interactive", "--nologo"], {
        encoding: "utf8",
        maxBuffer: 128 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status !== 0) {
        const err = (result.stderr ?? "").replace(ANSI, "").trim();
        throw new Error(`aspire ${args.join(" ")} exited with ${result.status}\n${err}`);
    }
    return result.stdout.replace(ANSI, "");
}

// Strip the aspire CLI's pre/post banner lines and parse the embedded JSON
// by counting brackets (ignoring quoted strings). `JSON.parse` on the raw
// stdout fails because of the banner + footer + ANSI residue.
export function parseJsonOutput<T>(raw: string): T {
    const start = raw.search(/[\[{]/);
    if (start < 0) throw new Error("aspire produced no JSON");
    const open = raw[start];
    const close = open === "[" ? "]" : "}";
    let depth = 0;
    let inStr = false;
    let escape = false;
    for (let i = start; i < raw.length; i++) {
        const c = raw[i];
        if (inStr) {
            if (escape) escape = false;
            else if (c === "\\") escape = true;
            else if (c === '"') inStr = false;
        } else {
            if (c === '"') inStr = true;
            else if (c === open) depth++;
            else if (c === close) {
                depth--;
                if (depth === 0) return JSON.parse(raw.slice(start, i + 1)) as T;
            }
        }
    }
    throw new Error("aspire output had unterminated JSON");
}

export function aspireJson<T>(args: string[]): T {
    return parseJsonOutput<T>(runAspire([...args, "--format", "Json"]));
}

// Auto-discover the AppHost path. If --apphost was passed, use it. Otherwise
// query `aspire ps` for running AppHosts and use the single one. The aspire
// CLI's CWD-based detection is unreliable in agent environments (`cd && aspire`
// breaks the permission allow-list), so the helpers take responsibility here.
export function resolveApphost(explicit: string | undefined): string {
    if (explicit) return explicit;
    let apphosts: Array<{ appHostPath: string }>;
    try {
        apphosts = aspireJson<Array<{ appHostPath: string }>>(["ps"]);
    } catch (e) {
        throw new Error(
            "Could not run `aspire ps` to auto-discover the AppHost. " +
                "Pass --apphost <path> explicitly. Underlying error: " +
                (e instanceof Error ? e.message : String(e))
        );
    }
    if (apphosts.length === 1) return apphosts[0].appHostPath;
    if (apphosts.length === 0) {
        throw new Error(
            "No AppHost is running. Start one with `aspire start --apphost <path>` first."
        );
    }
    const paths = apphosts.map((a) => `  ${a.appHostPath}`).join("\n");
    throw new Error(
        `Multiple AppHosts are running. Pass --apphost <path> to choose one of:\n${paths}`
    );
}

type Spec = Record<string, "string" | "bool" | "array">;
type Values<S extends Spec> = {
    [K in keyof S]?: S[K] extends "bool" ? boolean : S[K] extends "array" ? string[] : string;
};

// Thin wrapper over `node:util.parseArgs` so each command can declare its flag
// shape in one terse object instead of node:util's nested options.
export function parseFlags<S extends Spec>(argv: string[], spec: S): { values: Values<S>; positionals: string[] } {
    const options: Record<string, { type: "string" | "boolean"; multiple?: boolean }> = {};
    for (const [k, v] of Object.entries(spec)) {
        if (v === "bool") options[k] = { type: "boolean" };
        else if (v === "array") options[k] = { type: "string", multiple: true };
        else options[k] = { type: "string" };
    }
    const { values, positionals } = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
    return { values: values as Values<S>, positionals };
}
