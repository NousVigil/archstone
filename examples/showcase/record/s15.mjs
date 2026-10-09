// S-15: "How many bookings per city this month?" - a report from the agency's own database.
//
// The SQL provider is Node-only and opens a database connection, so this capability is NOT part of
// what the public Worker serves. Its manifest lives in ../local/reporting, outside ../manifest, and
// this scenario shows both halves: the table (from a real Postgres built from that manifest's own
// fixture.sql, read through the runtime as a caller whose identity is mapped to one tenant) and the
// absence (the live manifest has no sql capability, so its tool list has none either).
//
// Needs a Postgres admin URL in ARCHSTONE_TEST_PG_URL. Without it the recorder skips this scenario
// locally with a message, and fails under CI. The admin URL only builds and drops the throwaway
// database; the CLI and the runtime are given the runtime role's DSN, as a deployment would.
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildRegistry, callTool, toolDefinitions } from "@archstone/runtime";
import { invokeConnector } from "@archstone/runtime/connector";
import { MANIFEST_DIR, REPO_ROOT, SHOWCASE_DIR } from "./lib.mjs";

export const meta = { id: "S-15", file: "s-15.json", kind: "mcp", title: "How many bookings per city this month? (sql, local only)" };

const LOCAL = "examples/showcase/local/reporting";
const PG_VAR = "ARCHSTONE_TEST_PG_URL";

export function skipReason(env) {
  return env[PG_VAR] ? undefined : `${PG_VAR} is not set (S-15 needs a local Postgres admin URL; see examples/showcase/README.md).`;
}

/** The repository's shared helper that builds a throwaway database from a fixture script (the release
 *  gate and the Postgres test suites use the same one). Imported by path from the repo root. */
async function loadDatabaseHelper() {
  return import(pathToFileURL(join(REPO_ROOT, "scripts/lib/script-database.mjs")).href);
}

async function loadPg() {
  const resolved = createRequire(join(REPO_ROOT, "providers/sql/package.json")).resolve("pg");
  const mod = await import(pathToFileURL(resolved).href);
  return mod.default ?? mod;
}

const filesUnder = (dir) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath ?? e.path, e.name));

export async function run(ctx) {
  const identityMap = JSON.parse(readFileSync(join(REPO_ROOT, LOCAL, "identity-map.json"), "utf8"));
  const pg = await loadPg();
  const { createScriptDatabase } = await loadDatabaseHelper();
  const db = await createScriptDatabase({ pg, adminUrl: process.env[PG_VAR], sql: readFileSync(join(REPO_ROOT, LOCAL, "fixture.sql"), "utf8") });
  ctx.onEnd(() => db.teardown());
  const env = { REPORTING_DSN: db.dsn };

  // 1. the manifest, offline, then the CLI's own isolation check against the real database
  const applied = await ctx.cli(["apply", LOCAL]);
  ctx.check("`apply` compiles the local reporting manifest offline (exit 0)", applied.exit === 0);
  const verify = await ctx.cli(["verify", LOCAL, "--identity-map", `${LOCAL}/identity-map.json`], { env });
  ctx.check("`verify` exits 0: the recorded contract holds", verify.exit === 0 && /🟢 wanderlust\.bookings-by-city — fingerprint unchanged/.test(verify.stdout));
  const golden = JSON.parse(readFileSync(join(REPO_ROOT, LOCAL, "fixtures/wanderlust.bookings-by-city.golden.json"), "utf8"));
  ctx.check(
    "`verify` replays the request as another tenant (the fixture names one) and is green only because that replay returned zero rows",
    golden.negativeIdentity?.principal === "demo:outsider" && verify.exit === 0,
    { negative: true },
  );

  // 2. the table, through the runtime's tool-call path, as the mapped analyst
  const built = buildRegistry(join(REPO_ROOT, LOCAL));
  ctx.check("the local manifest builds a registry with one tool", Boolean(built.registry) && toolDefinitions(built.registry).map((t) => t.name).join() === "wanderlust_bookings-by-city");
  const connectionRegistry = new Map();
  ctx.onEnd(async () => {
    // End the pools before the database is dropped, and let the sockets close: dropping a database
    // under a live connection makes the provider log an "idle connection failed" line.
    for (const entry of connectionRegistry.values()) await entry.pool.end().catch(() => undefined);
    await new Promise((done) => setTimeout(done, 100));
  });
  const asPrincipal = (principal) =>
    callTool(built.registry, "wanderlust_bookings-by-city", { month: "2027-05" }, {
      env,
      connector: invokeConnector,
      connectionRegistry,
      identityAdapter: (p) => identityMap[p],
      caller: { principal },
    });

  const analyst = await asPrincipal("demo:analyst");
  ctx.callStep("wanderlust_bookings-by-city", { month: "2027-05" }, { as: "demo:analyst", isError: analyst.isError, structuredContent: analyst.structuredContent });
  const rows = analyst.structuredContent?.cities ?? [];
  ctx.check(
    "the analyst gets a table of bookings per city for the month: Lisbon 5, Porto 3, Seville 2",
    analyst.isError === false && JSON.stringify(rows) === JSON.stringify([{ city: "Lisbon", bookings: 5 }, { city: "Porto", bookings: 3 }, { city: "Seville", bookings: 2 }]),
  );
  ctx.check("the table has exactly the declared columns, city and bookings (the guest passport column is not in the view)", rows.every((r) => Object.keys(r).sort().join() === "bookings,city"), { negative: true });

  const outsider = await asPrincipal("demo:outsider");
  ctx.callStep("wanderlust_bookings-by-city", { month: "2027-05" }, { as: "demo:outsider", isError: outsider.isError, structuredContent: outsider.structuredContent });
  ctx.check("another agency's analyst asking the same question gets no rows: the database's row-level security answers, not the binding", outsider.isError === false && (outsider.structuredContent?.cities ?? []).length === 0, { negative: true });

  const nobody = await callTool(built.registry, "wanderlust_bookings-by-city", { month: "2027-05" }, { env, connector: invokeConnector, connectionRegistry, identityAdapter: (p) => identityMap[p] });
  ctx.callStep("wanderlust_bookings-by-city", { month: "2027-05" }, { as: "(no caller)", isError: nobody.isError });
  ctx.check("a call with no caller identity is refused, not answered", nobody.isError === true, { negative: true });

  // 3. what the public Worker serves has no sql capability (N-15)
  const live = buildRegistry(MANIFEST_DIR);
  const liveTools = toolDefinitions(live.registry).map((t) => t.name);
  ctx.check("the live manifest's tool list has no bookings-by-city tool", !liveTools.some((n) => /bookings-by-city/.test(n)), { negative: true });
  ctx.check("no capability in the live manifest is bound to sql", live.registry.ir.tools.every((t) => t.connector?.type !== "sql"), { negative: true });
  ctx.check("no file under the live manifest declares a sql connector", filesUnder(MANIFEST_DIR).every((f) => !/^\s*type:\s*["']?sql["']?\s*$/m.test(readFileSync(f, "utf8"))), { negative: true });
  ctx.check("the reporting manifest lives outside the live one", !join(SHOWCASE_DIR, "local", "reporting").startsWith(MANIFEST_DIR));
}
