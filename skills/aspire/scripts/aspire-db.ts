#!/usr/bin/env -S node --experimental-strip-types
// aspire-db — bundled with the aspire skill.
//
// Runs read-only SQL (SELECT / EXPLAIN / SHOW / WITH-SELECT / VALUES / TABLE)
// against a postgres database resource inside a locally-running Aspire AppHost.
// Uses the static dev credentials postgres/root by convention — does NOT
// extract auto-generated passwords via `aspire mcp call ... GetConnectionString`.
//
// Write/DDL/session-state keywords are refused (regex-based, not a full parser).
//
// Server endpoint is discovered by looking up the named PostgresDatabaseResource
// in `aspire describe`, then following its `resource.parentName` to the parent
// server's `tcp://` URL.

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { aspireJson, resolveApphost, parseFlags, type Resource } from "./aspire-lib.ts";

const POSTGRES_DB_RESOURCE_TYPE = "PostgresDatabaseResource";

const WRITE_KEYWORDS = [
    "INSERT", "UPDATE", "DELETE", "DROP", "CREATE", "ALTER", "TRUNCATE", "INTO",
    "GRANT", "REVOKE", "COPY", "VACUUM", "REINDEX", "MERGE", "CALL", "DO",
    "LOCK", "REFRESH", "CLUSTER", "COMMENT", "SET", "RESET",
    "BEGIN", "START", "COMMIT", "END", "ROLLBACK", "SAVEPOINT", "RELEASE",
    "DECLARE", "FETCH", "PREPARE", "EXECUTE", "DEALLOCATE",
    "NOTIFY", "LISTEN", "UNLISTEN", "IMPORT", "SECURITY",
];
const WRITE_RE = new RegExp("\\b(" + WRITE_KEYWORDS.join("|") + ")\\b", "i");

type Endpoint = { host: string; port: number; dbname: string; serverName: string };

// Scan the AppHost project directory for `.AddDatabase("aspire-name", "real-name")`
// patterns to build the Aspire-resource → real-postgres-database mapping.
// The second arg is the real DB name on the server, or the resource name itself
// if omitted.
function parseAppHostDbMap(apphostCsproj: string): Map<string, string> {
    const map = new Map<string, string>();
    const re = /\.AddDatabase\s*\(\s*"([^"]+)"(?:\s*,\s*(?:databaseName\s*:\s*)?"([^"]+)")?/g;
    const skipDirs = new Set(["bin", "obj", "node_modules"]);

    function walk(d: string): void {
        let entries;
        try {
            entries = readdirSync(d, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of entries) {
            if (e.name.startsWith(".")) continue;
            if (e.isDirectory()) {
                if (skipDirs.has(e.name)) continue;
                walk(join(d, e.name));
            } else if (e.isFile() && e.name.endsWith(".cs")) {
                const p = join(d, e.name);
                let src;
                try {
                    src = readFileSync(p, "utf8");
                } catch {
                    continue;
                }
                for (const m of src.matchAll(re)) {
                    const aspireName = m[1];
                    const realName = m[2] ?? aspireName;
                    if (!map.has(aspireName)) map.set(aspireName, realName);
                }
            }
        }
    }

    walk(dirname(apphostCsproj));
    return map;
}

function findEndpoint(apphost: string, aspireDbName: string, dbnameOverride: string | undefined): Endpoint {
    const data = aspireJson<{ resources: Resource[] }>(["describe", "--apphost", apphost]);

    const db = data.resources.find((r) => r.name === aspireDbName);
    if (!db) {
        const dbs = data.resources
            .filter((r) => r.resourceType === POSTGRES_DB_RESOURCE_TYPE)
            .map((r) => "  " + r.name);
        throw new Error(
            `No database resource named "${aspireDbName}". ` +
                `Available PostgresDatabaseResource entries:\n` +
                (dbs.length ? dbs.join("\n") : "  (none — no postgres databases declared)")
        );
    }
    if (db.resourceType !== POSTGRES_DB_RESOURCE_TYPE) {
        throw new Error(
            `Resource "${aspireDbName}" is type ${db.resourceType}, not a PostgresDatabaseResource. ` +
                `aspire-db only supports postgres databases.`
        );
    }

    const parentName = db.properties?.["resource.parentName"] as string | undefined;
    if (!parentName) {
        throw new Error(`Database resource "${aspireDbName}" has no resource.parentName — cannot locate its server.`);
    }
    const server = data.resources.find((r) => r.name === parentName);
    if (!server) throw new Error(`Parent server "${parentName}" not found in the AppHost.`);
    const tcpUrl = server.urls?.find((u) => u.url.startsWith("tcp://"))?.url;
    if (!tcpUrl) throw new Error(`Parent server "${parentName}" has no tcp:// URL.`);
    const match = tcpUrl.match(/^tcp:\/\/([^:/]+):(\d+)/);
    if (!match) throw new Error(`Could not parse host:port from "${tcpUrl}"`);

    const dbMap = parseAppHostDbMap(apphost);
    const realName = dbnameOverride ?? dbMap.get(aspireDbName) ?? aspireDbName;

    return {
        host: match[1],
        port: Number(match[2]),
        dbname: realName,
        serverName: parentName,
    };
}

function runPsql(host: string, port: number, db: string, sql: string, extraArgs: string[] = []): SpawnSyncReturns<string> {
    return spawnSync(
        "psql",
        ["-h", host, "-p", String(port), "-U", "postgres", "-d", db, "-w", "-X", ...extraArgs, "-c", sql],
        {
            encoding: "utf8",
            maxBuffer: 128 * 1024 * 1024,
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, PGPASSWORD: "root" },
        }
    );
}

function listRealDatabases(host: string, port: number): string[] {
    const result = runPsql(
        host, port, "postgres",
        "SELECT datname FROM pg_database WHERE datistemplate = false AND datname <> 'postgres' ORDER BY datname",
        ["-A", "-t"]
    );
    if (result.status !== 0) return [];
    return result.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

function validateReadOnly(sql: string): void {
    const hit = sql.match(WRITE_RE);
    if (hit) {
        throw new Error(
            `Refused: SQL contains write/state keyword "${hit[1]}". ` +
                `aspire-db is SELECT-only by policy. ` +
                `If the keyword appears inside a string literal, rephrase — the guard is regex-based, not a parser.`
        );
    }
}

const usage = `aspire-db — run read-only SQL against a local-dev postgres database in a running Aspire stack.

usage:
  aspire-db.ts <database-resource> "<sql>" [options]

arguments:
  <database-resource>  Aspire resource name (e.g. agent-data-db, auth-db).
                       Must be a PostgresDatabaseResource in the running AppHost.
  <sql>                A read-only SQL statement. Write/DDL/session-state keywords
                       are refused; see below.

options:
  --apphost <path>     AppHost path. Auto-discovered via "aspire ps" if omitted
                       (errors out if 0 or 2+ AppHosts are running).
  --dbname <real>      Escape hatch: real postgres database name on the server.
                       Normally not needed — the helper auto-resolves the real
                       name by scanning the AppHost project's *.cs files for
                       '.AddDatabase("aspire-name", "real-name")' patterns.
                       Pass this only when the AppHost defines the database
                       dynamically (variable args) so the regex misses it.
                       On a "database does not exist" failure, the helper
                       auto-lists the real DBs on the parent server.
  --tsv                Tab-separated, no headers/footer (good for piping to
                       jq -R, awk, etc.). Default: aligned psql output.

read-only enforcement:
  Any of these keywords (case-insensitive, word-boundary match) cause refusal:
  INSERT UPDATE DELETE DROP CREATE ALTER TRUNCATE INTO GRANT REVOKE COPY
  VACUUM REINDEX MERGE CALL DO LOCK REFRESH CLUSTER COMMENT SET RESET
  BEGIN START COMMIT END ROLLBACK SAVEPOINT RELEASE DECLARE FETCH PREPARE
  EXECUTE DEALLOCATE NOTIFY LISTEN UNLISTEN IMPORT SECURITY

  Multi-statement input (semicolon-separated) is scanned as one string —
  if any segment contains a refused keyword, the whole call is rejected.

credentials:
  Static dev credentials postgres/root are used by convention for the local
  Aspire stack. Do NOT use "aspire mcp call <postgres> PostgreSQLGetConnectionString"
  to extract auto-generated passwords — that path is explicitly off-limits.
  The password is passed via PGPASSWORD; the connection URI is never built on
  the command line, so it does not appear in argv / ps output.

examples:
  aspire-db.ts <db-resource> "SELECT count(*) FROM <table>"
  aspire-db.ts <db-resource> "SELECT * FROM <table> ORDER BY id DESC LIMIT 10" --tsv
  aspire-db.ts <db-resource> "EXPLAIN ANALYZE SELECT * FROM <table> WHERE col = 'x'"
  aspire-db.ts <db-resource> "SHOW server_version"

  (The <db-resource> placeholder is the Aspire resource name you see in
   "aspire describe" output, e.g. the name of any PostgresDatabaseResource
   in the currently running AppHost.)
`;

function main(): void {
    const argv = process.argv.slice(2);
    if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
        process.stdout.write(usage);
        process.exit(argv.length === 0 ? 1 : 0);
    }

    const { values, positionals } = parseFlags(argv, {
        apphost: "string",
        dbname: "string",
        tsv: "bool",
    });

    const [aspireDbName, sql] = positionals;
    if (!aspireDbName || !sql) {
        process.stderr.write("aspire-db: missing <database-resource> or <sql>. Run --help.\n");
        process.exit(1);
    }

    validateReadOnly(sql);

    const apphost = resolveApphost(values.apphost);
    const ep = findEndpoint(apphost, aspireDbName, values.dbname);

    const extraArgs = values.tsv ? ["-A", "-F", "\t", "-t"] : [];
    const result = runPsql(ep.host, ep.port, ep.dbname, sql, extraArgs);

    if (result.error) {
        if ((result.error as NodeJS.ErrnoException).code === "ENOENT") {
            process.stderr.write("psql not found on PATH. Install the postgres client (e.g. `brew install libpq && brew link --force libpq`).\n");
            process.exit(127);
        }
        throw result.error;
    }
    process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);

    if (result.status !== 0 && /database ".*" does not exist/.test(result.stderr ?? "")) {
        const real = listRealDatabases(ep.host, ep.port);
        if (real.length) {
            process.stderr.write(
                `\nAspire resource names can differ from real postgres DB names. ` +
                    `Real databases on server "${ep.serverName}":\n` +
                    real.map((d) => "  " + d).join("\n") +
                    `\nRetry with --dbname <real-name>.\n`
            );
        }
    }
    process.exit(result.status ?? 0);
}

try {
    main();
} catch (e) {
    process.stderr.write((e instanceof Error ? e.message : String(e)) + "\n");
    process.exit(1);
}
